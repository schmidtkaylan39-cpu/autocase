import http from "node:http";
import { createHash } from "node:crypto";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  confirmIntake,
  createRunHandoffs,
  initProject,
  intakeRequest,
  planProject,
  reportProjectRun,
  reviseIntake,
  runProject,
  validateSpec
} from "./commands.mjs";
import { runAutonomousLoop } from "./autonomous-run.mjs";
import { dispatchHandoffs } from "./dispatch.mjs";
import { runRuntimeDoctor } from "./doctor.mjs";
import { readJson } from "./fs-utils.mjs";
import { clarifyIntakeRequest } from "./intake-clarifier.mjs";
import { assessIntakePlanningReadiness, loadIntakeArtifacts, writeIntakeArtifacts } from "./intake-state.mjs";
import { writeQuickStartProjectSpec } from "./quick-start-spec.mjs";
import { summarizeRunState } from "./run-state.mjs";

const DEFAULT_PANEL_HOST = "127.0.0.1";
const DEFAULT_PANEL_PORT = 4310;
const MAX_REQUEST_BYTES = 1_000_000;
const DEFAULT_PANEL_REQUEST_TEXT = [
  "Start: Local workspace contains sales.json and artifacts/reports is writable.",
  "End point: Create artifacts/reports/summary.md from local sales.json without changing sales.json.",
  "Success criteria: artifacts/reports/summary.md exists; summary.md includes daily totals; summary.md includes anomaly notes; summary.md stays inside the local workspace.",
  "Input source: sales.json.",
  "Out of scope: do not modify sales.json; do not send email; do not call external APIs."
].join("\n");
const QUICK_START_CONFIRMATION_TOKEN_SAFE = "我確認起點與終點";

const quickStartContractFields = [
  {
    key: "startPoint",
    label: "起點",
    example: "起點: 目前有哪些檔案、資料或系統狀態",
    patterns: [/^\s*(?:起點|開始點|开始点|start(?:ing)? point|start)\s*[:：]\s*(.+)$/im]
  },
  {
    key: "endPoint",
    label: "終點",
    example: "終點: 完成後要交付什麼結果",
    patterns: [/^\s*(?:終點|终点|end point|target outcome|goal)\s*[:：]\s*(.+)$/im]
  },
  {
    key: "successCriteria",
    label: "成功指標",
    example: "成功指標: 可量測或可驗收的條件",
    patterns: [
      /^\s*(?:成功指標|成功指标|驗收標準|验收标准|acceptance criteria|success criteria)\s*[:：]\s*(.+)$/im
    ],
    split: true
  },
  {
    key: "inputSource",
    label: "輸入來源",
    example: "輸入來源: 會使用哪些檔案、資料表或 API",
    patterns: [/^\s*(?:輸入來源|输入来源|資料來源|数据来源|input source|inputs?)\s*[:：]\s*(.+)$/im],
    split: true
  },
  {
    key: "outOfScope",
    label: "非範圍",
    example: "非範圍: 這一輪明確不做哪些事",
    patterns: [/^\s*(?:非範圍|范围外|out of scope|not in scope)\s*[:：]\s*(.+)$/im],
    split: true
  }
];
const QUICK_START_CONFIRMATION_TOKEN = "我確認起點與終點";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveWithinWorkspace(workspaceRoot, value, fallbackPath) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallbackPath;
  }

  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
}

async function listRunStateCandidates(runsDirectory) {
  let entries;
  try {
    entries = await readdir(runsDirectory, {
      withFileTypes: true
    });
  } catch {
    return [];
  }

  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runStatePath = path.join(runsDirectory, entry.name, "run-state.json");

    try {
      const details = await stat(runStatePath);
      candidates.push({
        runStatePath,
        mtimeMs: details.mtimeMs
      });
    } catch {
      // Ignore directories without run-state.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates;
}

async function findLatestRunStatePath(workspaceRoot) {
  const runsDirectory = path.join(workspaceRoot, "runs");
  const [latest] = await listRunStateCandidates(runsDirectory);
  return latest?.runStatePath ?? null;
}

async function collectHandoffDirectories(runStatePath) {
  const runDirectory = path.dirname(runStatePath);
  const candidateDirectories = new Set([
    path.join(runDirectory, "handoffs"),
    path.join(runDirectory, "handoffs-autonomous")
  ]);
  const runState = await readJson(runStatePath).catch(() => null);

  for (const task of runState?.taskLedger ?? []) {
    if (typeof task.activeHandoffOutputDir === "string" && task.activeHandoffOutputDir.trim().length > 0) {
      candidateDirectories.add(path.resolve(task.activeHandoffOutputDir));
    }
  }

  return [...candidateDirectories];
}

async function resolveDefaultHandoffIndexPath(runStatePath) {
  const directories = await collectHandoffDirectories(runStatePath);

  for (const directoryPath of directories) {
    const indexPath = path.join(directoryPath, "index.json");

    if (await pathExists(indexPath)) {
      return indexPath;
    }
  }

  throw new Error(`No handoff index was found for ${runStatePath}. Generate handoffs before dispatching.`);
}

async function findLatestDispatchResultsPath(runStatePath) {
  const directories = await collectHandoffDirectories(runStatePath);
  const candidates = [];

  for (const directoryPath of directories) {
    const dispatchResultsPath = path.join(directoryPath, "dispatch-results.json");

    try {
      const details = await stat(dispatchResultsPath);
      candidates.push({
        dispatchResultsPath,
        mtimeMs: details.mtimeMs
      });
    } catch {
      // Ignore missing dispatch-results.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.dispatchResultsPath ?? null;
}

function getDefaultPaths(workspaceRoot) {
  return {
    specPath: path.join(workspaceRoot, "specs", "project-spec.json"),
    runsDir: path.join(workspaceRoot, "runs"),
    reportsDir: path.join(workspaceRoot, "reports")
  };
}

function summarizeWaitingRetryTasks(runState) {
  const waitingRetryTasks = Array.isArray(runState?.taskLedger)
    ? runState.taskLedger.filter((task) => task?.status === "waiting_retry")
    : [];
  const scheduledRetries = waitingRetryTasks
    .map((task) => {
      const nextRetryAt =
        typeof task?.nextRetryAt === "string" && task.nextRetryAt.trim().length > 0
          ? task.nextRetryAt.trim()
          : null;
      const nextRetryAtMs = nextRetryAt ? Date.parse(nextRetryAt) : Number.NaN;

      return {
        taskId: typeof task?.id === "string" ? task.id : null,
        nextRetryAt,
        nextRetryAtMs
      };
    })
    .filter((task) => Number.isFinite(task.nextRetryAtMs))
    .sort((left, right) => left.nextRetryAtMs - right.nextRetryAtMs);
  const earliestRetry = scheduledRetries[0] ?? null;

  return {
    taskIds: waitingRetryTasks
      .map((task) => (typeof task?.id === "string" ? task.id : null))
      .filter((taskId) => nonEmptyText(taskId)),
    earliestNextRetryAt: earliestRetry?.nextRetryAt ?? null,
    scheduledTaskIds: scheduledRetries
      .map((task) => task.taskId)
      .filter((taskId) => nonEmptyText(taskId))
  };
}

async function loadAutonomousDebugSnapshot(runDirectory) {
  const debugDirectory = path.join(runDirectory, "artifacts", "autonomous-debug");
  const terminalSummaryPath = path.join(debugDirectory, "terminal-summary.json");
  const checkpointPath = path.join(debugDirectory, "checkpoint.json");
  const hypothesisLedgerPath = path.join(debugDirectory, "hypothesis-ledger.json");
  const debugBundlePath = path.join(debugDirectory, "debug-bundle.json");

  return {
    terminalSummaryPath: (await pathExists(terminalSummaryPath)) ? terminalSummaryPath : null,
    checkpointPath: (await pathExists(checkpointPath)) ? checkpointPath : null,
    hypothesisLedgerPath: (await pathExists(hypothesisLedgerPath)) ? hypothesisLedgerPath : null,
    debugBundlePath: (await pathExists(debugBundlePath)) ? debugBundlePath : null,
    terminalSummary: (await pathExists(terminalSummaryPath)) ? await readJson(terminalSummaryPath).catch(() => null) : null,
    checkpoint: (await pathExists(checkpointPath)) ? await readJson(checkpointPath).catch(() => null) : null
  };
}

export function normalizePanelPort(portInput, fallbackPort = DEFAULT_PANEL_PORT) {
  if (portInput === undefined || portInput === null || String(portInput).trim().length === 0) {
    return fallbackPort;
  }

  const parsedPort = Number.parseInt(String(portInput), 10);

  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error(`Invalid panel port: ${portInput}`);
  }

  return parsedPort;
}

export function resolvePanelWorkspace(workspaceDir = ".") {
  return path.resolve(workspaceDir);
}

async function buildWorkspaceOverview(workspaceRoot) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const defaults = getDefaultPaths(normalizedWorkspaceRoot);
  const intake = await loadIntakeArtifacts(normalizedWorkspaceRoot).catch(() => ({
    exists: false,
    artifactPaths: null,
    spec: null
  }));
  const latestRunStatePath = await findLatestRunStatePath(normalizedWorkspaceRoot);
  let latestRun = null;

  if (latestRunStatePath) {
    const runState = await readJson(latestRunStatePath).catch(() => null);

    if (runState) {
      const runDirectory = path.dirname(latestRunStatePath);
      const reportPath = path.join(runDirectory, "report.md");
      const defaultHandoffIndexPath = await resolveDefaultHandoffIndexPath(latestRunStatePath).catch(() => null);
      const autonomousDebug = await loadAutonomousDebugSnapshot(runDirectory);

      latestRun = {
        runDirectory,
        runStatePath: latestRunStatePath,
        reportPath,
        handoffIndexPath: defaultHandoffIndexPath,
        summary: summarizeRunState(runState),
        waitingRetry: summarizeWaitingRetryTasks(runState),
        autonomousDebug
      };
    }
  }

  return {
    workspaceRoot: normalizedWorkspaceRoot,
    defaults,
    intake: {
      exists: intake.exists,
      clarificationStatus: intake.spec?.clarificationStatus ?? null,
      confirmedByUser: intake.spec?.confirmedByUser ?? null,
      recommendedNextStep: intake.spec?.recommendedNextStep ?? null,
      intakeSpecPath: intake.artifactPaths?.intakeSpecPath ?? null,
      intakeSummaryPath: intake.artifactPaths?.intakeSummaryPath ?? null
    },
    latestRun
  };
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function summarizeStructuredItems(items, renderItem) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      try {
        return renderItem(item);
      } catch {
        return null;
      }
    })
    .filter((item) => nonEmptyText(item));
}

function extractContractFieldValue(requestText, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(requestText);

    if (match && nonEmptyText(match[1])) {
      return match[1].trim();
    }
  }

  return "";
}

function splitContractItems(rawValue) {
  if (!nonEmptyText(rawValue)) {
    return [];
  }

  return rawValue
    .split(/[|,;；，]/g)
    .map((item) => item.trim())
    .filter((item) => nonEmptyText(item));
}

function dedupeTextList(items) {
  const seen = new Set();
  const results = [];

  for (const item of items ?? []) {
    const normalized = nonEmptyText(item) ? item.trim() : "";

    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(normalized);
  }

  return results;
}

function buildOutOfScopePolicy(outOfScopeValues) {
  const normalizedValues = dedupeTextList(outOfScopeValues).map((item) => item.toLowerCase());
  const matchesAny = (patterns) =>
    normalizedValues.some((value) => patterns.some((pattern) => pattern.test(value)));
  const disallowEmail = matchesAny([
    /\bdo not send email\b/,
    /\bdon't send email\b/,
    /\bno email\b/,
    /不寄信/,
    /不要寄信/,
    /不要发送邮件/,
    /不要發送郵件/
  ]);
  const disallowExternalApi = matchesAny([
    /\bdo not call external apis?\b/,
    /\bdon't call external apis?\b/,
    /\bno external apis?\b/,
    /\bno webhooks?\b/,
    /不要呼叫外部 api/,
    /不要调用外部 api/
  ]);
  const disallowNotifications = matchesAny([
    /\bdo not send notifications?\b/,
    /\bno notifications?\b/,
    /不要發通知/,
    /不要发送通知/
  ]);

  return {
    disallowEmail,
    disallowExternalApi,
    disallowOutbound: disallowEmail || disallowExternalApi || disallowNotifications
  };
}

function textMatchesOutOfScopePolicy(value, outOfScopePolicy) {
  const normalizedValue = String(value ?? "").toLowerCase();

  if (!normalizedValue) {
    return false;
  }

  if (
    outOfScopePolicy.disallowEmail &&
    (/\bemail\b/.test(normalizedValue) || normalizedValue.includes("郵件") || normalizedValue.includes("邮件"))
  ) {
    return true;
  }

  if (
    outOfScopePolicy.disallowExternalApi &&
    (/\bapi\b/.test(normalizedValue) || normalizedValue.includes("webhook"))
  ) {
    return true;
  }

  if (
    outOfScopePolicy.disallowOutbound &&
    (normalizedValue.includes("outbound") ||
      normalizedValue.includes("public-facing") ||
      normalizedValue.includes("public facing") ||
      normalizedValue.includes("notification") ||
      normalizedValue.includes("通知"))
  ) {
    return true;
  }

  return false;
}

function filterStringArrayForOutOfScope(values, outOfScopePolicy) {
  return dedupeTextList(values).filter((item) => !textMatchesOutOfScopePolicy(item, outOfScopePolicy));
}

function filterStructuredArrayForOutOfScope(items, outOfScopePolicy, toText) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.filter((item) => !textMatchesOutOfScopePolicy(toText(item), outOfScopePolicy));
}

function parseQuickStartExecutionContract(requestText) {
  const normalizedRequest = typeof requestText === "string" ? requestText.trim() : "";
  const requestForMatching = normalizedRequest.replace(
    /\s+(?=(?:起點|開始點|开始点|start(?:ing)? point|start|終點|终点|end point|target outcome|goal|成功指標|成功指标|驗收標準|验收标准|acceptance criteria|success criteria|輸入來源|输入来源|資料來源|数据来源|input source|inputs?|非範圍|范围外|out of scope|not in scope)\s*[:：])/gi,
    "\n"
  );
  const fields = {};
  const missingDefinitions = [];

  for (const fieldDefinition of quickStartContractFields) {
    const rawValue = extractContractFieldValue(requestForMatching, fieldDefinition.patterns);
    const values = fieldDefinition.split ? splitContractItems(rawValue) : [];
    const defined = fieldDefinition.split ? values.length > 0 : nonEmptyText(rawValue);

    fields[fieldDefinition.key] = {
      key: fieldDefinition.key,
      label: fieldDefinition.label,
      status: defined ? "defined" : "missing",
      value: defined ? (fieldDefinition.split ? values.join("; ") : rawValue) : "",
      values
    };

    if (!defined) {
      missingDefinitions.push(fieldDefinition);
    }
  }

  return {
    complete: missingDefinitions.length === 0,
    fields,
    missingFields: missingDefinitions.map((item) => item.key),
    missingFieldReasons: missingDefinitions.map((item) => `Execution contract is missing: ${item.label}.`),
    template: quickStartContractFields.map((item) => item.example)
  };
}

function buildPreviewDigest(requestText) {
  return createHash("sha256").update(String(requestText ?? ""), "utf8").digest("hex");
}

function applyExecutionContractToIntakeSpec(spec, executionContract, now = new Date()) {
  if (!spec || typeof spec !== "object") {
    return spec;
  }

  const goalValue = contractValue(executionContract, "endPoint");
  const inputValues = contractValues(executionContract, "inputSource");
  const successValues = contractValues(executionContract, "successCriteria");
  const outOfScopeValues = contractValues(executionContract, "outOfScope");
  const outOfScopePolicy = buildOutOfScopePolicy(outOfScopeValues);
  const openQuestions = Array.isArray(spec.openQuestions)
    ? spec.openQuestions.filter((question) => {
        if (question?.category === "goal" && nonEmptyText(goalValue)) {
          return false;
        }

        if (question?.category === "success" && successValues.length > 0) {
          return false;
        }

        if (question?.category === "inputs" && inputValues.length > 0) {
          return false;
        }

        if (question?.category === "scope" && outOfScopeValues.length > 0) {
          return false;
        }

        if (question?.category === "permissions" && textMatchesOutOfScopePolicy(question?.question, outOfScopePolicy)) {
          return false;
        }

        return true;
      })
    : [];
  const blockers = openQuestions.filter((item) => item?.blocking).map((item) => item.question);
  const requiredInputs =
    inputValues.length > 0
      ? inputValues.map((name) => ({
          name,
          description: `Confirmed input source: ${name}.`,
          status: "provided"
        }))
      : spec.requiredInputs;
  const successCriteria =
    successValues.length > 0
      ? successValues.map((text) => ({
          text,
          status: "needs_confirmation"
        }))
      : spec.successCriteria;
  const requiredAccountsAndPermissions = filterStructuredArrayForOutOfScope(
    spec.requiredAccountsAndPermissions,
    outOfScopePolicy,
    (item) => [item?.system, item?.accessLevel, item?.reason].filter(nonEmptyText).join(" ")
  );
  const externalDependencies = filterStructuredArrayForOutOfScope(
    spec.externalDependencies,
    outOfScopePolicy,
    (item) => [item?.name, item?.type, item?.status].filter(nonEmptyText).join(" ")
  );
  const humanStepsRequired = filterStringArrayForOutOfScope(
    spec.automationAssessment?.humanStepsRequired,
    outOfScopePolicy
  );
  const risks = filterStringArrayForOutOfScope(spec.risks, outOfScopePolicy);
  const rationale = filterStringArrayForOutOfScope(spec.automationAssessment?.rationale, outOfScopePolicy);
  const approvalRequired = humanStepsRequired.length > 0 && spec.approvalRequired === true;

  return {
    ...spec,
    clarifiedGoal: goalValue || spec.clarifiedGoal,
    inScope: dedupeTextList([
      ...filterStringArrayForOutOfScope(spec.inScope, outOfScopePolicy),
      goalValue ? `Deliver the confirmed end point: ${goalValue}.` : null
    ]),
    outOfScope: outOfScopeValues.length > 0 ? outOfScopeValues : spec.outOfScope,
    requiredInputs,
    requiredAccountsAndPermissions,
    externalDependencies,
    risks,
    successCriteria,
    openQuestions,
    approvalRequired,
    clarificationStatus: blockers.length === 0 ? "awaiting_confirmation" : spec.clarificationStatus,
    recommendedNextStep:
      blockers.length === 0
        ? "Human confirmation can proceed because the structured execution contract filled the missing details."
        : spec.recommendedNextStep,
    automationAssessment: {
      ...spec.automationAssessment,
      humanStepsRequired,
      blockers,
      canFullyAutomate:
        blockers.length === 0 &&
        humanStepsRequired.length === 0 &&
        !requiredAccountsAndPermissions.some(
          (item) => item?.status === "missing" || item?.status === "needs_clarification"
        ),
      estimatedAutomatablePercent:
        blockers.length === 0
          ? Math.max(
              Number(spec.automationAssessment?.estimatedAutomatablePercent ?? 0) || 0,
              humanStepsRequired.length === 0 ? 100 : 90
            )
          : spec.automationAssessment?.estimatedAutomatablePercent ?? 25,
      rationale: dedupeTextList([
        ...rationale,
        blockers.length === 0
          ? "The structured execution contract supplied the missing goal, input, success, and scope details."
          : null
      ])
    },
    lastUpdatedAt: now.toISOString()
  };
}

function buildExecutionPreviewFromIntake(spec, artifactPaths = null) {
  const requiredInputs = summarizeStructuredItems(
    spec.requiredInputs,
    (item) => `${item.name} (${item.status})`
  );
  const requiredPermissions = summarizeStructuredItems(
    spec.requiredAccountsAndPermissions,
    (item) => `${item.system} (${item.status})`
  );
  const successTargets = summarizeStructuredItems(spec.successCriteria, (item) => item.text);
  const blockingQuestions = summarizeStructuredItems(
    spec.openQuestions?.filter((item) => item?.blocking),
    (item) => item.question
  );
  const humanCheckpoints = Array.isArray(spec.automationAssessment?.humanStepsRequired)
    ? spec.automationAssessment.humanStepsRequired.filter((item) => nonEmptyText(item))
    : [];

  const simulatedConfirmedSpec = {
    ...spec,
    successCriteria: Array.isArray(spec.successCriteria)
      ? spec.successCriteria.map((item) =>
          item?.status === "needs_confirmation"
            ? {
                ...item,
                status: "defined"
              }
            : item
        )
      : [],
    confirmedByUser: true,
    clarificationStatus: "confirmed"
  };
  const readiness = assessIntakePlanningReadiness(simulatedConfirmedSpec);

  return {
    confirmationToken: QUICK_START_CONFIRMATION_TOKEN,
    readyToExecute: readiness.allowed,
    startPoint: {
      request: spec.originalRequest,
      inputs: requiredInputs,
      permissions: requiredPermissions
    },
    endPoint: {
      goal: spec.clarifiedGoal,
      successTargets,
      outOfScope: Array.isArray(spec.outOfScope) ? spec.outOfScope : []
    },
    processSteps: [
      "先分析你貼上的任務內文，整理成可執行版本。",
      "用白話列出起點（會讀什麼、需要哪些前置）與終點（交付什麼、怎樣算成功）。",
      `你輸入確認語句「${QUICK_START_CONFIRMATION_TOKEN}」後，系統才會正式執行。`,
      "確認通過後才會進入 confirm -> run -> autonomous。"
    ],
    humanCheckpoints,
    blockingQuestions,
    readinessReasons: readiness.reasons,
    intakeSpecPath: artifactPaths?.intakeSpecPath ?? null,
    intakeSummaryPath: artifactPaths?.intakeSummaryPath ?? null
  };
}

function buildPreviewBlockingMessage(preview) {
  return [
    "Cannot start execution yet because intake clarification is still incomplete.",
    ...preview.readinessReasons.map((reason) => `- ${reason}`),
    preview.intakeSpecPath ? `- intakeSpecPath: ${preview.intakeSpecPath}` : null,
    preview.intakeSummaryPath ? `- intakeSummaryPath: ${preview.intakeSummaryPath}` : null
  ]
    .filter((item) => nonEmptyText(item))
    .join("\n");
}

function summarizeAutonomousOutcome(summary = null) {
  const runSummary =
    summary && typeof summary.runSummary === "object" && summary.runSummary !== null
      ? summary.runSummary
      : {};
  const finalStatus =
    typeof summary?.finalStatus === "string" && summary.finalStatus.trim().length > 0
      ? summary.finalStatus.trim()
      : typeof runSummary.status === "string" && runSummary.status.trim().length > 0
        ? runSummary.status.trim()
        : "unknown";
  const stopReason =
    typeof summary?.stopReason === "string" && summary.stopReason.trim().length > 0
      ? summary.stopReason.trim()
      : null;
  const readyTasks = Number.isFinite(runSummary.readyTasks) ? runSummary.readyTasks : 0;
  const pendingTasks = Number.isFinite(runSummary.pendingTasks) ? runSummary.pendingTasks : 0;
  const waitingRetryTasks = Number.isFinite(runSummary.waitingRetryTasks) ? runSummary.waitingRetryTasks : 0;
  const blockedTasks = Number.isFinite(runSummary.blockedTasks) ? runSummary.blockedTasks : 0;
  const failedTasks = Number.isFinite(runSummary.failedTasks) ? runSummary.failedTasks : 0;

  if (finalStatus === "completed" && readyTasks === 0 && blockedTasks === 0 && failedTasks === 0) {
    return {
      kind: "completed",
      title: "Quick start completed",
      message: "The run reached a completed state with no remaining ready, blocked, or failed tasks."
    };
  }

  if (stopReason === "maximum rounds reached" && (readyTasks > 0 || pendingTasks > 0)) {
    return {
      kind: "in_progress",
      title: "Quick start started but the run is still in progress",
      message: "The one-click flow reached the current round limit before the run completed."
    };
  }

  if (waitingRetryTasks > 0 && blockedTasks === 0 && failedTasks === 0) {
    return {
      kind: "in_progress",
      title: "Quick start is waiting to retry automatically",
      message: "The run is in a retry cooldown after a recoverable launcher or runtime issue."
    };
  }

  if (blockedTasks > 0 || failedTasks > 0) {
    return {
      kind: "needs_attention",
      title: "Quick start finished this pass but the run needs attention",
      message: "The run stopped with blocked or failed tasks that still need follow-up."
    };
  }

  return {
    kind: "in_progress",
    title: "Quick start started but the run is not finished yet",
    message: "The run has been created and may need additional autonomous rounds to finish."
  };
}

function buildContractBlockingMessage(executionContract) {
  return [
    "Cannot start quick execution because the execution contract is incomplete.",
    ...executionContract.missingFieldReasons.map((reason) => `- ${reason}`),
    "- Paste your request in this contract format before quick start:",
    ...executionContract.template.map((item) => `- ${item}`)
  ].join("\n");
}

function buildExecutionPreviewFromIntakeV2(spec, artifactPaths = null, requestOverride = null) {
  const preview = buildExecutionPreviewFromIntake(spec, artifactPaths);
  const requestTextForContract =
    nonEmptyText(requestOverride) ? requestOverride : (spec.originalRequest ?? "");
  const executionContract = parseQuickStartExecutionContract(requestTextForContract);
  const confirmationToken =
    nonEmptyText(QUICK_START_CONFIRMATION_TOKEN_SAFE)
      ? QUICK_START_CONFIRMATION_TOKEN_SAFE
      : (preview.confirmationToken ?? QUICK_START_CONFIRMATION_TOKEN);
  const contractInputs = executionContract.fields.inputSource.values;
  const contractSuccessTargets = executionContract.fields.successCriteria.values;
  const contractOutOfScope = executionContract.fields.outOfScope.values;

  return {
    ...preview,
    confirmationToken,
    previewDigest: buildPreviewDigest(requestTextForContract),
    readyToExecute: Boolean(preview.readyToExecute) && executionContract.complete,
    startPoint: {
      ...preview.startPoint,
      request: executionContract.fields.startPoint.value || preview.startPoint?.request || requestTextForContract,
      inputs: contractInputs.length > 0 ? contractInputs : (preview.startPoint?.inputs ?? [])
    },
    endPoint: {
      ...preview.endPoint,
      goal: executionContract.fields.endPoint.value || preview.endPoint?.goal || spec.clarifiedGoal,
      successTargets:
        contractSuccessTargets.length > 0 ? contractSuccessTargets : (preview.endPoint?.successTargets ?? []),
      outOfScope: contractOutOfScope.length > 0 ? contractOutOfScope : (preview.endPoint?.outOfScope ?? [])
    },
    executionContract,
    readinessReasons: [
      ...(Array.isArray(preview.readinessReasons) ? preview.readinessReasons : []),
      ...executionContract.missingFieldReasons
    ]
  };
}

function contractValue(executionContract, key) {
  return executionContract?.fields?.[key]?.value ?? "";
}

function contractValues(executionContract, key) {
  return Array.isArray(executionContract?.fields?.[key]?.values) ? executionContract.fields[key].values : [];
}

function createUserError(message) {
  return Object.assign(new Error(message), {
    statusCode: 400
  });
}

function createHttpError(message, statusCode) {
  return Object.assign(new Error(message), {
    statusCode
  });
}

function readStatusCode(error) {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const candidate = error.statusCode;

    if (typeof candidate === "number" && candidate >= 400) {
      return candidate;
    }
  }

  return null;
}

function extractPromptFromStderr(stderr) {
  if (typeof stderr !== "string" || stderr.trim().length === 0) {
    return null;
  }

  const normalized = stderr.replaceAll("\r\n", "\n");
  const userMarker = "\nuser\n";
  let startIndex = normalized.indexOf(userMarker);

  if (startIndex >= 0) {
    startIndex += userMarker.length;
  } else if (normalized.startsWith("user\n")) {
    startIndex = "user\n".length;
  } else {
    return null;
  }

  let promptBody = normalized.slice(startIndex);
  const timestampMatch = /\n\d{4}-\d{2}-\d{2}T/.exec(promptBody);

  if (timestampMatch && typeof timestampMatch.index === "number") {
    promptBody = promptBody.slice(0, timestampMatch.index);
  }

  const trimmed = promptBody.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePreferredModel(stdout) {
  if (typeof stdout !== "string") {
    return null;
  }

  const match = stdout.match(/Preferred model:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

function parseExecutionMetadata(stderr) {
  if (typeof stderr !== "string") {
    return {
      model: null,
      provider: null,
      sessionId: null,
      endpoint: null,
      cfRay: null
    };
  }

  const model = stderr.match(/^\s*model:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const provider = stderr.match(/^\s*provider:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const sessionId = stderr.match(/^\s*session id:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const endpoint = stderr.match(/url:\s*(https?:\/\/\S+)/i)?.[1]?.replace(/[,)]$/, "") ?? null;
  const cfRay = stderr.match(/cf-ray:\s*([^\s,]+)/i)?.[1]?.trim() ?? null;

  return {
    model,
    provider,
    sessionId,
    endpoint,
    cfRay
  };
}

function truncateText(value, maxLength = 12000) {
  if (typeof value !== "string") {
    return {
      text: null,
      truncated: false
    };
  }

  if (value.length <= maxLength) {
    return {
      text: value,
      truncated: false
    };
  }

  return {
    text: `${value.slice(0, maxLength)}\n\n... [truncated]`,
    truncated: true
  };
}

async function readGptEvidenceForRun(runStatePath) {
  const dispatchResultsPath = await findLatestDispatchResultsPath(runStatePath);

  if (!dispatchResultsPath) {
    throw createUserError("No dispatch-results.json found for this run. Execute dispatch first.");
  }

  const dispatchResults = await readJson(dispatchResultsPath);
  const gptInteractions = [];

  for (const result of dispatchResults?.results ?? []) {
    if (result?.runtime !== "gpt-runner") {
      continue;
    }

    const promptInfo = truncateText(extractPromptFromStderr(result?.stderr));
    const execution = parseExecutionMetadata(result?.stderr);

    gptInteractions.push({
      taskId: result?.taskId ?? null,
      handoffId: result?.handoffId ?? null,
      status: result?.status ?? null,
      runtime: result?.runtime ?? null,
      preferredModel: parsePreferredModel(result?.stdout),
      model: execution.model,
      provider: execution.provider,
      sessionId: execution.sessionId,
      endpoint: execution.endpoint,
      cfRay: execution.cfRay,
      launcherPath: result?.launcherPath ?? null,
      resultPath: result?.resultPath ?? null,
      promptText: promptInfo.text,
      promptTextTruncated: promptInfo.truncated
    });
  }

  if (gptInteractions.length === 0) {
    throw createUserError("No gpt-runner execution records were found in dispatch-results.json.");
  }

  return {
    runStatePath,
    dispatchResultsPath,
    interactionCount: gptInteractions.length,
    gptInteractions
  };
}

async function handlePanelAction(state, action, payload = {}) {
  const defaults = getDefaultPaths(state.workspaceRoot);

  switch (action) {
    case "set-workspace": {
      const nextWorkspace = payload?.workspaceDir;

      if (typeof nextWorkspace !== "string" || nextWorkspace.trim().length === 0) {
        throw createUserError("Please provide workspaceDir.");
      }

      state.workspaceRoot = resolvePanelWorkspace(nextWorkspace);
      return {
        workspaceRoot: state.workspaceRoot
      };
    }
    case "init":
      return initProject(resolveWithinWorkspace(state.workspaceRoot, payload?.targetDir, state.workspaceRoot));
    case "intake": {
      const userRequest = typeof payload?.request === "string" ? payload.request : "";

      if (userRequest.trim().length === 0) {
        throw createUserError("Please provide request text for intake.");
      }

      return intakeRequest(userRequest, state.workspaceRoot);
    }
    case "intake-preview": {
      const requestText = typeof payload?.request === "string" ? payload.request.trim() : "";

      if (requestText.length > 0) {
        const executionContract = parseQuickStartExecutionContract(requestText);
        const previewSpec = applyExecutionContractToIntakeSpec(
          clarifyIntakeRequest(requestText),
          executionContract
        );
        return {
          source: "request",
          preview: buildExecutionPreviewFromIntakeV2(previewSpec, null, requestText)
        };
      }

      const intake = await loadIntakeArtifacts(state.workspaceRoot);

      if (!intake.exists || !intake.spec) {
        throw createUserError("No intake artifact found. Paste a request first.");
      }

      return {
        source: "artifact",
        preview: buildExecutionPreviewFromIntakeV2(intake.spec, intake.artifactPaths)
      };
    }
    case "confirm":
      return confirmIntake(state.workspaceRoot);
    case "revise":
      return reviseIntake(payload?.request, state.workspaceRoot);
    case "validate":
      return validateSpec(resolveWithinWorkspace(state.workspaceRoot, payload?.specPath, defaults.specPath));
    case "plan":
      return planProject(
        resolveWithinWorkspace(state.workspaceRoot, payload?.specPath, defaults.specPath),
        resolveWithinWorkspace(state.workspaceRoot, payload?.outputDir, defaults.runsDir)
      );
    case "run":
      return runProject(
        resolveWithinWorkspace(state.workspaceRoot, payload?.specPath, defaults.specPath),
        resolveWithinWorkspace(state.workspaceRoot, payload?.outputDir, defaults.runsDir),
        payload?.runId
      );
    case "quick-start-safe": {
      const userRequest = typeof payload?.request === "string" ? payload.request.trim() : "";

      if (userRequest.length === 0) {
        throw createUserError("Please provide request text before quick start.");
      }

      const parsedRounds =
        payload?.maxRounds === undefined || payload?.maxRounds === null || String(payload.maxRounds).trim().length === 0
          ? undefined
          : Number.parseInt(String(payload.maxRounds), 10);
      const maxRounds = Number.isFinite(parsedRounds) ? parsedRounds : undefined;
      const requestedRunId =
        typeof payload?.runId === "string" && payload.runId.trim().length > 0 ? payload.runId.trim() : undefined;
      const confirmationText =
        typeof payload?.confirmationText === "string" ? payload.confirmationText.trim() : "";
      const previewDigest =
        typeof payload?.previewDigest === "string" ? payload.previewDigest.trim() : "";
      const expectedPreviewDigest = buildPreviewDigest(userRequest);
      const executionContract = parseQuickStartExecutionContract(userRequest);

      if (!executionContract.complete) {
        throw createUserError(buildContractBlockingMessage(executionContract));
      }

      if (!nonEmptyText(previewDigest) || previewDigest !== expectedPreviewDigest) {
        throw createUserError(
          [
            "Preview digest mismatch. Run intake-preview first and submit the returned previewDigest unchanged.",
            `- expectedPreviewDigest: ${expectedPreviewDigest}`
          ].join("\n")
        );
      }

      const initResult = await initProject(state.workspaceRoot);
      const intakeResult = await intakeRequest(userRequest, state.workspaceRoot);
      const contractResolvedIntake = applyExecutionContractToIntakeSpec(intakeResult.spec, executionContract);
      await writeIntakeArtifacts(state.workspaceRoot, contractResolvedIntake);
      const preview = buildExecutionPreviewFromIntakeV2(
        contractResolvedIntake,
        intakeResult.artifactPaths,
        userRequest
      );

      if (!preview.readyToExecute) {
        throw createUserError(buildPreviewBlockingMessage(preview));
      }

      if (preview.previewDigest !== expectedPreviewDigest) {
        throw createUserError(
          [
            "Preview digest mismatch after intake materialization.",
            `- expectedPreviewDigest: ${expectedPreviewDigest}`,
            `- actualPreviewDigest: ${preview.previewDigest ?? "(missing)"}`
          ].join("\n")
        );
      }

      if (confirmationText !== preview.confirmationToken) {
        throw createUserError(
          [
            "Human confirmation is required before execution.",
            `Please type this exact confirmation text: ${preview.confirmationToken}`,
            `Then run quick start again to continue.`
          ].join("\n")
        );
      }

      const confirmResult = await confirmIntake(state.workspaceRoot);
      const generatedSpec = await writeQuickStartProjectSpec(
        state.workspaceRoot,
        confirmResult.spec,
        preview.executionContract
      );
      const runResult = await runProject(generatedSpec.specPath, defaults.runsDir, requestedRunId);
      const autonomousResult = await runAutonomousLoop(runResult.statePath, {
        doctorReportPath: path.join(defaults.reportsDir, "runtime-doctor.json"),
        handoffOutputDir: path.join(path.dirname(runResult.statePath), "handoffs"),
        maxRounds
      });
      const outcome = summarizeAutonomousOutcome(autonomousResult.summary);

      return {
        init: {
          targetDir: initResult.targetDir
        },
        intake: intakeResult.summary,
        preview,
        confirm: confirmResult.summary,
        spec: {
          specPath: generatedSpec.specPath,
          projectName: generatedSpec.spec.projectName
        },
        run: {
          runId: runResult.runId,
          statePath: runResult.statePath,
          reportPath: runResult.reportPath
        },
        autonomous: autonomousResult.summary,
        outcome
      };
    }
    case "doctor":
      return runRuntimeDoctor(resolveWithinWorkspace(state.workspaceRoot, payload?.outputDir, defaults.reportsDir));
    case "report": {
      const runStatePath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.runStatePath,
        await findLatestRunStatePath(state.workspaceRoot)
      );

      if (typeof runStatePath !== "string" || runStatePath.trim().length === 0) {
        throw createUserError("No run-state.json found. Create a run first.");
      }

      return reportProjectRun(runStatePath);
    }
    case "handoff": {
      const runStatePath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.runStatePath,
        await findLatestRunStatePath(state.workspaceRoot)
      );

      if (typeof runStatePath !== "string" || runStatePath.trim().length === 0) {
        throw createUserError("No run-state.json found. Create a run first.");
      }

      return createRunHandoffs(runStatePath, payload?.outputDir, payload?.doctorReportPath);
    }
    case "dispatch": {
      const fallbackRunStatePath = await findLatestRunStatePath(state.workspaceRoot);
      const fallbackHandoffIndexPath = fallbackRunStatePath
        ? await resolveDefaultHandoffIndexPath(fallbackRunStatePath).catch(() => null)
        : null;
      const handoffIndexPath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.handoffIndexPath,
        fallbackHandoffIndexPath
      );

      if (typeof handoffIndexPath !== "string" || handoffIndexPath.trim().length === 0) {
        throw createUserError("No handoff index was found. Generate handoffs first.");
      }

      const mode = payload?.mode === "execute" ? "execute" : "dry-run";
      return dispatchHandoffs(handoffIndexPath, mode);
    }
    case "autonomous": {
      const runStatePath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.runStatePath,
        await findLatestRunStatePath(state.workspaceRoot)
      );

      if (typeof runStatePath !== "string" || runStatePath.trim().length === 0) {
        throw createUserError("No run-state.json found. Create a run first.");
      }

      const parsedRounds =
        payload?.maxRounds === undefined || payload?.maxRounds === null || String(payload.maxRounds).trim().length === 0
          ? undefined
          : Number.parseInt(String(payload.maxRounds), 10);
      const maxRounds = Number.isFinite(parsedRounds) ? parsedRounds : undefined;
      const doctorReportPath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.doctorReportPath,
        path.join(defaults.reportsDir, "runtime-doctor.json")
      );
      const handoffOutputDir = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.outputDir,
        path.join(path.dirname(runStatePath), "handoffs")
      );

      return runAutonomousLoop(runStatePath, {
        doctorReportPath,
        handoffOutputDir,
        maxRounds
      });
    }
    case "gpt-evidence": {
      const runStatePath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.runStatePath,
        await findLatestRunStatePath(state.workspaceRoot)
      );

      if (typeof runStatePath !== "string" || runStatePath.trim().length === 0) {
        throw createUserError("No run-state.json found. Create a run first.");
      }

      return readGptEvidenceForRun(runStatePath);
    }
    case "status":
      return buildWorkspaceOverview(state.workspaceRoot);
    default:
      throw createUserError(`Unsupported panel action: ${action}`);
  }
}

async function readJsonRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_REQUEST_BYTES) {
      throw createHttpError("Request body is too large.", 413);
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();

  if (text.length === 0) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw createUserError("Request body must be valid JSON.");
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function renderPanelHtml(workspaceRoot) {
  const escapedWorkspace = escapeHtml(workspaceRoot);
  const serializedWorkspace = JSON.stringify(workspaceRoot);

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AI Factory 中文操作面板</title>
  <style>
    :root { --ink:#132238; --sub:#4a6078; --bg:#eef4f8; --card:#fff; --line:#d8e3ef; --accent:#0f9d7a; --warn:#bf6f15; --bad:#bb3a43; --code:#0f1727; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Noto Sans TC","Microsoft JhengHei",ui-sans-serif,system-ui,sans-serif; color:var(--ink); background:radial-gradient(circle at 0% 0%, rgba(15,157,122,.08), transparent 45%),radial-gradient(circle at 100% 100%, rgba(30,94,157,.08), transparent 45%),var(--bg); }
    .shell { max-width:1080px; margin:0 auto; padding:22px 16px 28px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
    .hero { grid-column:1/-1; background:linear-gradient(160deg,#f7fcff,#f5fdfa); border:1px solid var(--line); border-radius:18px; padding:16px 18px; box-shadow:0 8px 20px rgba(16,54,87,.08); }
    .hero h1 { margin:0 0 6px; font-size:1.35rem; letter-spacing:.01em; }
    .hero p { margin:0; color:var(--sub); line-height:1.6; }
    .steps { margin:10px 0 0; padding-left:20px; color:#335374; line-height:1.6; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:14px; box-shadow:0 6px 16px rgba(16,54,87,.06); }
    .card h2 { margin:0 0 8px; font-size:1rem; }
    .hint { margin:0 0 10px; color:var(--sub); font-size:.9rem; line-height:1.55; }
    label { display:block; font-size:.84rem; color:#335374; margin-bottom:5px; font-weight:600; }
    input, textarea { width:100%; border:1px solid #cfdbea; border-radius:11px; padding:10px 11px; font:inherit; color:var(--ink); background:#fbfeff; }
    textarea { min-height:118px; resize:vertical; line-height:1.55; }
    .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .actions { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px; margin-top:10px; }
    button { border:0; border-radius:11px; padding:9px 10px; font:inherit; cursor:pointer; color:#fff; background:linear-gradient(140deg,var(--accent),#13b78d); box-shadow:0 8px 18px rgba(15,157,122,.28); }
    button:hover { filter:brightness(1.03); }
    button[data-tone="neutral"] { background:linear-gradient(140deg,#4b6d93,#365374); box-shadow:0 8px 18px rgba(39,70,108,.24); }
    button[data-tone="warn"] { background:linear-gradient(140deg,#d1832f,#b2600f); box-shadow:0 8px 18px rgba(178,96,15,.24); }
    .status-pill { display:inline-flex; align-items:center; gap:8px; border-radius:999px; padding:7px 12px; font-size:.84rem; font-weight:600; background:rgba(18,143,98,.13); color:#136548; }
    .status-pill.warn { background:rgba(193,119,31,.16); color:#8d5112; }
    .status-pill.error { background:rgba(187,58,67,.14); color:#8d2028; }
    .kv { margin:10px 0 0; display:grid; grid-template-columns:130px 1fr; row-gap:6px; column-gap:10px; font-size:.88rem; }
    .kv dt { color:#48627f; font-weight:600; }
    .kv dd { margin:0; word-break:break-word; color:#142b45; }
    details { border:1px dashed #cad7e8; border-radius:12px; padding:10px; background:#fafdff; }
    details > summary { cursor:pointer; font-size:.9rem; font-weight:600; color:#365374; margin-bottom:8px; }
    pre { margin:0; padding:12px; border-radius:12px; border:1px solid #dde6f3; background:var(--code); color:#dbe6f4; font-family:"Cascadia Code",Consolas,monospace; font-size:.8rem; line-height:1.5; max-height:360px; overflow:auto; }
    @media (max-width: 680px) { .grid-2 { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <h1>AI Factory 中文操作面板</h1>
      <p>給人類操作的簡化流程：一鍵完成初始化、需求澄清、確認、建立 Run、全自動執行。</p>
      <ol class="steps">
        <li>先確認工作區路徑</li>
        <li>輸入需求文字</li>
        <li>按「一鍵開始（推薦）」</li>
      </ol>
      <p style="margin-top:8px"><strong>目前工作區：</strong> <code id="workspaceTag">${escapedWorkspace}</code></p>
    </section>

    <section class="card">
      <h2>基本設定</h2>
      <p class="hint">一般情況下按一鍵開始即可。需要時再使用進階按鈕。</p>
      <label for="workspaceInput">工作區路徑</label>
      <input id="workspaceInput" value="${escapedWorkspace}" />
      <label for="requestInput" style="margin-top:10px">需求內容</label>
      <textarea id="requestInput">${escapeHtml(DEFAULT_PANEL_REQUEST_TEXT)}</textarea>
      <div class="grid-2" style="margin-top:10px">
        <div>
          <label for="runIdInput">Run ID（可留空）</label>
          <input id="runIdInput" placeholder="例如 today-run-001" />
        </div>
        <div>
          <label for="maxRoundsInput">最大自動輪數</label>
          <input id="maxRoundsInput" value="20" />
        </div>
      </div>
      <label for="confirmationInput" style="margin-top:10px">人工確認語句（建議先按「分析起點/終點」再貼上）</label>
      <input id="confirmationInput" placeholder="我確認起點與終點" />
      <div class="actions">
        <button id="applyWorkspaceBtn" data-tone="neutral">套用工作區</button>
        <button id="previewIntakeBtn" data-tone="neutral">分析起點/終點</button>
        <button id="quickStartBtn" data-tone="warn">一鍵開始（推薦）</button>
        <button id="resumeNowBtn" data-tone="neutral">Resume now</button>
        <button id="refreshStatusBtn" data-tone="neutral">重新整理狀態</button>
        <button id="viewGptPromptBtn" data-tone="neutral">查看 GPT 發問內容</button>
      </div>
    </section>

    <section class="card">
      <h2>目前狀態</h2>
      <div id="statusPill" class="status-pill">讀取中...</div>
      <dl class="kv" id="statusDetail"></dl>
    </section>

    <section class="card">
      <h2>進階操作（選用）</h2>
      <details>
        <summary>展開進階按鈕</summary>
        <p class="hint">只有需要手動排查時才用，平常不用。</p>
        <div class="actions">
          <button id="initBtn">只做初始化</button>
          <button id="intakeBtn">只做需求澄清</button>
          <button id="confirmBtn">只做需求確認</button>
          <button id="runBtn">只建立 Run</button>
          <button id="autonomousBtn" data-tone="warn">只跑全自動</button>
          <button id="doctorBtn" data-tone="neutral">環境健康檢查</button>
        </div>
      </details>
    </section>

    <section class="card" style="grid-column: 1 / -1">
      <h2>操作紀錄</h2>
      <p class="hint">每次動作的回應都會顯示在這裡。</p>
      <pre id="logBox">等待操作...</pre>
    </section>
  </main>

  <script>
    const initialWorkspace = ${serializedWorkspace};
    const workspaceInput = document.getElementById("workspaceInput");
    const workspaceTag = document.getElementById("workspaceTag");
    const requestInput = document.getElementById("requestInput");
    const runIdInput = document.getElementById("runIdInput");
    const maxRoundsInput = document.getElementById("maxRoundsInput");
    const confirmationInput = document.getElementById("confirmationInput");
    const statusPill = document.getElementById("statusPill");
    const statusDetail = document.getElementById("statusDetail");
    const logBox = document.getElementById("logBox");
    const resumeNowBtn = document.getElementById("resumeNowBtn");
    let latestOverview = null;
    let panelBusy = false;
    let autoResumeTimerId = null;
    let scheduledAutoResumeKey = null;
    let triggeredAutoResumeKey = null;

    const runStatusLabelMap = {
      planned: "已規劃",
      in_progress: "進行中",
      completed: "已完成",
      attention_required: "需要人工處理",
      pending: "等待中",
      ready: "可執行",
      waiting_retry: "等待重試",
      blocked: "已阻塞",
      failed: "已失敗",
      "not-found": "尚未建立",
      "no-run": "尚未建立"
    };

    const intakeStatusLabelMap = {
      clarifying: "澄清中",
      awaiting_confirmation: "等待確認",
      confirmed: "已確認",
      clarification_blocked: "確認失敗（需補資訊）",
      clarification_abandoned: "已放棄",
      "not-found": "尚未建立"
    };

    workspaceInput.value = initialWorkspace;

    function setButtonsDisabled(disabled) {
      panelBusy = disabled;
      for (const button of document.querySelectorAll("button")) {
        button.disabled = disabled;
        button.style.opacity = disabled ? "0.65" : "1";
      }
      syncResumeNowButton();
    }

    async function parseJsonResponse(response) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: "伺服器回傳非 JSON 內容。", raw: text };
      }
    }

    async function callApi(urlPath, options = {}) {
      const response = await fetch(urlPath, options);
      const payload = await parseJsonResponse(response);
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || payload.message || "API 呼叫失敗。");
      }
      return payload;
    }

    function setLog(title, value) {
      const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      logBox.textContent = "[" + new Date().toLocaleString() + "] " + title + "\\n\\n" + body;
    }

    function labelForRunStatus(value) { return runStatusLabelMap[value] || value || "-"; }
    function labelForIntakeStatus(value) { return intakeStatusLabelMap[value] || value || "-"; }

    function formatDateTime(value) {
      if (typeof value !== "string" || value.trim().length === 0) {
        return "-";
      }

      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
    }

    function buildAutonomousPayload(runStatePath) {
      return {
        runStatePath,
        maxRounds: maxRoundsInput.value.trim() || undefined
      };
    }

    function getWaitingRetryState(overview = latestOverview) {
      const latestRun = overview?.latestRun ?? {};
      const summary = latestRun.summary ?? {};
      const waitingRetry = latestRun.waitingRetry ?? {};
      const waitingRetryTasks = Number.isFinite(summary.waitingRetryTasks) ? summary.waitingRetryTasks : 0;
      const blockedTasks = Number.isFinite(summary.blockedTasks) ? summary.blockedTasks : 0;
      const failedTasks = Number.isFinite(summary.failedTasks) ? summary.failedTasks : 0;
      const runStatePath =
        typeof latestRun.runStatePath === "string" && latestRun.runStatePath.trim().length > 0
          ? latestRun.runStatePath.trim()
          : "";
      const nextRetryAt =
        typeof waitingRetry.earliestNextRetryAt === "string" && waitingRetry.earliestNextRetryAt.trim().length > 0
          ? waitingRetry.earliestNextRetryAt.trim()
          : "";

      return {
        canResume: waitingRetryTasks > 0 && blockedTasks === 0 && failedTasks === 0 && runStatePath.length > 0,
        runStatePath,
        nextRetryAt,
        autoResumeKey: runStatePath && nextRetryAt ? runStatePath + "::" + nextRetryAt : ""
      };
    }

    function syncResumeNowButton(overview = latestOverview) {
      if (!resumeNowBtn) {
        return;
      }

      const waitingRetryState = getWaitingRetryState(overview);
      const enabled = waitingRetryState.canResume && !panelBusy;

      resumeNowBtn.disabled = !enabled;
      resumeNowBtn.style.opacity = enabled ? "1" : "0.65";
      resumeNowBtn.title = waitingRetryState.canResume
        ? waitingRetryState.nextRetryAt
          ? "Scheduled retry at " + formatDateTime(waitingRetryState.nextRetryAt) + "."
          : "The latest run is waiting to retry."
        : "Resume is only available when the latest run is waiting to retry.";
    }

    function clearAutoResumeTimer() {
      if (autoResumeTimerId !== null) {
        window.clearTimeout(autoResumeTimerId);
        autoResumeTimerId = null;
      }

      scheduledAutoResumeKey = null;
    }

    function scheduleAutoResume(overview = latestOverview) {
      const waitingRetryState = getWaitingRetryState(overview);

      if (!waitingRetryState.canResume) {
        clearAutoResumeTimer();
        triggeredAutoResumeKey = null;
        syncResumeNowButton(overview);
        return;
      }

      syncResumeNowButton(overview);

      if (!waitingRetryState.nextRetryAt) {
        clearAutoResumeTimer();
        return;
      }

      const nextRetryAtMs = Date.parse(waitingRetryState.nextRetryAt);

      if (!Number.isFinite(nextRetryAtMs)) {
        clearAutoResumeTimer();
        return;
      }

      const autoResumeKey = waitingRetryState.autoResumeKey;

      if (triggeredAutoResumeKey && triggeredAutoResumeKey !== autoResumeKey) {
        triggeredAutoResumeKey = null;
      }

      if (scheduledAutoResumeKey === autoResumeKey && autoResumeTimerId !== null) {
        return;
      }

      clearAutoResumeTimer();

      if (triggeredAutoResumeKey === autoResumeKey && nextRetryAtMs <= Date.now()) {
        return;
      }

      const delayMs = Math.max(nextRetryAtMs - Date.now(), 0);

      const triggerAutoResume = async () => {
        autoResumeTimerId = null;
        scheduledAutoResumeKey = null;

        if (panelBusy) {
          scheduledAutoResumeKey = autoResumeKey;
          autoResumeTimerId = window.setTimeout(() => {
            void triggerAutoResume();
          }, 1000);
          return;
        }

        triggeredAutoResumeKey = autoResumeKey;
        await runAction(
          "autonomous",
          buildAutonomousPayload(waitingRetryState.runStatePath),
          "Auto resume after waiting_retry"
        );
      };

      scheduledAutoResumeKey = autoResumeKey;
      autoResumeTimerId = window.setTimeout(() => {
        void triggerAutoResume();
      }, delayMs);
    }

    function summarizeAutonomousOutcomeForLog(summary) {
      const runSummary = summary && typeof summary.runSummary === "object" ? summary.runSummary : {};
      const finalStatus =
        typeof summary?.finalStatus === "string" && summary.finalStatus.trim()
          ? summary.finalStatus.trim()
          : (runSummary.status || "unknown");
      const stopReason =
        typeof summary?.stopReason === "string" && summary.stopReason.trim()
          ? summary.stopReason.trim()
          : null;
      const readyTasks = Number.isFinite(runSummary.readyTasks) ? runSummary.readyTasks : 0;
      const pendingTasks = Number.isFinite(runSummary.pendingTasks) ? runSummary.pendingTasks : 0;
      const waitingRetryTasks = Number.isFinite(runSummary.waitingRetryTasks) ? runSummary.waitingRetryTasks : 0;
      const blockedTasks = Number.isFinite(runSummary.blockedTasks) ? runSummary.blockedTasks : 0;
      const failedTasks = Number.isFinite(runSummary.failedTasks) ? runSummary.failedTasks : 0;

      if (finalStatus === "completed" && readyTasks === 0 && blockedTasks === 0 && failedTasks === 0) {
        return {
          title: "Quick start completed",
          status: "completed"
        };
      }

      if (stopReason === "maximum rounds reached" && (readyTasks > 0 || pendingTasks > 0)) {
        return {
          title: "Quick start reached the round limit and the run is still in progress",
          status: "in_progress"
        };
      }

      if (waitingRetryTasks > 0 && blockedTasks === 0 && failedTasks === 0) {
        return {
          title: "Quick start is waiting to retry automatically",
          status: "in_progress"
        };
      }

      if (blockedTasks > 0 || failedTasks > 0) {
        return {
          title: "Quick start finished this pass but the run needs attention",
          status: "needs_attention"
        };
      }

      return {
        title: "Quick start started but the run is not finished yet",
        status: "in_progress"
      };
    }

    function renderStatus(overview) {
      latestOverview = overview;
      workspaceTag.textContent = overview.workspaceRoot;
      const intakeState = overview.intake?.clarificationStatus || "not-found";
      const runState = overview.latestRun?.summary?.status || "no-run";
      const waitingConfirm = overview.intake?.exists && overview.intake?.confirmedByUser === false;
      const waitingRetry = overview.latestRun?.waitingRetry || {};
      statusPill.textContent = "需求狀態：" + labelForIntakeStatus(intakeState) + " | 執行狀態：" + labelForRunStatus(runState);
      statusPill.className = "status-pill";
      if (waitingConfirm) { statusPill.classList.add("warn"); }
      if (overview.latestRun?.summary?.blockedTasks > 0 || overview.latestRun?.summary?.failedTasks > 0) {
        statusPill.classList.remove("warn");
        statusPill.classList.add("error");
      } else if (overview.latestRun?.summary?.waitingRetryTasks > 0) {
        statusPill.classList.add("warn");
        if (waitingRetry.earliestNextRetryAt) {
          statusPill.textContent += " | Retry at " + formatDateTime(waitingRetry.earliestNextRetryAt);
        }
      }

      const latestRun = overview.latestRun || {};
      const summary = latestRun.summary || {};
      const fields = [
        ["工作區", overview.workspaceRoot],
        ["規格檔", overview.defaults?.specPath || "-"],
        ["最新 Run 檔案", latestRun.runStatePath || "-"],
        ["Run ID", summary.runId || "-"],
        ["需求狀態", labelForIntakeStatus(intakeState)],
        ["執行狀態", labelForRunStatus(summary.status || runState)],
        ["已完成任務", String(summary.completedTasks ?? "-")],
        ["可執行任務", String(summary.readyTasks ?? "-")],
        ["阻塞任務", String(summary.blockedTasks ?? "-")],
        ["失敗任務", String(summary.failedTasks ?? "-")]
      ];
      fields.splice(8, 0, ["Waiting retry", String(summary.waitingRetryTasks ?? "-")]);
      fields.splice(
        9,
        0,
        ["Next retry at", waitingRetry.earliestNextRetryAt ? formatDateTime(waitingRetry.earliestNextRetryAt) : "-"]
      );
      statusDetail.innerHTML = fields.map(([key, value]) => "<dt>" + key + "</dt><dd>" + String(value) + "</dd>").join("");
      syncResumeNowButton(overview);
    }

    async function setWorkspace(logResult = true) {
      const workspaceDir = workspaceInput.value.trim();
      const result = await callApi("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-workspace", payload: { workspaceDir } })
      });
      if (logResult) { setLog("套用工作區", result); }
      await refreshStatus();
      return result;
    }

    async function invokeAction(action, payload = {}, logTitle = action) {
      const result = await callApi("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, payload })
      });
      setLog(logTitle, result);
      await refreshStatus();
      return result;
    }

    async function refreshStatus() {
      const workspaceDir = workspaceInput.value.trim();
      await callApi("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-workspace", payload: { workspaceDir } })
      });
      const overviewPayload = await callApi("/api/status");
      renderStatus(overviewPayload.overview);
      scheduleAutoResume(overviewPayload.overview);
      return overviewPayload;
    }

    async function runAction(action, payload = {}, logTitle = action) {
      setButtonsDisabled(true);
      try {
        await setWorkspace(false);
        await invokeAction(action, payload, logTitle);
      } catch (error) {
        setLog(logTitle + " 失敗", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        setButtonsDisabled(false);
      }
    }

    async function runQuickStart() {
      setButtonsDisabled(true);
      try {
        const requestText = requestInput.value.trim();
        if (requestText.length === 0) {
          throw new Error("請先輸入需求內容。");
        }
        await setWorkspace(false);
        await invokeAction("init", {}, "步驟 1/5：初始化");
        await invokeAction("intake", { request: requestText }, "步驟 2/5：需求澄清");
        await invokeAction("confirm", {}, "步驟 3/5：需求確認");
        const runResult = await invokeAction("run", { runId: runIdInput.value.trim() || undefined }, "步驟 4/5：建立 Run");
        const runStatePath = runResult?.result?.statePath;
        const autonomousResult = await invokeAction(
          "autonomous",
          { runStatePath, maxRounds: maxRoundsInput.value.trim() || undefined },
          "步驟 5/5：全自動執行"
        );

        setLog("一鍵開始完成", {
          runId: runResult?.result?.runId ?? "-",
          finalStatus: autonomousResult?.result?.summary?.runSummary?.status ?? "unknown"
        });
        await refreshStatus();
      } catch (error) {
        setLog("一鍵開始失敗", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        setButtonsDisabled(false);
      }
    }

    async function runQuickStartSafe() {
      setButtonsDisabled(true);
      try {
        const requestText = requestInput.value.trim();
        if (requestText.length === 0) {
          throw new Error("Please paste the task text first.");
        }

        await setWorkspace(false);
        const previewResponse = await invokeAction(
          "intake-preview",
          { request: requestText },
          "Step 1/2: analyze start/end in plain language"
        );
        const preview = previewResponse?.result?.preview;

        if (!preview) {
          throw new Error("Intake preview is unavailable.");
        }

        if (!preview.readyToExecute) {
          setLog("Quick start paused: clarify task details first", preview);
          return;
        }

        const confirmationToken = preview.confirmationToken || "我確認起點與終點";
        const previewDigest = typeof preview.previewDigest === "string" ? preview.previewDigest : "";
        const successCriteriaSummary = Array.isArray(preview.endPoint?.successTargets)
          ? preview.endPoint.successTargets
              .map((item) => String(item ?? "").trim())
              .filter((item) => item.length > 0)
              .join("; ")
          : "";
        const outOfScopeSummary = Array.isArray(preview.endPoint?.outOfScope)
          ? preview.endPoint.outOfScope
              .map((item) => String(item ?? "").trim())
              .filter((item) => item.length > 0)
              .join("; ")
          : "";
        const confirmationPrompt =
          "Please review this before execution.\\n\\nStart: " +
          (preview.startPoint?.request || "(not provided)") +
          "\\nEnd: " +
          (preview.endPoint?.goal || "(not provided)") +
          "\\nSuccess criteria: " +
          (successCriteriaSummary || "(not provided)") +
          "\\nOut of scope: " +
          (outOfScopeSummary || "(not provided)") +
          "\\n\\nType exactly: " +
          confirmationToken;
        const typedConfirmation = (confirmationInput?.value?.trim() || window.prompt(
          confirmationPrompt,
          ""
        ) || "").trim();

        if (typedConfirmation !== confirmationToken) {
          setLog("Quick start paused: waiting for human confirmation", {
            expectedConfirmation: confirmationToken,
            preview
          });
          return;
        }

        const quickStartResponse = await invokeAction(
          "quick-start-safe",
          {
            request: requestText,
            runId: runIdInput.value.trim() || undefined,
            maxRounds: maxRoundsInput.value.trim() || undefined,
            confirmationText: typedConfirmation,
            previewDigest
          },
          "Step 2/2: execute after human confirmation"
        );
        const outcome =
          quickStartResponse?.result?.outcome ??
          summarizeAutonomousOutcomeForLog(quickStartResponse?.result?.autonomous);

        setLog(outcome.title || "Quick start finished", {
          runId: quickStartResponse?.result?.run?.runId ?? "-",
          finalStatus: quickStartResponse?.result?.autonomous?.runSummary?.status ?? "unknown",
          stopReason: quickStartResponse?.result?.autonomous?.stopReason ?? null,
          completedTasks: quickStartResponse?.result?.autonomous?.runSummary?.completedTasks ?? "-",
          readyTasks: quickStartResponse?.result?.autonomous?.runSummary?.readyTasks ?? "-",
          outcome: outcome.status ?? outcome.kind ?? "unknown"
        });
      } catch (error) {
        setLog("Quick start failed", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        setButtonsDisabled(false);
      }
    }

    document.getElementById("applyWorkspaceBtn").addEventListener("click", async () => {
      setButtonsDisabled(true);
      try {
        await setWorkspace(true);
      } catch (error) {
        setLog("套用工作區失敗", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        setButtonsDisabled(false);
      }
    });
    document.getElementById("quickStartBtn").addEventListener("click", runQuickStartSafe);
    if (resumeNowBtn) {
      resumeNowBtn.addEventListener("click", () => {
        const waitingRetryState = getWaitingRetryState();

        if (!waitingRetryState.canResume) {
          setLog("Resume now is unavailable", {
            reason: "The latest run is not waiting to retry."
          });
          return;
        }

        clearAutoResumeTimer();
        triggeredAutoResumeKey = waitingRetryState.autoResumeKey || triggeredAutoResumeKey;
        runAction("autonomous", buildAutonomousPayload(waitingRetryState.runStatePath), "Resume now");
      });
    }
    if (document.getElementById("previewIntakeBtn")) {
      document.getElementById("previewIntakeBtn").addEventListener("click", () =>
        runAction("intake-preview", { request: requestInput.value }, "Analyze start/end in plain language")
      );
    }
    document.getElementById("refreshStatusBtn").addEventListener("click", async () => {
      setButtonsDisabled(true);
      try {
        await refreshStatus();
      } catch (error) {
        setLog("重新整理狀態失敗", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        setButtonsDisabled(false);
      }
    });
    document.getElementById("viewGptPromptBtn").addEventListener("click", () =>
      runAction("gpt-evidence", {}, "查看 GPT 發問內容")
    );

    document.getElementById("initBtn").addEventListener("click", () => runAction("init", {}, "只做初始化"));
    document.getElementById("intakeBtn").addEventListener("click", () =>
      runAction("intake", { request: requestInput.value }, "只做需求澄清")
    );
    document.getElementById("confirmBtn").addEventListener("click", () => runAction("confirm", {}, "只做需求確認"));
    document.getElementById("runBtn").addEventListener("click", () =>
      runAction("run", { runId: runIdInput.value.trim() || undefined }, "只建立 Run")
    );
    document.getElementById("autonomousBtn").addEventListener("click", () =>
      runAction("autonomous", { maxRounds: maxRoundsInput.value.trim() || undefined }, "只跑全自動")
    );
    document.getElementById("doctorBtn").addEventListener("click", () => runAction("doctor", {}, "環境健康檢查"));

    refreshStatus().catch((error) => {
      setLog("初始化狀態讀取失敗", { error: error instanceof Error ? error.message : String(error) });
    });
  </script>
</body>
</html>`;
}

async function handleRequest(request, response, state) {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && requestUrl.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(renderPanelHtml(state.workspaceRoot));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/status") {
    const overview = await buildWorkspaceOverview(state.workspaceRoot);
    sendJson(response, 200, {
      ok: true,
      overview
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/action") {
    const body = await readJsonRequestBody(request);
    const action = typeof body.action === "string" ? body.action : "";

    if (action.trim().length === 0) {
      throw createUserError("Please provide an action.");
    }

    const result = await handlePanelAction(state, action.trim(), body.payload ?? {});
    const overview = await buildWorkspaceOverview(state.workspaceRoot);

    sendJson(response, 200, {
      ok: true,
      action,
      result,
      overview
    });
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: `Unknown route: ${request.method} ${requestUrl.pathname}`
  });
}

export async function startPanelServer({
  workspaceDir = ".",
  host = DEFAULT_PANEL_HOST,
  port = DEFAULT_PANEL_PORT
} = {}) {
  const state = {
    workspaceRoot: resolvePanelWorkspace(workspaceDir)
  };
  const server = http.createServer((request, response) => {
    handleRequest(request, response, state).catch((error) => {
      const statusCode = readStatusCode(error) ?? 500;
      sendJson(response, statusCode, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    workspaceRoot: state.workspaceRoot,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}
