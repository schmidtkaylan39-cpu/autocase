import http from "node:http";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
import { readDispatchResultsArtifact, readRunStateArtifact } from "./control-plane-artifacts.mjs";
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
  "End point: Create artifacts/reports/summary.md from local sales.json.",
  "Success criteria: artifacts/reports/summary.md exists; summary.md includes daily totals; summary.md includes anomaly notes; summary.md stays inside the local workspace.",
  "Input source: sales.json.",
  "Out of scope: do not modify sales.json; do not send email; do not call external APIs."
].join("\n");
const QUICK_START_CONFIRMATION_TOKEN_SAFE = "我確認起點與終點";
const QUICK_START_RUN_EVIDENCE_FILENAME = "quick-start-run-evidence.json";

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
  const runState = await readRunStateArtifact(runStatePath).catch(() => null);

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

function formatWorkspaceRelativePath(workspaceRoot, targetPath) {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    return null;
  }

  const resolvedTargetPath = path.resolve(targetPath);
  const relativePath = path.relative(workspaceRoot, resolvedTargetPath);

  if (relativePath.length === 0) {
    return ".";
  }

  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.replaceAll("\\", "/");
  }

  return resolvedTargetPath;
}

function normalizePathCandidateToken(value) {
  return String(value ?? "")
    .trim()
    .replace(/^["'([{<]+/, "")
    .replace(/["')\]}>.,;:]+$/, "")
    .trim();
}

function extractPathLikeTokens(value) {
  if (!nonEmptyText(value)) {
    return [];
  }

  const matches =
    String(value).match(
      /(?:[A-Za-z]:\\[^\s"'`<>|]+|(?:\.{0,2}[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,8})/g
    ) ?? [];

  return dedupeTextList(matches.map((item) => normalizePathCandidateToken(item)));
}

function resolveWorkspaceCandidatePath(workspaceRoot, token) {
  const normalizedToken = normalizePathCandidateToken(token);

  if (!nonEmptyText(normalizedToken)) {
    return null;
  }

  return path.isAbsolute(normalizedToken)
    ? path.resolve(normalizedToken)
    : path.resolve(workspaceRoot, normalizedToken);
}

async function captureFileSnapshot(filePath) {
  const resolvedFilePath = path.resolve(filePath);

  try {
    const details = await stat(resolvedFilePath);
    const content = await readFile(resolvedFilePath);
    return {
      path: resolvedFilePath,
      exists: true,
      size: details.size,
      modifiedAt: details.mtime.toISOString(),
      sha256: createHash("sha256").update(content).digest("hex")
    };
  } catch {
    return {
      path: resolvedFilePath,
      exists: false,
      size: null,
      modifiedAt: null,
      sha256: null
    };
  }
}

function summarizeTextHighlights(text, maxItems = 5) {
  return String(text ?? "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxItems)
    .map((line) => (line.length > 180 ? `${line.slice(0, 177)}...` : line));
}

async function readTextHighlights(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return summarizeTextHighlights(text);
  } catch {
    return [];
  }
}

function outputCandidateScore(candidatePath) {
  const normalizedPath = String(candidatePath ?? "").replaceAll("\\", "/").toLowerCase();
  let score = 0;

  if (normalizedPath.includes("artifacts/")) {
    score += 6;
  }
  if (normalizedPath.includes("/generated/") || normalizedPath.includes("/reports/") || normalizedPath.includes("/output")) {
    score += 4;
  }
  if (/\.(md|html|txt|csv|json|pdf)$/i.test(normalizedPath)) {
    score += 3;
  }
  if (/summary|report|result|output/i.test(normalizedPath)) {
    score += 3;
  }
  if (/\.json$/i.test(normalizedPath)) {
    score -= 1;
  }

  return score;
}

function inferQuickStartOutputPathFromPreview(preview, workspaceRoot) {
  const candidateTokens = dedupeTextList([
    ...extractPathLikeTokens(preview?.endPoint?.goal),
    ...summarizeStructuredItems(preview?.endPoint?.successTargets, (item) => item).flatMap((item) => extractPathLikeTokens(item))
  ]);

  let bestCandidate = null;

  for (const token of candidateTokens) {
    const resolvedPath = resolveWorkspaceCandidatePath(workspaceRoot, token);

    if (!resolvedPath) {
      continue;
    }

    const candidate = {
      path: resolvedPath,
      score: outputCandidateScore(resolvedPath)
    };

    if (!bestCandidate || candidate.score > bestCandidate.score) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate?.path ?? null;
}

async function resolveQuickStartInputPathsFromPreview(preview, workspaceRoot) {
  const requestedInputs = dedupeTextList([
    ...summarizeStructuredItems(preview?.startPoint?.inputs, (item) => item),
    ...contractValues(preview?.executionContract, "inputSource")
  ]);
  const resolvedPaths = [];
  const seenPaths = new Set();

  for (const inputValue of requestedInputs) {
    const candidateTokens = extractPathLikeTokens(inputValue);
    const fallbackToken = candidateTokens.length === 0 && /\.[A-Za-z0-9]{1,8}$/.test(inputValue.trim()) ? [inputValue.trim()] : [];

    for (const token of candidateTokens.length > 0 ? candidateTokens : fallbackToken) {
      const resolvedPath = resolveWorkspaceCandidatePath(workspaceRoot, token);

      if (!resolvedPath || seenPaths.has(resolvedPath.toLowerCase())) {
        continue;
      }

      if (!(await pathExists(resolvedPath))) {
        continue;
      }

      seenPaths.add(resolvedPath.toLowerCase());
      resolvedPaths.push(resolvedPath);
    }
  }

  return resolvedPaths;
}

function buildQuickStartRunEvidencePath(runDirectory) {
  return path.join(runDirectory, QUICK_START_RUN_EVIDENCE_FILENAME);
}

function requestDisallowsInputModification(outOfScopeValues) {
  return dedupeTextList(outOfScopeValues).some((item) =>
    /\bdo not modify\b|\bdon't modify\b|\bread-only\b|不要改|不改原檔|不可修改|只讀/i.test(item)
  );
}

async function writeQuickStartRunEvidence(workspaceRoot, runDirectory, preview) {
  const inputPaths = await resolveQuickStartInputPathsFromPreview(preview, workspaceRoot);
  const inputFiles = [];

  for (const inputPath of inputPaths) {
    const snapshot = await captureFileSnapshot(inputPath);
    inputFiles.push({
      path: snapshot.path,
      exists: snapshot.exists,
      size: snapshot.size,
      modifiedAt: snapshot.modifiedAt,
      sha256: snapshot.sha256
    });
  }

  const evidence = {
    version: 1,
    createdAt: new Date().toISOString(),
    outputPath: inferQuickStartOutputPathFromPreview(preview, workspaceRoot),
    requestedInputLabels: dedupeTextList([
      ...summarizeStructuredItems(preview?.startPoint?.inputs, (item) => item),
      ...contractValues(preview?.executionContract, "inputSource")
    ]),
    requestedNoInputModification: requestDisallowsInputModification([
      ...summarizeStructuredItems(preview?.endPoint?.outOfScope, (item) => item),
      ...contractValues(preview?.executionContract, "outOfScope")
    ]),
    inputFiles
  };

  await writeFile(buildQuickStartRunEvidencePath(runDirectory), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

async function buildQuickStartResultCard(workspaceRoot, runDirectory) {
  const evidencePath = buildQuickStartRunEvidencePath(runDirectory);
  const evidence = await readJson(evidencePath).catch(() => null);

  if (!evidence || typeof evidence !== "object") {
    return null;
  }

  const inputFiles = [];

  for (const inputFile of Array.isArray(evidence.inputFiles) ? evidence.inputFiles : []) {
    const beforeSnapshot = {
      exists: inputFile?.exists === true,
      sha256: typeof inputFile?.sha256 === "string" ? inputFile.sha256 : null,
      size: Number.isFinite(inputFile?.size) ? inputFile.size : null,
      modifiedAt: typeof inputFile?.modifiedAt === "string" ? inputFile.modifiedAt : null
    };
    const afterSnapshot = await captureFileSnapshot(inputFile?.path);
    const changed =
      beforeSnapshot.exists !== afterSnapshot.exists ||
      (beforeSnapshot.exists && afterSnapshot.exists && beforeSnapshot.sha256 !== afterSnapshot.sha256);

    inputFiles.push({
      path: inputFile?.path ?? null,
      workspacePath: formatWorkspaceRelativePath(workspaceRoot, inputFile?.path ?? ""),
      before: beforeSnapshot,
      after: {
        exists: afterSnapshot.exists,
        sha256: afterSnapshot.sha256,
        size: afterSnapshot.size,
        modifiedAt: afterSnapshot.modifiedAt
      },
      changed
    });
  }

  const outputSnapshot = nonEmptyText(evidence.outputPath) ? await captureFileSnapshot(evidence.outputPath) : null;
  const outputHighlights = outputSnapshot?.exists ? await readTextHighlights(outputSnapshot.path) : [];

  return {
    evidencePath,
    requestedNoInputModification: evidence.requestedNoInputModification === true,
    requestedInputLabels: Array.isArray(evidence.requestedInputLabels) ? evidence.requestedInputLabels : [],
    didModifyInputFiles: inputFiles.length > 0 ? inputFiles.some((item) => item.changed) : null,
    modifiedInputFiles: inputFiles.filter((item) => item.changed).map((item) => item.workspacePath ?? item.path),
    inputFiles,
    outputFile: outputSnapshot
      ? {
          path: outputSnapshot.path,
          workspacePath: formatWorkspaceRelativePath(workspaceRoot, outputSnapshot.path),
          exists: outputSnapshot.exists,
          size: outputSnapshot.size,
          modifiedAt: outputSnapshot.modifiedAt,
          highlights: outputHighlights
        }
      : null
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

function extractLatestTaskNote(task) {
  if (!Array.isArray(task?.notes)) {
    return null;
  }

  for (let index = task.notes.length - 1; index >= 0; index -= 1) {
    const note = task.notes[index];

    if (nonEmptyText(note)) {
      return note.trim();
    }
  }

  return null;
}

function summarizePanelTask(task) {
  if (!task || typeof task !== "object") {
    return null;
  }

  const title = nonEmptyText(task.title) ? task.title.trim() : (nonEmptyText(task.id) ? task.id.trim() : null);

  if (!title) {
    return null;
  }

  return {
    id: nonEmptyText(task.id) ? task.id.trim() : null,
    title,
    phaseId: nonEmptyText(task.phaseId) ? task.phaseId.trim() : null,
    role: nonEmptyText(task.role) ? task.role.trim() : null,
    owner: nonEmptyText(task.owner) ? task.owner.trim() : null,
    status: nonEmptyText(task.status) ? task.status.trim() : null,
    latestNote: extractLatestTaskNote(task)
  };
}

function summarizeLatestRunActivity(runState) {
  const tasks = Array.isArray(runState?.taskLedger) ? runState.taskLedger : [];
  const currentTask =
    tasks.find((task) => task?.status === "in_progress") ??
    tasks.find((task) => task?.status === "ready") ??
    tasks.find((task) => task?.status === "waiting_retry") ??
    tasks.find((task) => task?.status === "blocked") ??
    tasks.find((task) => task?.status === "failed") ??
    tasks.find((task) => task?.status === "pending") ??
    null;
  const nextTask = tasks.find((task) => task?.status === "ready") ?? tasks.find((task) => task?.status === "pending") ?? null;
  const lastCompletedTask = [...tasks].reverse().find((task) => task?.status === "completed") ?? null;

  return {
    currentTask: summarizePanelTask(currentTask),
    nextTask: summarizePanelTask(nextTask),
    lastCompletedTask: summarizePanelTask(lastCompletedTask)
  };
}

async function buildValidationSummary(workspaceRoot) {
  const validationResultsPath = path.join(workspaceRoot, "reports", "validation-results.json");
  const validationResults = await readJson(validationResultsPath).catch(() => null);

  if (!validationResults || typeof validationResults !== "object") {
    return {
      exists: false,
      path: validationResultsPath,
      profile: null,
      readyForHuman: null,
      blockedBy: [],
      criticalGates: []
    };
  }

  return {
    exists: true,
    path: validationResultsPath,
    profile: typeof validationResults.profile === "string" ? validationResults.profile : null,
    readyForHuman: validationResults.readyForHuman === true,
    blockedBy: Array.isArray(validationResults.blockedBy)
      ? validationResults.blockedBy
          .map((reason) => (typeof reason === "string" ? reason.trim() : ""))
          .filter((reason) => reason.length > 0)
      : [],
    criticalGates: Array.isArray(validationResults.criticalGates)
      ? validationResults.criticalGates
          .map((gate) => ({
            id: typeof gate?.id === "string" ? gate.id : null,
            command: typeof gate?.command === "string" ? gate.command : null,
            category: typeof gate?.category === "string" ? gate.category : null,
            status: typeof gate?.status === "string" ? gate.status : null
          }))
          .filter((gate) => nonEmptyText(gate.command))
      : []
  };
}

function humanizeValidationBlocker(reason) {
  const text = String(reason ?? "").trim();

  if (!text) {
    return null;
  }

  if (/Validation ran with the "repo" profile only/i.test(text)) {
    return "目前只跑到 repo 級驗證，還沒有完成 release-ready。";
  }

  const failedMatch = text.match(/^Critical gate failed:\s*(.+)$/i);
  if (failedMatch) {
    return `關鍵驗證失敗：${failedMatch[1]}`;
  }

  const skippedMatch = text.match(/^Critical gate skipped:\s*(.+)$/i);
  if (skippedMatch) {
    return `關鍵驗證被跳過：${skippedMatch[1]}`;
  }

  const pendingMatch = text.match(/^Critical gate pending:\s*(.+)$/i);
  if (pendingMatch) {
    return `關鍵驗證尚未完成：${pendingMatch[1]}`;
  }

  return text;
}

function buildHumanReadinessStatus(validationSummary, latestRun) {
  const runSummary = latestRun?.summary ?? null;
  const runStatus = runSummary?.status ?? "no-run";
  const blockedTasks = Number(runSummary?.blockedTasks ?? 0);
  const failedTasks = Number(runSummary?.failedTasks ?? 0);
  const waitingRetryTasks = Number(runSummary?.waitingRetryTasks ?? 0);
  const humanUiGates = Array.isArray(validationSummary?.criticalGates)
    ? validationSummary.criticalGates.filter((gate) => gate?.category === "human-ui")
    : [];
  const uiUsable =
    humanUiGates.length > 0 ? humanUiGates.every((gate) => gate?.status === "passed") : null;
  const blockers = [];
  let state = "not-validated";
  let title = "尚未完成 release-ready 驗證";
  let message = "目前只能確認面板可開啟，還不能直接宣稱 ready for human / 可實戰。";
  let recommendedAction = "先跑 npm run selfcheck:release-ready，再決定是否交給人類。";
  let readyForHuman = false;

  if (validationSummary?.exists !== true) {
    blockers.push("尚未執行 release-ready gate。");
  } else if (validationSummary.readyForHuman === true) {
    state = "ready";
    title = "已達 ready for human";
    message = "release-ready gate 已通過，這一版可以交給人類操作或對外稱可實戰。";
    recommendedAction = "可直接交給人類操作。";
    readyForHuman = true;
  } else if (validationSummary.profile !== "release-ready") {
    blockers.push("目前只有 repo 級驗證，還沒有 release-ready。");
  } else {
    state = "not-ready";
    title = "未達 ready for human";
    message = "release-ready 已經跑過，但目前仍有 blocker，先不要直接交給人類。";
    recommendedAction = "先修正 blocker，再重跑 release-ready gate。";

    for (const reason of validationSummary.blockedBy ?? []) {
      const humanized = humanizeValidationBlocker(reason);

      if (humanized) {
        blockers.push(humanized);
      }
    }

    if (blockers.length === 0) {
      blockers.push("release-ready 尚未通過。");
    }
  }

  if (runStatus === "attention_required" || blockedTasks > 0 || failedTasks > 0) {
    blockers.push("最新 run 目前需要人工處理。");
    if (state === "ready") {
      state = "not-ready";
      title = "未達 ready for human";
      message = "雖然 release-ready 曾通過，但目前最新 run 需要人工處理，先不要直接交給人類。";
      recommendedAction = "先處理最新 run 的阻塞，再重新驗證。";
      readyForHuman = false;
    } else {
      recommendedAction = "先看右側目前狀態與操作紀錄，處理最新 run 的阻塞。";
    }
  } else if (waitingRetryTasks > 0) {
    blockers.push("最新 run 正在等待自動重試。");
    if (state === "ready") {
      state = "not-ready";
      title = "未達 ready for human";
      message = "最新 run 還在等待自動重試，先不要直接交給人類。";
      readyForHuman = false;
    }
    recommendedAction = "先等待自動重試完成，或按 Resume now。";
  } else if (runStatus === "in_progress" || runStatus === "planned" || runStatus === "ready") {
    blockers.push("最新 run 尚未完成。");
    if (state === "ready") {
      state = "not-ready";
      title = "未達 ready for human";
      message = "最新 run 還在進行中，先不要直接交給人類。";
      recommendedAction = "先等這一輪完成，再重新確認。";
      readyForHuman = false;
    }
  }

  const dedupedBlockers = dedupeTextList(blockers);

  return {
    state,
    title,
    message,
    recommendedAction,
    readyForHuman,
    uiUsable,
    uiUsableState: uiUsable === true ? "verified" : (uiUsable === false ? "not-verified" : "unknown"),
    validationProfile: validationSummary?.profile ?? null,
    blockers: dedupedBlockers
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
  const validationSummary = await buildValidationSummary(normalizedWorkspaceRoot);
  const intake = await loadIntakeArtifacts(normalizedWorkspaceRoot).catch(() => ({
    exists: false,
    artifactPaths: null,
    spec: null
  }));
  const latestRunStatePath = await findLatestRunStatePath(normalizedWorkspaceRoot);
  let latestRun = null;

  if (latestRunStatePath) {
    const runState = await readRunStateArtifact(latestRunStatePath).catch(() => null);

    if (runState) {
      const runDirectory = path.dirname(latestRunStatePath);
      const reportPath = path.join(runDirectory, "report.md");
      const defaultHandoffIndexPath = await resolveDefaultHandoffIndexPath(latestRunStatePath).catch(() => null);
      const quickStartResultCard = await buildQuickStartResultCard(normalizedWorkspaceRoot, runDirectory).catch(() => null);
      const autonomousDebug = await loadAutonomousDebugSnapshot(runDirectory);

      latestRun = {
        runDirectory,
        runStatePath: latestRunStatePath,
        reportPath,
        handoffIndexPath: defaultHandoffIndexPath,
        summary: summarizeRunState(runState),
        waitingRetry: summarizeWaitingRetryTasks(runState),
        activity: summarizeLatestRunActivity(runState),
        quickStartResultCard,
        autonomousDebug
      };
    }
  }

  return {
    workspaceRoot: normalizedWorkspaceRoot,
    defaults,
    validationSummary,
    humanReadiness: buildHumanReadinessStatus(validationSummary, latestRun),
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

  const dispatchResults = await readDispatchResultsArtifact(dispatchResultsPath);
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

      const expectedConfirmationText = String(
        nonEmptyText(preview.confirmationToken) ? preview.confirmationToken : QUICK_START_CONFIRMATION_TOKEN_SAFE
      )
        .trim()
        .normalize("NFC");
      const normalizedConfirmationText = confirmationText.normalize("NFC");

      if (
        normalizedConfirmationText !== expectedConfirmationText &&
        normalizedConfirmationText !== QUICK_START_CONFIRMATION_TOKEN_SAFE.normalize("NFC")
      ) {
        throw createUserError(
          [
            "Human confirmation is required before execution.",
            `Please type this exact confirmation text: ${expectedConfirmationText}`,
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
      const runDirectory = path.dirname(runResult.statePath);
      await writeQuickStartRunEvidence(state.workspaceRoot, runDirectory, preview);
      const autonomousResult = await runAutonomousLoop(runResult.statePath, {
        doctorReportPath: path.join(defaults.reportsDir, "runtime-doctor.json"),
        handoffOutputDir: path.join(runDirectory, "handoffs"),
        maxRounds
      });
      const outcome = summarizeAutonomousOutcome(autonomousResult.summary);
      const resultCard = await buildQuickStartResultCard(state.workspaceRoot, runDirectory).catch(() => null);

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
        outcome,
        resultCard
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
    html, body { max-width:100%; overflow-x:hidden; }
    body { margin:0; font-family:"Noto Sans TC","Microsoft JhengHei",ui-sans-serif,system-ui,sans-serif; color:var(--ink); background:radial-gradient(circle at 0% 0%, rgba(15,157,122,.08), transparent 45%),radial-gradient(circle at 100% 100%, rgba(30,94,157,.08), transparent 45%),var(--bg); }
    .shell { width:min(100%, 860px); max-width:860px; margin:0 auto; padding:22px 16px 28px; display:grid; gap:14px; grid-template-columns:minmax(0,1fr); }
    .hero { grid-column:1/-1; background:linear-gradient(160deg,#f7fcff,#f5fdfa); border:1px solid var(--line); border-radius:18px; padding:16px 18px; box-shadow:0 8px 20px rgba(16,54,87,.08); }
    .hero h1 { margin:0 0 6px; font-size:1.35rem; letter-spacing:.01em; }
    .hero p { margin:0; color:var(--sub); line-height:1.6; }
    .steps { margin:10px 0 0; padding-left:20px; color:#335374; line-height:1.6; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:14px; box-shadow:0 6px 16px rgba(16,54,87,.06); }
    .card h2 { margin:0 0 8px; font-size:1rem; }
    .hint { margin:0 0 10px; color:var(--sub); font-size:.9rem; line-height:1.55; }
    .hero, .card, .preview-block, .wizard-step, .chat-bubble, .status-progress, .grid-2, .actions, .kv { min-width:0; }
    .hero p, .hint, .steps, .preview-empty, .preview-block p, .wizard-step p, .wizard-summary p, .chat-bubble p, .progress-caption, .toast-body, .actor-banner p, .flow-step p, .kv dd { overflow-wrap:anywhere; }
    label { display:block; font-size:.84rem; color:#335374; margin-bottom:5px; font-weight:600; }
    code { display:inline-block; max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
    input, textarea { width:100%; max-width:100%; min-width:0; border:1px solid #cfdbea; border-radius:11px; padding:10px 11px; font:inherit; color:var(--ink); background:#fbfeff; }
    textarea { min-height:118px; resize:vertical; line-height:1.55; overflow-wrap:anywhere; }
    .grid-2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr)); gap:10px; }
    .actions { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr)); gap:8px; margin-top:10px; }
    .primary-actions { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .assistant-actions { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .helper-actions { margin-top:8px; }
    button { min-width:0; border:0; border-radius:11px; padding:9px 10px; font:inherit; line-height:1.4; white-space:normal; overflow-wrap:anywhere; cursor:pointer; color:#fff; background:linear-gradient(140deg,var(--accent),#13b78d); box-shadow:0 8px 18px rgba(15,157,122,.28); }
    button:hover { filter:brightness(1.03); }
    button[data-tone="neutral"] { background:linear-gradient(140deg,#4b6d93,#365374); box-shadow:0 8px 18px rgba(39,70,108,.24); }
    button[data-tone="warn"] { background:linear-gradient(140deg,#d1832f,#b2600f); box-shadow:0 8px 18px rgba(178,96,15,.24); }
    .status-pill { display:inline-flex; align-items:center; flex-wrap:wrap; max-width:100%; gap:8px; border-radius:999px; padding:7px 12px; font-size:.84rem; font-weight:600; background:rgba(18,143,98,.13); color:#136548; }
    .status-pill.warn { background:rgba(193,119,31,.16); color:#8d5112; }
    .status-pill.error { background:rgba(187,58,67,.14); color:#8d2028; }
    .preview-empty { border:1px dashed #cad7e8; border-radius:12px; padding:12px; background:#fafdff; color:var(--sub); line-height:1.6; }
    .preview-grid { display:grid; gap:10px; margin-top:10px; }
    .preview-block { border:1px solid #dde6f3; border-radius:12px; padding:12px; background:#fbfeff; }
    .preview-block h3 { margin:0 0 6px; font-size:.92rem; color:#24405d; }
    .preview-block p { margin:0; color:#18324c; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
    .preview-list { margin:0; padding-left:20px; color:#18324c; line-height:1.6; }
    .preview-meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; min-width:0; }
    .preview-chip { display:inline-flex; align-items:center; max-width:100%; border-radius:999px; padding:6px 10px; background:#eef6ff; color:#24405d; font-size:.82rem; border:1px solid #d6e4f2; overflow-wrap:anywhere; }
    .preview-chip.warn { background:rgba(193,119,31,.12); color:#8d5112; border-color:rgba(193,119,31,.22); }
    .preview-chip.ok { background:rgba(18,143,98,.12); color:#136548; border-color:rgba(18,143,98,.22); }
    .actor-banner { border:1px solid #d9e5f2; border-radius:12px; padding:12px; background:linear-gradient(160deg,#f7fbff,#f4fbf8); }
    .actor-banner strong { display:block; margin-bottom:4px; color:#17324f; }
    .actor-banner p { margin:0; color:#335374; line-height:1.6; }
    .confirm-checklist { margin:0; padding-left:20px; color:#18324c; line-height:1.7; }
    .flow-grid { display:grid; gap:8px; }
    .flow-step { border:1px solid #dbe5f0; border-radius:12px; padding:10px 12px; background:#fbfeff; }
    .flow-step.active { border-color:#2b77d1; background:#eef6ff; box-shadow:0 0 0 1px rgba(43,119,209,.08) inset; }
    .flow-step.done { border-color:rgba(18,143,98,.28); background:rgba(18,143,98,.07); }
    .flow-step h4 { margin:0 0 4px; font-size:.9rem; color:#1e3958; }
    .flow-step p { margin:0; color:#48627f; font-size:.83rem; line-height:1.55; }
    .wizard-shell { display:grid; gap:10px; }
    .wizard-step { border:1px solid #dbe5f0; border-radius:14px; padding:12px; background:#fbfeff; }
    .wizard-step h3 { margin:0 0 6px; font-size:.98rem; color:#1e3958; }
    .wizard-step p { margin:0; color:#48627f; line-height:1.6; }
    .wizard-meta { display:flex; flex-wrap:wrap; gap:8px; min-width:0; }
    .wizard-badge { display:inline-flex; align-items:center; max-width:100%; border-radius:999px; padding:6px 10px; font-size:.8rem; background:#eef6ff; border:1px solid #d6e4f2; color:#24405d; overflow-wrap:anywhere; }
    .wizard-summary { display:grid; gap:8px; }
    .wizard-summary section { border:1px solid #dbe5f0; border-radius:12px; padding:10px 12px; background:#fff; }
    .wizard-summary h4 { margin:0 0 4px; font-size:.88rem; color:#1e3958; }
    .wizard-summary p { margin:0; color:#335374; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
    .chat-bubble { border:1px solid #d9e5f2; border-radius:12px; padding:12px; background:linear-gradient(160deg,#f7fbff,#f4fbf8); }
    .chat-bubble h3 { margin:0 0 4px; font-size:.92rem; color:#1e3958; }
    .chat-bubble p { margin:0; color:#335374; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
    .inline-note { margin-top:8px; font-size:.82rem; color:#335374; line-height:1.6; }
    .kv { margin:10px 0 0; display:grid; grid-template-columns:minmax(90px,130px) minmax(0,1fr); row-gap:6px; column-gap:10px; font-size:.88rem; }
    .kv dt { color:#48627f; font-weight:600; }
    .kv dd { margin:0; word-break:break-word; color:#142b45; }
    details { border:1px dashed #cad7e8; border-radius:12px; padding:10px; background:#fafdff; }
    details > summary { cursor:pointer; font-size:.9rem; font-weight:600; color:#365374; margin-bottom:8px; }
    .assistant-details > summary,
    .compact-details > summary { margin-bottom:0; }
    .assistant-details[open] > summary,
    .compact-details[open] > summary { margin-bottom:8px; }
    .button-hidden { display:none !important; }
    .card[hidden] { display:none; }
    pre { width:100%; max-width:100%; margin:0; padding:12px; border-radius:12px; border:1px solid #dde6f3; background:var(--code); color:#dbe6f4; font-family:"Cascadia Code",Consolas,monospace; font-size:.8rem; line-height:1.5; max-height:360px; overflow:auto; }
    .toast-stack { position:fixed; right:18px; bottom:18px; display:grid; gap:10px; z-index:9999; width:min(360px, calc(100vw - 32px)); }
    .toast { border-radius:14px; border:1px solid var(--line); background:#ffffff; box-shadow:0 16px 32px rgba(16,54,87,.18); padding:12px 14px; border-left-width:6px; }
    .toast.info { border-left-color:#2b77d1; }
    .toast.success { border-left-color:#14885f; }
    .toast.warn { border-left-color:#b2600f; }
    .toast.error { border-left-color:#bb3a43; }
    .toast-title { margin:0 0 4px; font-size:.92rem; font-weight:700; color:var(--ink); }
    .toast-body { margin:0; color:var(--sub); font-size:.84rem; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
    .status-progress { margin-top:12px; display:grid; gap:8px; }
    .progress-meta { display:flex; align-items:center; justify-content:space-between; gap:10px; color:#24405d; font-size:.88rem; font-weight:700; }
    .progress-caption { margin:0; color:#335374; font-size:.84rem; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
    .progress-track { position:relative; overflow:hidden; height:12px; border-radius:999px; border:1px solid #d7e2ef; background:#e8eef6; }
    .progress-track.warn { background:rgba(193,119,31,.10); }
    .progress-track.error { background:rgba(187,58,67,.10); }
    .progress-track.success { background:rgba(18,143,98,.10); }
    .progress-bar { height:100%; width:0%; border-radius:999px; background:linear-gradient(90deg,#2b77d1,#13b78d); transition:width .35s ease; }
    .progress-bar.active { background:linear-gradient(90deg,#2b77d1,#13b78d,#2b77d1); background-size:200% 100%; animation:progressFlow 1.1s linear infinite; }
    .progress-bar.warn { background:linear-gradient(90deg,#d1832f,#b2600f,#d1832f); background-size:200% 100%; }
    .progress-bar.error { background:linear-gradient(90deg,#d75b65,#bb3a43,#d75b65); background-size:200% 100%; }
    .progress-bar.success { background:linear-gradient(90deg,#0f9d7a,#13b78d); }
    .progress-bar.indeterminate { width:32%; animation:progressSweep 1.3s linear infinite; }
    @keyframes progressFlow { from { background-position:0 0; } to { background-position:200% 0; } }
    @keyframes progressSweep { from { transform:translateX(-120%); } to { transform:translateX(320%); } }
    @media (max-width: 900px) {
      .primary-actions,
      .assistant-actions { grid-template-columns:1fr; }
    }
    @media (max-width: 680px) {
      .shell { padding:14px 10px 18px; }
      .hero,
      .card { padding:12px; }
      .grid-2,
      .primary-actions,
      .assistant-actions,
      .kv { grid-template-columns:1fr; }
      .toast-stack { right:10px; left:10px; width:auto; }
    }
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
      <p class="hint">終點只要寫交付結果或輸出檔名；像「不要改原檔」這種限制，寫在「非範圍」就好。</p>
      <textarea id="requestInput">${escapeHtml(DEFAULT_PANEL_REQUEST_TEXT)}</textarea>
      <label for="confirmationInput" style="margin-top:10px">人工確認語句（建議先按「分析起點/終點」再貼上）</label>
      <input id="confirmationInput" placeholder="我確認起點與終點" />
      <div class="actions primary-actions" id="primaryActions">
        <button id="applyWorkspaceBtn" data-tone="neutral">套用工作區</button>
        <button id="previewIntakeBtn" data-tone="neutral">分析起點/終點</button>
        <button id="quickStartBtn" data-tone="warn">一鍵開始（推薦）</button>
        <button id="abandonTaskBtn" data-tone="warn">放棄目前任務並開新任務</button>
      </div>
    </section>

    <section class="card" id="assistantCard">
      <h2>需求確認助手</h2>
      <p class="hint">用一問一答把需求確認好，再自動套用到上方需求內容。你不需要自己整理固定格式。</p>
      <details class="assistant-details">
        <summary>打開需求確認助手</summary>
        <div class="wizard-shell">
        <div class="wizard-meta">
          <span id="assistantStepBadge" class="wizard-badge">Step 1 / 6</span>
          <span class="wizard-badge">先確認需求，再交給 Codex</span>
        </div>
        <section class="wizard-step">
          <h3 id="assistantQuestion">你要從哪裡開始處理？</h3>
          <p id="assistantHint">請直接寫資料在哪裡、目前狀態是什麼、哪些資料夾可寫入。</p>
        </section>
        <label for="assistantAnswer">目前回答</label>
        <textarea id="assistantAnswer" placeholder="例如：工作區有 rick.json，artifacts/generated 可寫入。"></textarea>
        <div id="assistantMirror" class="chat-bubble" hidden></div>
        <div id="assistantSummary" class="wizard-summary" hidden></div>
        <div class="actions assistant-actions" id="assistantActions">
          <button id="assistantBackBtn" data-tone="neutral">上一步</button>
          <button id="assistantReflectBtn" data-tone="neutral">幫我整理</button>
          <button id="assistantNextBtn">下一步</button>
          <button id="assistantApplyRunBtn" data-tone="warn">確認後一鍵開始</button>
        </div>
        <details class="compact-details helper-actions">
          <summary>更多助手操作</summary>
          <div class="actions assistant-actions" id="assistantMoreActions">
            <button id="assistantLoadBtn" data-tone="neutral">從上方需求帶入</button>
            <button id="assistantRewriteBtn" data-tone="neutral">幫我改寫</button>
            <button id="assistantApplyBtn" data-tone="neutral">只套用不開始</button>
            <button id="assistantResetBtn" data-tone="neutral">清空助手</button>
          </div>
        </details>
        </div>
      </details>
    </section>

    <section class="card" id="previewCard">
      <h2>執行前預覽</h2>
      <p class="hint" id="previewHint">先按「分析起點/終點」，結果會直接顯示在這裡，不用只看下方黑色紀錄框。</p>
      <div id="previewSummary" class="preview-empty">尚未分析。建議先確認工作區，再按「分析起點/終點」。</div>
    </section>

    <section class="card" id="startCheckCard" hidden>
      <h2>開始前檢查卡</h2>
      <p class="hint" id="startCheckHint">分析完成後，這裡會用最白話的方式告訴你：會讀什麼、會輸出什麼、以及原檔保護條件。</p>
      <div id="startCheckSummary" class="preview-empty">尚未分析，還沒有開始前檢查內容。</div>
    </section>

    <section class="card">
      <h2>目前狀態</h2>
      <div id="statusPill" class="status-pill">讀取中...</div>
      <div class="status-progress">
        <div class="progress-meta">
          <span id="progressHeadline">系統正在準備狀態...</span>
          <span id="progressPercent">0%</span>
        </div>
        <div
          id="progressTrack"
          class="progress-track"
          role="progressbar"
          aria-label="目前進度"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="0"
        >
          <div id="progressBar" class="progress-bar"></div>
        </div>
        <p id="progressCaption" class="progress-caption">狀態會自動刷新，等待系統回報最新步驟。</p>
      </div>
      <dl class="kv" id="statusDetail"></dl>
    </section>

    <section class="card" id="humanStatusCard">
      <h2>人類操作狀態</h2>
      <p class="hint" id="humanStatusHint">直接看這張，就知道現在能不能操作，以及能不能直接交給人類。</p>
      <div id="humanStatusSummary" class="preview-empty">系統正在整理目前狀態...</div>
    </section>

    <section class="card" id="resultCard" hidden>
      <h2>完成後結果卡</h2>
      <p class="hint" id="resultHint">完成後，這裡會顯示輸出檔路徑、摘要重點，以及原檔是否被改動。</p>
      <div id="resultSummary" class="preview-empty">尚無完成結果。</div>
    </section>

    <section class="card">
      <h2>進階操作（選用）</h2>
      <details>
        <summary>展開進階按鈕</summary>
        <p class="hint">只有需要手動排查時才用，平常不用。</p>
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
        <div class="actions" id="advancedActions">
          <button id="resumeNowBtn" data-tone="neutral">Resume now</button>
          <button id="refreshStatusBtn" data-tone="neutral">重新整理狀態</button>
          <button id="viewGptPromptBtn" data-tone="neutral">查看 GPT 發問內容</button>
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
  <div id="toastStack" class="toast-stack" aria-live="polite" aria-atomic="true"></div>

  <script>
    const initialWorkspace = ${serializedWorkspace};
    const workspaceInput = document.getElementById("workspaceInput");
    const workspaceTag = document.getElementById("workspaceTag");
    const requestInput = document.getElementById("requestInput");
    const runIdInput = document.getElementById("runIdInput");
    const maxRoundsInput = document.getElementById("maxRoundsInput");
    const confirmationInput = document.getElementById("confirmationInput");
    const statusPill = document.getElementById("statusPill");
    const progressHeadline = document.getElementById("progressHeadline");
    const progressPercent = document.getElementById("progressPercent");
    const progressTrack = document.getElementById("progressTrack");
    const progressBar = document.getElementById("progressBar");
    const progressCaption = document.getElementById("progressCaption");
    const statusDetail = document.getElementById("statusDetail");
    const previewCard = document.getElementById("previewCard");
    const previewHint = document.getElementById("previewHint");
    const previewSummary = document.getElementById("previewSummary");
    const startCheckCard = document.getElementById("startCheckCard");
    const startCheckHint = document.getElementById("startCheckHint");
    const startCheckSummary = document.getElementById("startCheckSummary");
    const humanStatusCard = document.getElementById("humanStatusCard");
    const humanStatusHint = document.getElementById("humanStatusHint");
    const humanStatusSummary = document.getElementById("humanStatusSummary");
    const resultCardSection = document.getElementById("resultCard");
    const resultHint = document.getElementById("resultHint");
    const resultSummary = document.getElementById("resultSummary");
    const abandonTaskBtn = document.getElementById("abandonTaskBtn");
    const assistantStepBadge = document.getElementById("assistantStepBadge");
    const assistantQuestion = document.getElementById("assistantQuestion");
    const assistantHint = document.getElementById("assistantHint");
    const assistantAnswer = document.getElementById("assistantAnswer");
    const assistantMirror = document.getElementById("assistantMirror");
    const assistantSummary = document.getElementById("assistantSummary");
    const assistantReflectBtn = document.getElementById("assistantReflectBtn");
    const assistantRewriteBtn = document.getElementById("assistantRewriteBtn");
    const assistantLoadBtn = document.getElementById("assistantLoadBtn");
    const assistantBackBtn = document.getElementById("assistantBackBtn");
    const assistantNextBtn = document.getElementById("assistantNextBtn");
    const assistantApplyBtn = document.getElementById("assistantApplyBtn");
    const assistantApplyRunBtn = document.getElementById("assistantApplyRunBtn");
    const assistantResetBtn = document.getElementById("assistantResetBtn");
    const logBox = document.getElementById("logBox");
    const toastStack = document.getElementById("toastStack");
    const resumeNowBtn = document.getElementById("resumeNowBtn");
    let latestOverview = null;
    let latestPreview = null;
    let draftingNewTask = false;
    let abandonedRunStatePath = null;
    let panelBusy = false;
    let autoResumeTimerId = null;
    let progressRefreshTimerId = null;
    let lastObservedStatusKey = null;
    let lastLoggedStatusKey = null;
    let lastLoggedProgressKey = null;
    let lastLoggedWorkspaceRoot = null;
    let scheduledAutoResumeKey = null;
    let triggeredAutoResumeKey = null;
    const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";

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

    const phaseLabelMap = {
      planning: "規劃",
      implementation: "實作",
      review: "檢查",
      verification: "驗證",
      delivery: "交付"
    };

    const assistantSteps = [
      { key: "start", title: "1. 你要從哪裡開始處理？", hint: "請寫資料在哪裡、目前狀態是什麼、哪些資料夾可寫入。" },
      { key: "end", title: "2. 最後要交付什麼？", hint: "請寫清楚輸出檔名與位置，例如 artifacts/generated/summary.md。" },
      { key: "success", title: "3. 什麼情況算成功？", hint: "請寫你要驗收的結果，可以一行一條。" },
      { key: "inputs", title: "4. 這次要用哪些輸入來源？", hint: "請列出檔名、資料夾或資料來源，可以一行一條。" },
      { key: "outOfScope", title: "5. 有哪些事情不能做？", hint: "例如不要改原檔、不要猜測、不要呼叫外部 API。" },
      { key: "review", title: "6. 確認並套用", hint: "這一步會整理成最終需求格式，確認沒問題再套用或直接開始。" }
    ];

    let assistantStepIndex = 0;
    let assistantState = {
      start: "",
      end: "",
      success: "",
      inputs: "",
      outOfScope: ""
    };

    workspaceInput.value = initialWorkspace;

    function setButtonsDisabled(disabled) {
      panelBusy = disabled;
      for (const button of document.querySelectorAll("button")) {
        button.disabled = disabled;
        button.style.opacity = disabled ? "0.65" : "1";
      }
      syncResumeNowButton();
      renderHumanStatusCard(latestOverview);
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

    function formatLogBody(value) {
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }

    function appendLogEntry(title, value, options = {}) {
      const body = formatLogBody(value);
      const entry = "[" + new Date().toLocaleString() + "] " + title + "\\n\\n" + body;
      const currentText = String(logBox.textContent ?? "").trim();
      const replace = options.replace === true;
      const placeholderTexts = ["等待操作...", "绛夊緟鎿嶄綔..."];
      const useFreshLog = replace || currentText.length === 0 || placeholderTexts.includes(currentText);

      logBox.textContent = useFreshLog ? entry : currentText + "\\n\\n---\\n\\n" + entry;
      logBox.scrollTop = logBox.scrollHeight;
    }

    function setLog(title, value) {
      appendLogEntry(title, value);
    }

    function labelForPhase(phaseId) {
      return phaseLabelMap[phaseId] || phaseId || "-";
    }

    function describeTaskActor(task) {
      if (!task || typeof task !== "object") {
        return "系統";
      }

      if (task.role === "executor") {
        return "Codex";
      }

      if (task.role === "verifier") {
        return "驗證器";
      }

      return "GPT";
    }

    function summarizeInteractionActor(overview = latestOverview) {
      const latestRun = overview?.latestRun ?? null;
      const currentTask = latestRun?.activity?.currentTask ?? null;
      const nextTask = latestRun?.activity?.nextTask ?? null;
      const runStatus = latestRun?.summary?.status ?? "no-run";
      const waitingForHumanConfirmation = overview?.intake?.exists && overview?.intake?.confirmedByUser === false;

      if (waitingForHumanConfirmation) {
        return {
          actor: "GPT",
          label: "GPT 正在跟你確認需求",
          detail: "現在還在確認起點、終點、成功指標與非範圍；這一階段尚未交給 Codex。"
        };
      }

      if (currentTask?.role === "executor") {
        return {
          actor: "Codex",
          label: "Codex 正在實作",
          detail: "目前已經離開需求確認階段，正在依你確認過的內容處理檔案。"
        };
      }

      if (currentTask?.role === "verifier") {
        return {
          actor: "驗證器",
          label: "驗證器正在檢查",
          detail: "現在不是 GPT 或 Codex 在改內容，而是自動驗證器在檢查結果是否符合標準。"
        };
      }

      if (currentTask?.role === "planner" || currentTask?.role === "reviewer" || currentTask?.role === "orchestrator") {
        return {
          actor: "GPT",
          label: "GPT 正在整理與複查",
          detail:
            runStatus === "in_progress"
              ? "目前這一輪是 GPT 在規劃、複查或整理交接，Codex 會在實作步驟才接手。"
              : "目前還在 GPT 主導的整理階段，尚未進入 Codex 實作。"
        };
      }

      if (latestRun && nextTask?.role === "executor") {
        return {
          actor: "GPT",
          label: "GPT 正在把需求整理給 Codex",
          detail: "現在是 GPT 在整理下一步，下一個接手的會是 Codex。"
        };
      }

      return {
        actor: "人類",
        label: "等待人類提供或確認需求",
        detail: "先把需求內容確認清楚，系統才會開始往下交給 GPT / Codex / 驗證器。"
      };
    }

    function renderHumanConfirmationChecklist(preview) {
      const checklist = [
        "起點是不是你真正要開始處理的資料與資料夾？",
        "終點是不是你最後真的要交付的檔名與位置？",
        "成功指標是不是你要驗收的重點結果？",
        "輸入來源是不是正確的原始檔案？",
        "非範圍有沒有寫清楚不能做的事情？",
        preview?.readyToExecute
          ? "以上都正確才按「一鍵開始（推薦）」；如果不對，先改上方需求再按「分析起點/終點」。"
          : "如果有任何一項不對，直接改上方需求再按「分析起點/終點」，不要直接開始。"
      ];

      return '<ul class="confirm-checklist">' + checklist.map((item) => "<li>" + escapeHtmlText(item) + "</li>").join("") + "</ul>";
    }

    function renderFlowSteps(activeStep = 1) {
      const steps = [
        ["GPT", "分析需求", "先把起點、終點、成功指標、輸入來源與非範圍整理出來。"],
        ["人類", "確認需求", "由你確認這是不是最終要去的地方，以及開始的地方是否正確。"],
        ["Codex", "開始實作", "只有在你確認後，Codex 才會開始處理檔案或產出結果。"],
        ["GPT", "複查結果", "GPT 會再看一次結果是否偏離你確認過的需求。"],
        ["驗證器", "自動驗證", "最後由驗證器檢查完成狀態、檔案與規則。"]
      ];

      return (
        '<div class="flow-grid">' +
        steps
          .map(([actor, title, detail], index) => {
            const stepNumber = index + 1;
            const stepClass = stepNumber === activeStep ? "flow-step active" : (stepNumber < activeStep ? "flow-step done" : "flow-step");
            return (
              '<section class="' +
              stepClass +
              '">' +
              "<h4>Step " +
              stepNumber +
              " · " +
              escapeHtmlText(actor) +
              " · " +
              escapeHtmlText(title) +
              "</h4>" +
              "<p>" +
              escapeHtmlText(detail) +
              "</p>" +
              "</section>"
            );
          })
          .join("") +
        "</div>"
      );
    }

    function sanitizeTaskNote(note) {
      if (typeof note !== "string" || note.trim().length === 0) {
        return "";
      }

      return note
        .replace(/^\\d{4}-\\d{2}-\\d{2}T[^ ]+\\s+/, (match) => formatDateTime(match.trim()) + " ")
        .replace(/^dispatch:/i, "")
        .replace(/^[a-z_]+:/i, "")
        .trim();
    }

    function formatTaskSummary(task) {
      if (!task) {
        return "-";
      }

      return labelForPhase(task.phaseId) + " / " + String(task.title || task.id || "-");
    }

    function calculateProgressPercent(summary) {
      const totalTasks = Number(summary?.totalTasks || 0);
      const completedTasks = Number(summary?.completedTasks || 0);

      if (!Number.isFinite(totalTasks) || totalTasks <= 0) {
        return 0;
      }

      const rawPercent = Math.round((completedTasks / totalTasks) * 100);
      return Math.max(0, Math.min(100, rawPercent));
    }

    function setTransientProgress(headline, caption, options = {}) {
      if (!progressHeadline || !progressPercent || !progressTrack || !progressBar || !progressCaption) {
        return;
      }

      const tone = options.tone || "info";
      const percent = Number.isFinite(options.percent) ? Math.max(0, Math.min(100, Number(options.percent))) : null;
      const indeterminate = options.indeterminate !== false && percent === null;
      const toneClass = tone === "warn" || tone === "error" || tone === "success" ? " " + tone : "";

      progressHeadline.textContent = headline || "系統處理中";
      progressPercent.textContent = indeterminate ? "..." : String(percent) + "%";
      progressCaption.textContent = caption || "請稍候，系統正在處理。";
      progressTrack.className = "progress-track" + toneClass;
      progressTrack.setAttribute("aria-valuenow", indeterminate ? "0" : String(percent));
      progressBar.className = "progress-bar" + toneClass;

      if (indeterminate) {
        progressBar.classList.add("indeterminate");
        progressBar.classList.add("active");
        progressBar.style.width = "32%";
        progressBar.style.transform = "";
        return;
      }

      progressBar.style.width = String(percent) + "%";
      progressBar.style.transform = "";
      if (options.active) {
        progressBar.classList.add("active");
      }
    }

    function summarizeRunProgress(overview) {
      const latestRun = overview?.latestRun ?? {};
      const summary = latestRun.summary ?? {};
      const activity = latestRun.activity ?? {};
      const currentTask = activity.currentTask ?? null;
      const nextTask = activity.nextTask ?? null;
      const lastCompletedTask = activity.lastCompletedTask ?? null;
      const runStatus = summary.status || "no-run";
      const completedTasks = Number(summary.completedTasks || 0);
      const progressPercent = calculateProgressPercent(summary);
      const currentTaskLabel = formatTaskSummary(currentTask);
      const currentTaskNote = sanitizeTaskNote(currentTask?.latestNote);

      if (!overview?.latestRun) {
        return {
          percent: 0,
          tone: overview?.intake?.confirmedByUser ? "success" : "info",
          active: false,
          indeterminate: false,
          headline: overview?.intake?.confirmedByUser ? "需求已確認，等待開始" : "等待人類開始",
          caption: overview?.intake?.confirmedByUser
            ? "已完成需求確認，按下「一鍵開始（推薦）」即可。"
            : "先填需求，再按「分析起點/終點」或「一鍵開始（推薦）」。"
        };
      }

      if (runStatus === "completed") {
        return {
          percent: 100,
          tone: "success",
          active: false,
          indeterminate: false,
          headline: "已完成",
          caption: lastCompletedTask ? "最後完成步驟：" + formatTaskSummary(lastCompletedTask) : "所有步驟都已完成。"
        };
      }

      if (summary.failedTasks > 0 || summary.blockedTasks > 0 || runStatus === "attention_required") {
        return {
          percent: progressPercent,
          tone: "error",
          active: false,
          indeterminate: false,
          headline: "需要人工處理",
          caption:
            currentTask && currentTaskLabel !== "-"
              ? "停止在：" + currentTaskLabel
              : "流程已停止，請查看操作紀錄與最新 artifact。"
        };
      }

      if (summary.waitingRetryTasks > 0) {
        return {
          percent: progressPercent,
          tone: "warn",
          active: true,
          indeterminate: false,
          headline: "等待自動重試",
          caption:
            currentTask && currentTaskLabel !== "-"
              ? "目前卡在：" + currentTaskLabel
              : "系統會依排程自動重試。"
        };
      }

      if (runStatus === "in_progress" || runStatus === "planned" || runStatus === "ready") {
        let headline = "系統處理中";

        if (currentTask?.role === "planner" || currentTask?.role === "reviewer" || currentTask?.role === "orchestrator") {
          headline = describeTaskActor(currentTask) + " 正在思考";
        } else if (currentTask?.role === "executor") {
          headline = "Codex 正在處理";
        } else if (currentTask?.role === "verifier") {
          headline = "驗證器正在檢查";
        }

        let caption = currentTask && currentTaskLabel !== "-" ? "目前步驟：" + currentTaskLabel : "系統正在整理下一步。";

        if (currentTaskNote) {
          caption += "\\n最新更新：" + currentTaskNote;
        } else if (nextTask && nextTask.id !== currentTask?.id) {
          caption += "\\n下一步：" + formatTaskSummary(nextTask);
        } else if (lastCompletedTask) {
          caption += "\\n剛完成：" + formatTaskSummary(lastCompletedTask);
        }

        return {
          percent: progressPercent,
          tone: "info",
          active: true,
          indeterminate: completedTasks === 0 && runStatus === "in_progress",
          headline,
          caption
        };
      }

      return {
        percent: progressPercent,
        tone: "info",
        active: false,
        indeterminate: false,
        headline: "狀態更新",
        caption: "目前狀態：" + labelForRunStatus(runStatus)
      };
    }

    function showToast(kind, title, message, options = {}) {
      if (!toastStack) {
        return;
      }

      const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : 5000;
      const dedupeKey = options.dedupeKey ?? [kind || "info", title || "", message || ""].join(":");
      const existing = Array.from(toastStack.children).find((item) => item.dataset.toastKey === dedupeKey);

      if (existing) {
        existing.remove();
      }

      const toast = document.createElement("section");
      toast.className = "toast " + (kind || "info");
      toast.dataset.toastKey = dedupeKey;
      toast.innerHTML =
        '<p class="toast-title">' +
        escapeHtmlText(title || "系統通知") +
        '</p>' +
        '<p class="toast-body">' +
        escapeHtmlText(message || "") +
        '</p>';
      toastStack.appendChild(toast);

      window.setTimeout(() => {
        toast.remove();
      }, durationMs);
    }

    function summarizeOverviewStatus(overview) {
      const intakeStatus = overview?.intake?.clarificationStatus || "not-found";
      const latestRun = overview?.latestRun || null;
      const runSummary = latestRun?.summary || null;
      const runStatus = runSummary?.status || "no-run";
      const waitingRetryTasks = Number(runSummary?.waitingRetryTasks || 0);
      const blockedTasks = Number(runSummary?.blockedTasks || 0);
      const failedTasks = Number(runSummary?.failedTasks || 0);
      const completedTasks = Number(runSummary?.completedTasks || 0);
      const runId = runSummary?.runId || "-";
      const nextRetryAt = latestRun?.waitingRetry?.earliestNextRetryAt || null;
      const progressState = summarizeRunProgress(overview);
      const interactionActor = summarizeInteractionActor(overview);
      const currentTaskKey = latestRun?.activity?.currentTask?.id || latestRun?.activity?.currentTask?.title || "-";

      if (!latestRun) {
        return {
          key: ["intake", intakeStatus, "no-run"].join(":"),
          kind: intakeStatus === "confirmed" ? "success" : "info",
          title: intakeStatus === "confirmed" ? "需求已確認" : "等待開始",
          message:
            intakeStatus === "confirmed"
              ? "需求已確認，尚未建立 Run。"
              : "請先確認需求，再按一鍵開始。"
        };
      }

      if (runStatus === "completed") {
        return {
          key: ["run", runStatus, runId, completedTasks].join(":"),
          kind: "success",
          title: "執行完成",
          message: "Run " + runId + " 已完成。已完成任務數：" + completedTasks + "。"
        };
      }

      if (runStatus === "attention_required" || blockedTasks > 0 || failedTasks > 0) {
        return {
          key: ["run", runStatus, runId, currentTaskKey, blockedTasks, failedTasks].join(":"),
          kind: failedTasks > 0 ? "error" : "warn",
          title: "需要人工處理",
          message:
            "Run " +
            runId +
            " 目前需要人工處理。阻塞任務：" +
            blockedTasks +
            "；失敗任務：" +
            failedTasks +
            "。"
        };
      }

      if (waitingRetryTasks > 0) {
        return {
          key: ["run", "waiting_retry", runId, currentTaskKey, waitingRetryTasks, nextRetryAt || "-"].join(":"),
          kind: "warn",
          title: "等待自動重試",
          message: nextRetryAt
            ? "Run " +
              runId +
              " 正在等待自動重試。下一次重試時間：" +
              formatDateTime(nextRetryAt) +
              "。"
            : "Run " + runId + " 正在等待自動重試。"
        };
      }

      if (runStatus === "in_progress" || runStatus === "planned" || runStatus === "ready") {
        return {
          key: ["run", runStatus, runId, currentTaskKey].join(":"),
          kind: "info",
          title: runStatus === "in_progress" ? progressState.headline : "已建立 Run",
          message:
            runStatus === "in_progress"
              ? progressState.caption
              : "Run " + runId + " 已建立，系統正在準備下一步。"
        };
      }

      return {
        key: ["run", runStatus, runId].join(":"),
        kind: "info",
        title: "狀態更新",
        message: "Run " + runId + " 目前狀態：" + labelForRunStatus(runStatus) + "。"
      };
    }

    function maybeNotifyOverviewChange(overview) {
      const statusSummary = summarizeOverviewStatus(overview);

      if (!statusSummary) {
        return;
      }

      if (lastObservedStatusKey === null) {
        lastObservedStatusKey = statusSummary.key;
        return;
      }

      if (statusSummary.key === lastObservedStatusKey) {
        return;
      }

      lastObservedStatusKey = statusSummary.key;
      showToast(statusSummary.kind, statusSummary.title, statusSummary.message, {
        dedupeKey: statusSummary.key
      });
    }

    function summarizeOverviewProgressKey(overview) {
      const latestRun = overview?.latestRun ?? {};
      const summary = latestRun.summary ?? {};
      const currentTask = latestRun.activity?.currentTask ?? {};
      const nextTask = latestRun.activity?.nextTask ?? {};

      return [
        String(overview?.workspaceRoot ?? ""),
        String(summary.runId ?? "-"),
        String(summary.status ?? "no-run"),
        String(summary.completedTasks ?? "-"),
        String(summary.readyTasks ?? "-"),
        String(summary.pendingTasks ?? "-"),
        String(summary.waitingRetryTasks ?? "-"),
        String(summary.blockedTasks ?? "-"),
        String(summary.failedTasks ?? "-"),
        String(currentTask.id ?? currentTask.title ?? "-"),
        String(currentTask.latestNote ?? "-"),
        String(nextTask.id ?? nextTask.title ?? "-")
      ].join("::");
    }

    function shouldAutoRefreshOverview(overview = latestOverview) {
      const latestRun = overview?.latestRun ?? null;
      const runStatus = latestRun?.summary?.status ?? "no-run";
      const waitingRetryTasks = Number(latestRun?.summary?.waitingRetryTasks ?? 0);

      return (
        runStatus === "in_progress" ||
        runStatus === "planned" ||
        runStatus === "ready" ||
        waitingRetryTasks > 0
      );
    }

    function syncLiveStatusRefresh(overview = latestOverview) {
      if (shouldAutoRefreshOverview(overview)) {
        if (progressRefreshTimerId === null) {
          startProgressRefresh();
        }
        return;
      }

      stopProgressRefresh();
    }

    function syncOperationLogWithOverview(overview) {
      if (!overview?.latestRun && !overview?.intake?.exists) {
        return;
      }

      const workspaceRoot = String(overview?.workspaceRoot ?? "");
      if (lastLoggedWorkspaceRoot !== workspaceRoot) {
        lastLoggedWorkspaceRoot = workspaceRoot;
        lastLoggedStatusKey = null;
        lastLoggedProgressKey = null;
      }

      const statusSummary = summarizeOverviewStatus(overview);
      if (!statusSummary) {
        return;
      }

      const progressKey = summarizeOverviewProgressKey(overview);
      if (statusSummary.key === lastLoggedStatusKey && progressKey === lastLoggedProgressKey) {
        return;
      }

      lastLoggedStatusKey = statusSummary.key;
      lastLoggedProgressKey = progressKey;
      const latestRun = overview?.latestRun ?? {};
      const summary = latestRun.summary ?? {};
      const interactionActor = summarizeInteractionActor(overview);

      appendLogEntry((interactionActor.actor || "系統") + " 狀態更新", {
        title: statusSummary.title,
        message: statusSummary.message,
        workspace: overview.workspaceRoot,
        runId: summary.runId ?? "-",
        interactionActor: interactionActor.label,
        interactionDetail: interactionActor.detail,
        intakeStatus: labelForIntakeStatus(overview?.intake?.clarificationStatus || "not-found"),
        runStatus: labelForRunStatus(summary.status || "no-run"),
        currentTask: formatTaskSummary(latestRun.activity?.currentTask),
        currentTaskNote: sanitizeTaskNote(latestRun.activity?.currentTask?.latestNote),
        nextTask: formatTaskSummary(latestRun.activity?.nextTask),
        completedTasks: summary.completedTasks ?? 0,
        readyTasks: summary.readyTasks ?? 0,
        pendingTasks: summary.pendingTasks ?? 0,
        waitingRetryTasks: summary.waitingRetryTasks ?? 0,
        blockedTasks: summary.blockedTasks ?? 0,
        failedTasks: summary.failedTasks ?? 0
      });
    }

    function stopProgressRefresh() {

      if (progressRefreshTimerId !== null) {
        window.clearInterval(progressRefreshTimerId);
        progressRefreshTimerId = null;
      }
    }

    function startProgressRefresh(intervalMs = 3000) {
      if (progressRefreshTimerId !== null) {
        return;
      }
      progressRefreshTimerId = window.setInterval(() => {
        refreshStatus().catch(() => undefined);
      }, intervalMs);
    }

    function escapeHtmlText(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function normalizePathTokenForUi(value) {
      return String(value ?? "")
        .trim()
        .replace(/^["'([{<]+/, "")
        .replace(/["')\\]}>.,;:]+$/, "")
        .trim();
    }

    function extractPathLikeTokensForUi(value) {
      if (typeof value !== "string" || value.trim().length === 0) {
        return [];
      }

      const matches =
        value.match(
          /(?:[A-Za-z]:\\[^\\s"'<>|]+|(?:\\.{0,2}[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\\.[A-Za-z0-9]{1,8})/g
        ) ?? [];

      return [...new Set(matches.map((item) => normalizePathTokenForUi(item)).filter((item) => item.length > 0))];
    }

    function inferPreviewOutputPath(preview) {
      const candidates = [
        ...extractPathLikeTokensForUi(preview?.endPoint?.goal || ""),
        ...(Array.isArray(preview?.endPoint?.successTargets)
          ? preview.endPoint.successTargets.flatMap((item) => extractPathLikeTokensForUi(String(item ?? "")))
          : [])
      ];

      const scoredCandidates = candidates
        .map((candidate) => {
          const normalized = candidate.replaceAll("\\\\", "/").toLowerCase();
          let score = 0;

          if (normalized.includes("artifacts/")) {
            score += 6;
          }
          if (normalized.includes("/generated/") || normalized.includes("/reports/") || normalized.includes("/output")) {
            score += 4;
          }
          if (/\\.(md|html|txt|csv|json|pdf)$/i.test(normalized)) {
            score += 3;
          }
          if (/summary|report|result|output/i.test(normalized)) {
            score += 3;
          }
          if (/\\.json$/i.test(normalized)) {
            score -= 1;
          }

          return { candidate, score };
        })
        .sort((left, right) => right.score - left.score);

      return scoredCandidates[0]?.candidate ?? null;
    }

/*
    function previewProtectsOriginalInput(preview) {
      const scopeValues = Array.isArray(preview?.endPoint?.outOfScope) ? preview.endPoint.outOfScope : [];
      return scopeValues.some((item) => /\bdo not modify\b|\bdon't modify\b|\bread-only\b|不要改|不改原檔|不可修改|只讀/i.test(String(item ?? "")));
    }

    function renderStartCheckCard(preview = latestPreview) {
      if (!startCheckSummary) {
        return;
      }

      if (!preview) {
        if (startCheckCard) {
          startCheckCard.hidden = true;
        }
        startCheckSummary.className = "preview-empty";
        startCheckSummary.textContent = "尚未分析，還沒有開始前檢查內容。";
        if (startCheckHint) {
          startCheckHint.textContent = "分析完成後，這裡會用最白話的方式告訴你：會讀什麼、會輸出什麼、以及原檔保護條件。";
        }
        return;
      }

      if (startCheckCard) {
        startCheckCard.hidden = false;
      }

      const readItems = Array.isArray(preview?.startPoint?.inputs)
        ? preview.startPoint.inputs.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
        : [];
      const outputPath = inferPreviewOutputPath(preview);
      const protectsOriginalInput = previewProtectsOriginalInput(preview);

      if (startCheckHint) {
        startCheckHint.textContent = preview.readyToExecute
          ? "這張卡就是按開始前的最後白話版檢查。若有任何一項不對，先回去修改需求或重新分析。"
          : "目前還不能直接開始。請先把這張卡內容補清楚，再按開始。";
      }

      startCheckSummary.className = "preview-grid";
      startCheckSummary.innerHTML =
        '<div class="preview-meta">' +
        '<span class="' +
        (preview.readyToExecute ? "preview-chip ok" : "preview-chip warn") +
        '">' +
        escapeHtmlText(preview.readyToExecute ? "檢查完成，可開始" : "檢查未完成，先別開始") +
        "</span>" +
        "</div>" +
        '<div class="preview-block"><h3>會讀哪些檔案</h3>' +
        renderPreviewList(readItems) +
        "</div>" +
        '<div class="preview-block"><h3>會輸出哪個檔案</h3><p>' +
        escapeHtmlText(outputPath || "目前還看不出明確輸出檔名，請把終點寫清楚。") +
        "</p></div>" +
        '<div class="preview-block"><h3>是否保證不改原檔</h3><p>' +
        escapeHtmlText(
          protectsOriginalInput
            ? "有。這次需求已明確寫出不要改原檔，系統會把它當成硬限制。"
            : "目前沒有明確保證。若你不想改原檔，請在非範圍寫清楚「不要改原檔」。"
        ) +
        "</p></div>";
    }

    function buildAssistantReflection(stepKey, answer) {
      const trimmedAnswer = String(answer ?? "").trim();

      if (!trimmedAnswer) {
        return "你這一步還沒填內容，我暫時無法幫你重述。";
      }

      switch (stepKey) {
        case "start":
          return "我理解的是：這次會從「" + trimmedAnswer + "」開始處理。對嗎？";
        case "end":
          return "我理解的是：最後要交付的結果是「" + trimmedAnswer + "」。對嗎？";
        case "success":
          return "我理解的是：成功要看到的是「" + trimmedAnswer + "」。對嗎？";
        case "inputs":
          return "我理解的是：這次只會讀這些輸入來源「" + trimmedAnswer + "」。對嗎？";
        case "outOfScope":
          return "我理解的是：這些事情不能做「" + trimmedAnswer + "」。對嗎？";
        default:
          return "我理解的是：你要用這份需求開始執行。對嗎？";
      }
    }

    function rewriteAssistantAnswerForStep(stepKey, answer) {
      const items = String(answer ?? "")
        .split(/\\r?\\n|;|；|,|，/g)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const joinedItems = items.join("; ");

      if (joinedItems.length === 0) {
        return "";
      }

      switch (stepKey) {
        case "start":
          return joinedItems.startsWith("目前") ? joinedItems : "目前工作起點：" + joinedItems;
        case "end":
          return joinedItems.startsWith("輸出") || joinedItems.startsWith("Create ") ? joinedItems : "輸出檔與終點：" + joinedItems;
        case "success":
          return joinedItems.startsWith("成功要看到：") ? joinedItems : "成功要看到：" + joinedItems;
        case "inputs":
          return joinedItems.startsWith("這次只讀：") ? joinedItems : "這次只讀：" + joinedItems;
        case "outOfScope":
          return joinedItems.startsWith("不要做：") ? joinedItems : "不要做：" + joinedItems;
        default:
          return joinedItems;
      }
    }

    function renderAssistantMirror(message, title = "我理解的是…對嗎？") {
      if (!assistantMirror) {
        return;
      }

      const safeMessage = String(message ?? "").trim();

      if (safeMessage.length === 0) {
        assistantMirror.hidden = true;
        assistantMirror.innerHTML = "";
        return;
      }

      assistantMirror.hidden = false;
      assistantMirror.innerHTML = "<h3>" + escapeHtmlText(title) + "</h3><p>" + escapeHtmlText(safeMessage) + "</p>";
    }

    function renderHumanStatusCard(overview = latestOverview) {
      if (!humanStatusSummary) {
        return;
      }

      if (!overview) {
        humanStatusSummary.className = "preview-empty";
        humanStatusSummary.textContent = "系統正在整理目前狀態...";
        if (humanStatusHint) {
          humanStatusHint.textContent = "直接看這張，就知道現在能不能操作，以及能不能直接交給人類。";
        }
        return;
      }

      const readiness = overview.humanReadiness || {};
      const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
      const uiUsableText =
        readiness.uiUsable === true
          ? "最近一次 human-ui 驗證已通過。"
          : (readiness.uiUsable === false
              ? "最近一次 human-ui 驗證未通過，先不要直接交給人類。"
              : "尚未看到 human-ui 驗證結果。");
      const panelOperableText = panelBusy
        ? "面板正在送出或刷新，按鈕暫時鎖定。"
        : "目前可操作，你可以繼續填需求、分析或啟動流程。";
      const readinessText = readiness.readyForHuman
        ? "是，已達 ready for human，可直接交給人類操作。"
        : "否，現在先不要直接交給人類。";
      const validationProfile = readiness.validationProfile || "未驗證";

      if (humanStatusCard) {
        humanStatusCard.hidden = false;
      }

      humanStatusSummary.className = "preview-grid";
      humanStatusSummary.innerHTML =
        '<div class="preview-row">' +
        '<span class="preview-chip ' +
        (panelBusy ? "warn" : "ok") +
        '">面板操作：' +
        escapeHtmlText(panelBusy ? "處理中" : "可操作") +
        "</span>" +
        '<span class="preview-chip ' +
        (readiness.readyForHuman ? "ok" : "warn") +
        '">目前判定：' +
        escapeHtmlText(readiness.readyForHuman ? "已達 ready for human" : "未達 ready for human") +
        "</span>" +
        '<span class="preview-chip ' +
        (validationProfile === "release-ready" ? "ok" : "warn") +
        '">驗證層級：' +
        escapeHtmlText(validationProfile) +
        "</span>" +
        '<span class="preview-chip ' +
        (readiness.uiUsable === true ? "ok" : "warn") +
        '">UI 檢查：' +
        escapeHtmlText(readiness.uiUsable === true ? "已驗證" : "未驗證") +
        "</span>" +
        "</div>" +
        '<div class="preview-block"><h3>面板現在可不可以操作</h3><p>' +
        escapeHtmlText(panelOperableText) +
        "</p></div>" +
        '<div class="preview-block"><h3>可不可以直接交給人類</h3><p>' +
        escapeHtmlText(readinessText) +
        "</p></div>" +
        '<div class="preview-block"><h3>建議下一步</h3><p>' +
        escapeHtmlText(readiness.recommendedAction || "先看右側目前狀態，再決定下一步。") +
        "</p></div>" +
        '<div class="preview-block"><h3>UI 驗證狀態</h3><p>' +
        escapeHtmlText(uiUsableText) +
        "</p></div>" +
        '<div class="preview-block"><h3>目前阻塞原因</h3>' +
        (blockers.length > 0 ? renderPreviewList(blockers) : "<p>目前沒有阻塞原因。</p>") +
        "</div>";

      if (humanStatusHint) {
        humanStatusHint.textContent =
          readiness.message || "這張卡會直接告訴你現在能不能操作，以及能不能直接交給人類。";
      }
    }

    function renderResultCard(overview = latestOverview) {
      if (!resultSummary) {
        return;
      }

      const latestRun = overview?.latestRun ?? null;
      const resultCard = latestRun?.quickStartResultCard ?? null;
      const runStatus = latestRun?.summary?.status ?? "no-run";

      if (!resultCard) {
        if (resultCardSection) {
          resultCardSection.hidden = true;
        }
        resultSummary.className = "preview-empty";
        resultSummary.textContent = "尚無完成結果。";
        if (resultHint) {
          resultHint.textContent = "完成後，這裡會顯示輸出檔路徑、摘要重點，以及原檔是否被改動。";
        }
        return;
      }

      if (resultCardSection) {
        resultCardSection.hidden = false;
      }

      const outputPath = resultCard.outputFile?.workspacePath || resultCard.outputFile?.path || "尚未判定";
      const outputHighlights = Array.isArray(resultCard.outputFile?.highlights) ? resultCard.outputFile.highlights : [];
      const inputFilesChanged =
        resultCard.didModifyInputFiles === null
          ? "目前沒有足夠 evidence 判定。"
          : (resultCard.didModifyInputFiles
              ? "有，偵測到原始輸入檔被改動。"
              : "沒有，這次沒有偵測到原始輸入檔被改動。");

      if (resultHint) {
        resultHint.textContent =
          runStatus === "completed"
            ? "這張卡是最新完成結果的白話總結。"
            : "最新 run 尚未完全完成；這裡先顯示目前已知的輸出與檢查 evidence。";
      }

      resultSummary.className = "preview-grid";
      resultSummary.innerHTML =
        '<div class="preview-meta">' +
        '<span class="' +
        (runStatus === "completed" ? "preview-chip ok" : "preview-chip warn") +
        '">' +
        escapeHtmlText(runStatus === "completed" ? "已完成結果" : "尚未完全完成") +
        "</span>" +
        (resultCard.requestedNoInputModification
          ? '<span class="preview-chip ok">需求已要求不可改原檔</span>'
          : '<span class="preview-chip warn">需求未明確要求不可改原檔</span>') +
        "</div>" +
        '<div class="preview-block"><h3>輸出檔路徑</h3><p>' +
        escapeHtmlText(outputPath) +
        "</p></div>" +
        '<div class="preview-block"><h3>摘要重點</h3>' +
        (outputHighlights.length > 0 ? renderPreviewList(outputHighlights) : "<p>輸出檔尚未產生可讀摘要。</p>") +
        "</div>" +
        '<div class="preview-block"><h3>是否改動原檔</h3><p>' +
        escapeHtmlText(inputFilesChanged) +
        "</p></div>" +
        '<div class="preview-block"><h3>檢查過的原始輸入</h3>' +
        renderPreviewList(
          Array.isArray(resultCard.inputFiles)
            ? resultCard.inputFiles.map((item) => {
                const label = item.workspacePath || item.path || "(unknown)";
                return label + (item.changed ? "（已改動）" : "（未改動）");
              })
            : []
        ) +
        "</div>";
    }

*/

    function previewProtectsOriginalInput(preview) {
      const scopeValues = Array.isArray(preview?.endPoint?.outOfScope) ? preview.endPoint.outOfScope : [];
      return scopeValues.some((item) =>
        /\bdo not modify\b|\bdon't modify\b|\bread-only\b|不要改|不改原檔|不可修改|只讀/i.test(String(item ?? ""))
      );
    }

    function renderStartCheckCard(preview = latestPreview) {
      if (!startCheckSummary) {
        return;
      }

      if (!preview) {
        if (startCheckCard) {
          startCheckCard.hidden = true;
        }
        startCheckSummary.className = "preview-empty";
        startCheckSummary.textContent = "尚未分析，還沒有開始前檢查內容。";
        if (startCheckHint) {
          startCheckHint.textContent = "分析完成後，這裡會用最白話的方式告訴你：會讀什麼、會輸出什麼、以及原檔保護條件。";
        }
        return;
      }

      if (startCheckCard) {
        startCheckCard.hidden = false;
      }

      const readItems = Array.isArray(preview?.startPoint?.inputs)
        ? preview.startPoint.inputs.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
        : [];
      const outputPath = inferPreviewOutputPath(preview);
      const protectsOriginalInput = previewProtectsOriginalInput(preview);

      if (startCheckHint) {
        startCheckHint.textContent = preview.readyToExecute
          ? "這張卡就是按開始前的最後白話版檢查。若有任何一項不對，先回去修改需求或重新分析。"
          : "目前還不能直接開始。請先把這張卡內容補清楚，再按開始。";
      }

      startCheckSummary.className = "preview-grid";
      startCheckSummary.innerHTML =
        '<div class="preview-meta">' +
        '<span class="' +
        (preview.readyToExecute ? "preview-chip ok" : "preview-chip warn") +
        '">' +
        escapeHtmlText(preview.readyToExecute ? "檢查完成，可開始" : "檢查未完成，先別開始") +
        "</span>" +
        "</div>" +
        '<div class="preview-block"><h3>會讀哪些檔案</h3>' +
        renderPreviewList(readItems) +
        "</div>" +
        '<div class="preview-block"><h3>會輸出哪個檔案</h3><p>' +
        escapeHtmlText(outputPath || "目前還看不出明確輸出檔名，請把終點寫清楚。") +
        "</p></div>" +
        '<div class="preview-block"><h3>是否保證不改原檔</h3><p>' +
        escapeHtmlText(
          protectsOriginalInput
            ? "有。這次需求已明確寫出不要改原檔，系統會把它當成硬限制。"
            : "目前沒有明確保證。若你不想改原檔，請在非範圍寫清楚「不要改原檔」。"
        ) +
        "</p></div>";
    }

    function buildAssistantReflection(stepKey, answer) {
      const trimmedAnswer = String(answer ?? "").trim();

      if (!trimmedAnswer) {
        return "你這一步還沒填內容，我暫時無法幫你重述。";
      }

      switch (stepKey) {
        case "start":
          return "我理解的是：這次會從「" + trimmedAnswer + "」開始處理。對嗎？";
        case "end":
          return "我理解的是：最後要交付的結果是「" + trimmedAnswer + "」。對嗎？";
        case "success":
          return "我理解的是：成功要看到的是「" + trimmedAnswer + "」。對嗎？";
        case "inputs":
          return "我理解的是：這次只會讀這些輸入來源「" + trimmedAnswer + "」。對嗎？";
        case "outOfScope":
          return "我理解的是：這些事情不能做「" + trimmedAnswer + "」。對嗎？";
        default:
          return "我理解的是：你要用這份需求開始執行。對嗎？";
      }
    }

    function rewriteAssistantAnswerForStep(stepKey, answer) {
      const items = String(answer ?? "")
        .split(/\\r?\\n|;|；|,|，/g)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const joinedItems = items.join("; ");

      if (joinedItems.length === 0) {
        return "";
      }

      switch (stepKey) {
        case "start":
          return joinedItems.startsWith("目前") ? joinedItems : "目前工作起點：" + joinedItems;
        case "end":
          return joinedItems.startsWith("輸出") || joinedItems.startsWith("Create ") ? joinedItems : "輸出檔與終點：" + joinedItems;
        case "success":
          return joinedItems.startsWith("成功要看到：") ? joinedItems : "成功要看到：" + joinedItems;
        case "inputs":
          return joinedItems.startsWith("這次只讀：") ? joinedItems : "這次只讀：" + joinedItems;
        case "outOfScope":
          return joinedItems.startsWith("不要做：") ? joinedItems : "不要做：" + joinedItems;
        default:
          return joinedItems;
      }
    }

    function renderAssistantMirror(message, title = "我理解的是…對嗎？") {
      if (!assistantMirror) {
        return;
      }

      const safeMessage = String(message ?? "").trim();

      if (safeMessage.length === 0) {
        assistantMirror.hidden = true;
        assistantMirror.innerHTML = "";
        return;
      }

      assistantMirror.hidden = false;
      assistantMirror.innerHTML = "<h3>" + escapeHtmlText(title) + "</h3><p>" + escapeHtmlText(safeMessage) + "</p>";
    }

    function renderHumanStatusCard(overview = latestOverview) {
      if (!humanStatusSummary) {
        return;
      }

      if (!overview) {
        humanStatusSummary.className = "preview-empty";
        humanStatusSummary.textContent = "系統正在整理目前狀態...";
        if (humanStatusHint) {
          humanStatusHint.textContent = "直接看這張，就知道現在能不能操作，以及能不能直接交給人類。";
        }
        return;
      }

      const readiness = overview.humanReadiness || {};
      const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
      const uiUsableText =
        readiness.uiUsable === true
          ? "最近一次 human-ui 驗證已通過。"
          : (readiness.uiUsable === false
              ? "最近一次 human-ui 驗證未通過，先不要直接交給人類。"
              : "尚未看到 human-ui 驗證結果。");
      const panelOperableText = panelBusy
        ? "面板正在送出或刷新，按鈕暫時鎖定。"
        : "目前可操作，你可以繼續填需求、分析或啟動流程。";
      const readinessText = readiness.readyForHuman
        ? "是，已達 ready for human，可直接交給人類操作。"
        : "否，現在先不要直接交給人類。";
      const validationProfile = readiness.validationProfile || "未驗證";

      if (humanStatusCard) {
        humanStatusCard.hidden = false;
      }

      humanStatusSummary.className = "preview-grid";
      humanStatusSummary.innerHTML =
        '<div class="preview-row">' +
        '<span class="preview-chip ' +
        (panelBusy ? "warn" : "ok") +
        '">面板操作：' +
        escapeHtmlText(panelBusy ? "處理中" : "可操作") +
        "</span>" +
        '<span class="preview-chip ' +
        (readiness.readyForHuman ? "ok" : "warn") +
        '">目前判定：' +
        escapeHtmlText(readiness.readyForHuman ? "已達 ready for human" : "未達 ready for human") +
        "</span>" +
        '<span class="preview-chip ' +
        (validationProfile === "release-ready" ? "ok" : "warn") +
        '">驗證層級：' +
        escapeHtmlText(validationProfile) +
        "</span>" +
        '<span class="preview-chip ' +
        (readiness.uiUsable === true ? "ok" : "warn") +
        '">UI 檢查：' +
        escapeHtmlText(readiness.uiUsable === true ? "已驗證" : "未驗證") +
        "</span>" +
        "</div>" +
        '<div class="preview-block"><h3>面板現在可不可以操作</h3><p>' +
        escapeHtmlText(panelOperableText) +
        "</p></div>" +
        '<div class="preview-block"><h3>可不可以直接交給人類</h3><p>' +
        escapeHtmlText(readinessText) +
        "</p></div>" +
        '<div class="preview-block"><h3>建議下一步</h3><p>' +
        escapeHtmlText(readiness.recommendedAction || "先看右側目前狀態，再決定下一步。") +
        "</p></div>" +
        '<div class="preview-block"><h3>UI 驗證狀態</h3><p>' +
        escapeHtmlText(uiUsableText) +
        "</p></div>" +
        '<div class="preview-block"><h3>目前阻塞原因</h3>' +
        (blockers.length > 0 ? renderPreviewList(blockers) : "<p>目前沒有阻塞原因。</p>") +
        "</div>";

      if (humanStatusHint) {
        humanStatusHint.textContent =
          readiness.message || "這張卡會直接告訴你現在能不能操作，以及能不能直接交給人類。";
      }
    }

    function renderResultCard(overview = latestOverview) {
      if (!resultSummary) {
        return;
      }

      const latestRun = overview?.latestRun ?? null;
      const resultCard = latestRun?.quickStartResultCard ?? null;
      const runStatus = latestRun?.summary?.status ?? "no-run";

      if (!resultCard) {
        if (resultCardSection) {
          resultCardSection.hidden = true;
        }
        resultSummary.className = "preview-empty";
        resultSummary.textContent = "尚無完成結果。";
        if (resultHint) {
          resultHint.textContent = "完成後，這裡會顯示輸出檔路徑、摘要重點，以及原檔是否被改動。";
        }
        return;
      }

      if (resultCardSection) {
        resultCardSection.hidden = false;
      }

      const outputPath = resultCard.outputFile?.workspacePath || resultCard.outputFile?.path || "尚未判定";
      const outputHighlights = Array.isArray(resultCard.outputFile?.highlights) ? resultCard.outputFile.highlights : [];
      const inputFilesChanged =
        resultCard.didModifyInputFiles === null
          ? "目前沒有足夠 evidence 判定。"
          : resultCard.didModifyInputFiles
            ? "有，偵測到原始輸入檔被改動。"
            : "沒有，這次沒有偵測到原始輸入檔被改動。";

      if (resultHint) {
        resultHint.textContent =
          runStatus === "completed"
            ? "這張卡是最新完成結果的白話總結。"
            : "最新 run 尚未完全完成；這裡先顯示目前已知的輸出與檢查 evidence。";
      }

      resultSummary.className = "preview-grid";
      resultSummary.innerHTML =
        '<div class="preview-meta">' +
        '<span class="' +
        (runStatus === "completed" ? "preview-chip ok" : "preview-chip warn") +
        '">' +
        escapeHtmlText(runStatus === "completed" ? "已完成結果" : "尚未完全完成") +
        "</span>" +
        (resultCard.requestedNoInputModification
          ? '<span class="preview-chip ok">需求已要求不可改原檔</span>'
          : '<span class="preview-chip warn">需求未明確要求不可改原檔</span>') +
        "</div>" +
        '<div class="preview-block"><h3>輸出檔路徑</h3><p>' +
        escapeHtmlText(outputPath) +
        "</p></div>" +
        '<div class="preview-block"><h3>摘要重點</h3>' +
        (outputHighlights.length > 0 ? renderPreviewList(outputHighlights) : "<p>輸出檔尚未產生可讀摘要。</p>") +
        "</div>" +
        '<div class="preview-block"><h3>是否改動原檔</h3><p>' +
        escapeHtmlText(inputFilesChanged) +
        "</p></div>" +
        '<div class="preview-block"><h3>檢查過的原始輸入</h3>' +
        renderPreviewList(
          Array.isArray(resultCard.inputFiles)
            ? resultCard.inputFiles.map((item) => {
                const label = item.workspacePath || item.path || "(unknown)";
                return label + (item.changed ? "（已改動）" : "（未改動）");
              })
            : []
        ) +
        "</div>";
    }

    function parseAssistantStateFromRequest(requestText) {
      const text = String(requestText ?? "");
      const readField = (patterns) => {
        for (const pattern of patterns) {
          const match = pattern.exec(text);
          if (match?.[1]) {
            return String(match[1]).trim();
          }
        }
        return "";
      };

      return {
        start: readField([/^\\s*Start\\s*:\\s*(.+)$/im, /^\\s*起點\\s*:\\s*(.+)$/im]),
        end: readField([/^\\s*End point\\s*:\\s*(.+)$/im, /^\\s*終點\\s*:\\s*(.+)$/im]),
        success: readField([/^\\s*Success criteria\\s*:\\s*(.+)$/im, /^\\s*成功指標\\s*:\\s*(.+)$/im]),
        inputs: readField([/^\\s*Input source\\s*:\\s*(.+)$/im, /^\\s*輸入來源\\s*:\\s*(.+)$/im]),
        outOfScope: readField([/^\\s*Out of scope\\s*:\\s*(.+)$/im, /^\\s*非範圍\\s*:\\s*(.+)$/im])
      };
    }

    function buildAssistantRequestText() {
      return [
        "Start: " + String(assistantState.start || "").trim(),
        "End point: " + String(assistantState.end || "").trim(),
        "Success criteria: " + String(assistantState.success || "").trim(),
        "Input source: " + String(assistantState.inputs || "").trim(),
        "Out of scope: " + String(assistantState.outOfScope || "").trim()
      ].join("\\n");
    }

    function assistantHasMinimumFields() {
      return [
        assistantState.start,
        assistantState.end,
        assistantState.success,
        assistantState.inputs,
        assistantState.outOfScope
      ].every((value) => String(value ?? "").trim().length > 0);
    }

    function renderAssistantSummary() {
      if (!assistantSummary) {
        return;
      }

      assistantSummary.hidden = assistantStepIndex !== assistantSteps.length - 1;
      if (assistantSummary.hidden) {
        assistantSummary.innerHTML = "";
        return;
      }

      const items = [
        ["起點", assistantState.start],
        ["終點", assistantState.end],
        ["成功指標", assistantState.success],
        ["輸入來源", assistantState.inputs],
        ["非範圍", assistantState.outOfScope]
      ];

      assistantSummary.innerHTML =
        '<section><h4>確認後會套用成這份需求</h4><p>' +
        escapeHtmlText(buildAssistantRequestText()) +
        "</p></section>" +
        items
          .map(([title, value]) => {
            return (
              "<section><h4>" +
              escapeHtmlText(title) +
              "</h4><p>" +
              escapeHtmlText(String(value || "(未填寫)")) +
              "</p></section>"
            );
          })
          .join("");
    }

    function renderAssistantWizard() {
      const step = assistantSteps[assistantStepIndex];
      if (!step || !assistantQuestion || !assistantHint || !assistantAnswer || !assistantStepBadge) {
        return;
      }
      const options = arguments[0] ?? {};
      const preserveMirror = options.preserveMirror === true;
      const isReviewStep = step.key === "review";
      const currentValue = isReviewStep ? buildAssistantRequestText() : String(assistantState[step.key] ?? "");
      const hasCurrentValue = currentValue.trim().length > 0;

      assistantStepBadge.textContent = "Step " + String(assistantStepIndex + 1) + " / " + String(assistantSteps.length);
      assistantQuestion.textContent = step.title;
      assistantHint.textContent = step.hint;

      if (isReviewStep) {
        assistantAnswer.hidden = true;
        assistantAnswer.value = "";
      } else {
        assistantAnswer.hidden = false;
        assistantAnswer.value = currentValue;
      }

      renderAssistantSummary();
      if (!isReviewStep && !preserveMirror) {
        renderAssistantMirror("");
      }

      if (assistantBackBtn) {
        assistantBackBtn.classList.toggle("button-hidden", assistantStepIndex === 0);
        assistantBackBtn.disabled = assistantStepIndex === 0;
      }

      if (assistantNextBtn) {
        assistantNextBtn.classList.toggle("button-hidden", isReviewStep);
        assistantNextBtn.disabled = isReviewStep ? true : !hasCurrentValue;
        assistantNextBtn.textContent = "下一步";
        assistantNextBtn.textContent = assistantStepIndex === assistantSteps.length - 1 ? "停在這步" : "下一步";
      }

      if (assistantNextBtn && !isReviewStep) {
        assistantNextBtn.textContent = "\u4e0b\u4e00\u6b65";
      }

      if (assistantReflectBtn) {
        assistantReflectBtn.disabled = step.key !== "review" && String(assistantAnswer.value || "").trim().length === 0;
      }

      if (assistantReflectBtn) {
        assistantReflectBtn.textContent = isReviewStep ? "\u6211\u7406\u89e3\u7684\u662f\u2026\u5c0d\u55ce\uff1f" : "\u5e6b\u6211\u6574\u7406";
        assistantReflectBtn.disabled = !isReviewStep && !hasCurrentValue;
      }

      if (assistantRewriteBtn) {
        assistantRewriteBtn.disabled = step.key === "review" || String(assistantAnswer.value || "").trim().length === 0;
      }

      if (assistantRewriteBtn) {
        assistantRewriteBtn.classList.toggle("button-hidden", isReviewStep);
        assistantRewriteBtn.disabled = isReviewStep || !hasCurrentValue;
      }

      if (assistantApplyBtn) {
        assistantApplyBtn.disabled = !assistantHasMinimumFields();
      }

      if (assistantApplyBtn) {
        assistantApplyBtn.classList.toggle("button-hidden", !isReviewStep);
      }

      if (assistantApplyRunBtn) {
        assistantApplyRunBtn.disabled = !assistantHasMinimumFields();
      }

      if (assistantApplyRunBtn) {
        assistantApplyRunBtn.classList.toggle("button-hidden", !isReviewStep);
      }

      if (assistantLoadBtn) {
        assistantLoadBtn.classList.toggle("button-hidden", assistantStepIndex !== 0);
      }
    }

    function persistAssistantAnswer() {
      const step = assistantSteps[assistantStepIndex];
      if (!step || step.key === "review" || !assistantAnswer) {
        return;
      }

      assistantState = {
        ...assistantState,
        [step.key]: assistantAnswer.value.trim()
      };
    }

    function loadAssistantFromRequestInput(options = {}) {
      assistantState = parseAssistantStateFromRequest(requestInput?.value ?? "");
      assistantStepIndex = 0;
      renderAssistantMirror("");
      renderAssistantWizard();
      if (!options.silent) {
        showToast("info", "已帶入需求確認助手", "我已把上方需求帶進一問一答助手。");
      }
    }

    function resetAssistantWizard() {
      assistantState = {
        start: "",
        end: "",
        success: "",
        inputs: "",
        outOfScope: ""
      };
      assistantStepIndex = 0;
      renderAssistantMirror("");
      renderAssistantWizard();
    }

    function applyAssistantToRequestInput() {
      const requestText = buildAssistantRequestText();
      requestInput.value = requestText;
      latestPreview = null;
      renderStartCheckCard(null);
      showToast("success", "已套用到需求內容", "我已把確認好的內容整理成可執行格式。");
      setLog("需求確認助手：已套用", {
        requestText,
        nextStep: "可以直接按「一鍵開始（推薦）」"
      });
    }

    function renderPreviewList(values) {
      const safeValues = Array.isArray(values)
        ? values.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
        : [];

      if (safeValues.length === 0) {
        return "<p>(未提供)</p>";
      }

      return '<ul class="preview-list">' + safeValues.map((item) => "<li>" + escapeHtmlText(item) + "</li>").join("") + "</ul>";
    }

    function renderPreviewSummary(preview, title = "分析完成") {
      if (!previewSummary) {
        return;
      }

      latestPreview = preview;
      renderStartCheckCard(preview);

      const readyChipClass = preview?.readyToExecute ? "preview-chip ok" : "preview-chip warn";
      const readyChipText = preview?.readyToExecute ? "可直接執行" : "還不能直接執行";
      const confirmationToken = String(preview?.confirmationToken ?? "").trim();
      const activeStep = preview?.readyToExecute ? 2 : 1;

      if (confirmationToken.length > 0 && confirmationInput) {
        confirmationInput.value = confirmationToken;
      }

      if (previewHint) {
        previewHint.textContent =
          title + "：請先看起點、終點、成功指標與非範圍；沒問題再按「一鍵開始（推薦）」。";
      }

      previewSummary.className = "preview-grid";
      previewSummary.innerHTML =
        '<div class="actor-banner">' +
        "<strong>目前在跟你互動的是：GPT</strong>" +
        "<p>" +
        escapeHtmlText(
          preview?.readyToExecute
            ? "現在是 GPT 把整理後的需求交給你做最後確認；你按下「一鍵開始（推薦）」前，還沒有交給 Codex。"
            : "現在還在 GPT 需求確認階段；如果起點、終點或成功指標不對，請先改上方需求再重新分析。"
        ) +
        "</p>" +
        "</div>" +
        '<div class="preview-meta">' +
        '<span class="' + readyChipClass + '">' + escapeHtmlText(readyChipText) + "</span>" +
        '<span class="preview-chip">確認語句：' + escapeHtmlText(confirmationToken || "我確認起點與終點") + "</span>" +
        "</div>" +
        '<div class="preview-block"><h3>你現在要確認什麼</h3>' + renderHumanConfirmationChecklist(preview) + "</div>" +
        '<div class="preview-block"><h3>流程細節</h3>' + renderFlowSteps(activeStep) + "</div>" +
        '<div class="preview-block"><h3>起點</h3><p>' + escapeHtmlText(preview?.startPoint?.request || "(未提供)") + "</p></div>" +
        '<div class="preview-block"><h3>終點</h3><p>' + escapeHtmlText(preview?.endPoint?.goal || "(未提供)") + "</p></div>" +
        '<div class="preview-block"><h3>成功指標</h3>' + renderPreviewList(preview?.endPoint?.successTargets) + "</div>" +
        '<div class="preview-block"><h3>輸入來源</h3>' + renderPreviewList(preview?.startPoint?.inputs) + "</div>" +
        '<div class="preview-block"><h3>非範圍</h3>' + renderPreviewList(preview?.endPoint?.outOfScope) + "</div>" +
        '<div class="inline-note">分析後我已把確認語句自動填進上方欄位。你只要確認內容正確，再按「一鍵開始（推薦）」即可。</div>';

      if (typeof previewCard?.scrollIntoView === "function") {
        previewCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }

    function renderPreviewError(message) {
      if (!previewSummary) {
        return;
      }

      latestPreview = null;
      renderStartCheckCard(null);

      if (previewHint) {
        previewHint.textContent = "分析沒有完成，請先修正需求或工作區後再試一次。";
      }

      previewSummary.className = "preview-empty";
      previewSummary.textContent = String(message ?? "分析失敗。");
    }

    function buildNewTaskDraftOverview(overview = latestOverview) {
      const workspaceRoot = overview?.workspaceRoot || workspaceInput?.value?.trim() || initialWorkspace;

      return {
        workspaceRoot,
        defaults: overview?.defaults || {
          specPath: "",
          runsDir: "",
          reportsDir: ""
        },
        intake: {
          exists: false,
          clarificationStatus: "not-found",
          confirmedByUser: false,
          recommendedNextStep: "Draft a new task and analyze start/end before execution.",
          intakeSpecPath: null,
          intakeSummaryPath: null
        },
        latestRun: null
      };
    }

    function clearDraftTaskMode() {
      draftingNewTask = false;
      abandonedRunStatePath = null;
    }

    function deriveDisplayedOverview(overview) {
      if (!draftingNewTask) {
        return overview;
      }

      const latestRunStatePath = typeof overview?.latestRun?.runStatePath === "string" ? overview.latestRun.runStatePath : null;

      if (!latestRunStatePath || (abandonedRunStatePath && latestRunStatePath === abandonedRunStatePath)) {
        return buildNewTaskDraftOverview(overview);
      }

      clearDraftTaskMode();
      return overview;
    }

    function prepareForNewTaskDraft() {
      draftingNewTask = true;
      abandonedRunStatePath = latestOverview?.latestRun?.runStatePath || abandonedRunStatePath;
      stopProgressRefresh();
      clearAutoResumeTimer();
      requestInput.value = DEFAULT_PANEL_REQUEST_TEXT;
      confirmationInput.value = "";
      runIdInput.value = "";
      latestPreview = null;
      renderPreviewError("已放棄目前任務，請輸入新需求。");
      renderStartCheckCard(null);
      renderResultCard(null);
      resetAssistantWizard();
      renderAssistantMirror("");
      logBox.textContent = "[新任務模式] 已放棄目前任務，請直接輸入新的需求內容。";
      const draftOverview = buildNewTaskDraftOverview(latestOverview);
      renderStatus(draftOverview);
      showToast("info", "已切換成新任務模式", "舊任務不再占用目前畫面，你可以直接開始填下一筆。");
    }

    function labelForRunStatus(value) { return runStatusLabelMap[value] || value || "-"; }
    function labelForIntakeStatus(value) { return intakeStatusLabelMap[value] || value || "-"; }

    function formatDateTime(value) {
      if (typeof value !== "string" || value.trim().length === 0) {
        return "-";
      }

      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime())
        ? value
        : parsed.toLocaleString(undefined, {
            hour12: false,
            timeZone: browserTimeZone
          });
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
      renderHumanStatusCard(overview);
      renderResultCard(overview);
      workspaceTag.textContent = overview.workspaceRoot;
      const intakeState = overview.intake?.clarificationStatus || "not-found";
      const runState = overview.latestRun?.summary?.status || "no-run";
      const waitingConfirm = overview.intake?.exists && overview.intake?.confirmedByUser === false;
      const waitingRetry = overview.latestRun?.waitingRetry || {};
      const progressState = summarizeRunProgress(overview);
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
      const activity = latestRun.activity || {};
      const interactionActor = summarizeInteractionActor(overview);
      const fields = [
        ["工作區", overview.workspaceRoot],
        ["規格檔", overview.defaults?.specPath || "-"],
        ["最新 Run 檔案", latestRun.runStatePath || "-"],
        ["Run ID", summary.runId || "-"],
        ["目前互動對象", interactionActor.label],
        ["需求狀態", labelForIntakeStatus(intakeState)],
        ["執行狀態", labelForRunStatus(summary.status || runState)],
        ["已完成任務", String(summary.completedTasks ?? "-")],
        ["可執行任務", String(summary.readyTasks ?? "-")],
        ["阻塞任務", String(summary.blockedTasks ?? "-")],
        ["失敗任務", String(summary.failedTasks ?? "-")]
      ];
      fields.splice(
        6,
        0,
        ["進度", String(summary.completedTasks ?? 0) + " / " + String(summary.totalTasks ?? 0) + " (" + String(progressState.percent) + "%)"],
        ["目前步驟", formatTaskSummary(activity.currentTask)],
        ["下一步", formatTaskSummary(activity.nextTask)]
      );
      fields.splice(8, 0, ["Waiting retry", String(summary.waitingRetryTasks ?? "-")]);
      fields.splice(
        9,
        0,
        ["Next retry at", waitingRetry.earliestNextRetryAt ? formatDateTime(waitingRetry.earliestNextRetryAt) : "-"]
      );
      progressHeadline.textContent = progressState.headline;
      progressPercent.textContent = progressState.indeterminate ? "..." : String(progressState.percent) + "%";
      progressCaption.textContent = interactionActor.detail + "\\n" + progressState.caption;
      progressTrack.className =
        "progress-track" +
        (progressState.tone === "warn" || progressState.tone === "error" || progressState.tone === "success"
          ? " " + progressState.tone
          : "");
      progressTrack.setAttribute("aria-valuenow", progressState.indeterminate ? "0" : String(progressState.percent));
      progressBar.className =
        "progress-bar" +
        (progressState.tone === "warn" || progressState.tone === "error" || progressState.tone === "success"
          ? " " + progressState.tone
          : "");
      if (progressState.indeterminate) {
        progressBar.classList.add("indeterminate");
        progressBar.style.width = "32%";
      } else {
        progressBar.style.width = String(progressState.percent) + "%";
        progressBar.style.transform = "";
      }
      if (progressState.active) {
        progressBar.classList.add("active");
      }
      statusDetail.innerHTML = fields
        .map(([key, value]) => "<dt>" + escapeHtmlText(key) + "</dt><dd>" + escapeHtmlText(String(value)) + "</dd>")
        .join("");
      syncResumeNowButton(overview);
      maybeNotifyOverviewChange(overview);
      syncOperationLogWithOverview(overview);
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
      const displayedOverview = deriveDisplayedOverview(overviewPayload.overview);
      renderStatus(displayedOverview);
      scheduleAutoResume(displayedOverview);
      syncLiveStatusRefresh(displayedOverview);
      return overviewPayload;
    }

    async function runAction(action, payload = {}, logTitle = action) {
      setButtonsDisabled(true);
      try {
        clearDraftTaskMode();
        setTransientProgress("系統正在處理", logTitle, {
          active: true
        });
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
        clearDraftTaskMode();
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
        clearDraftTaskMode();
        const requestText = requestInput.value.trim();
        if (requestText.length === 0) {
          throw new Error("Please paste the task text first.");
        }

        setLog("一鍵開始：正在分析需求", {
          workspace: workspaceInput.value.trim() || initialWorkspace,
          note: "系統正在檢查工作區並分析起點/終點，請稍候。"
        });
        setTransientProgress("GPT 正在思考", "正在分析起點與終點，請稍候。", {
          active: true
        });
        showToast("info", "正在分析需求", "系統正在檢查工作區並分析起點/終點。", {
          dedupeKey: "quick-start-analyzing"
        });
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
          renderPreviewSummary(preview, "分析完成，但仍需補資訊");
          setLog("Quick start paused: clarify task details first", preview);
          showToast("warn", "還不能執行", "需求仍需補資訊，請先確認預覽內容。");
          return;
        }

        renderPreviewSummary(preview, "分析完成");

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
          showToast("warn", "等待人工確認", "請輸入正確的確認語句後再繼續。");
          return;
        }

        setLog("一鍵開始：已送出執行", {
          workspace: workspaceInput.value.trim() || initialWorkspace,
          note: "系統正在建立 Run 並自動執行；右側目前狀態會自動刷新。",
          confirmationText: typedConfirmation
        });
        if (previewHint) {
          previewHint.textContent = "已送出執行，系統會自動更新右側狀態。若黑色紀錄框暫時未更新，請看右側目前狀態。";
        }
        showToast("info", "已送出執行", "系統正在建立 Run 並自動執行。", {
          dedupeKey: "quick-start-executing"
        });
        setTransientProgress("系統正在執行", "已開始自動流程，畫面會持續刷新最新步驟。", {
          percent: 5,
          active: true
        });
        startProgressRefresh();
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
        showToast(
          outcome.status === "completed" ? "success" : (outcome.status === "needs_attention" ? "warn" : "info"),
          outcome.title || "Quick start finished",
          "Run " + (quickStartResponse?.result?.run?.runId ?? "-") + " 狀態：" + (quickStartResponse?.result?.autonomous?.runSummary?.status ?? "unknown") + "。"
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLog("Quick start failed", { error: message });
        showToast("error", "一鍵開始失敗", message);
      } finally {
        stopProgressRefresh();
        setButtonsDisabled(false);
      }
    }

    async function previewIntake() {
      setButtonsDisabled(true);
      try {
        clearDraftTaskMode();
        setTransientProgress("GPT 正在思考", "正在分析起點與終點。", {
          active: true
        });
        await setWorkspace(false);
        const previewResponse = await invokeAction(
          "intake-preview",
          { request: requestInput.value },
          "Analyze start/end in plain language"
        );
        const preview = previewResponse?.result?.preview;

        if (!preview) {
          throw new Error("Intake preview is unavailable.");
        }

        renderPreviewSummary(preview, preview.readyToExecute ? "分析完成" : "分析完成，但仍需補充資訊");
        showToast(
          preview.readyToExecute ? "success" : "warn",
          preview.readyToExecute ? "分析完成" : "分析完成，但仍需補充資訊",
          preview.readyToExecute
            ? "可以直接按一鍵開始。"
            : "請先看預覽並補齊缺少的需求資訊。"
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        renderPreviewError(message);
        setLog("Analyze start/end failed", { error: message });
        showToast("error", "分析失敗", message);
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
    if (abandonTaskBtn) {
      abandonTaskBtn.addEventListener("click", () => {
        prepareForNewTaskDraft();
      });
    }
    if (assistantAnswer) {
      assistantAnswer.addEventListener("input", () => {
        renderAssistantMirror("");
        renderAssistantWizard();
      });
    }
    if (assistantReflectBtn) {
      assistantReflectBtn.addEventListener("click", () => {
        const step = assistantSteps[assistantStepIndex];
        const currentValue = step?.key === "review" ? buildAssistantRequestText() : String(assistantAnswer?.value ?? "").trim();
        if (!step) {
          return;
        }

        if (step.key === "review") {
          renderAssistantMirror(buildAssistantReflection(step.key, currentValue));
          return;
        }

        const rewritten = rewriteAssistantAnswerForStep(step.key, currentValue);
        if (assistantAnswer) {
          assistantAnswer.value = rewritten;
        }
        persistAssistantAnswer();
        renderAssistantMirror(rewritten, "我幫你整理成這樣");
        renderAssistantWizard({ preserveMirror: true });
      });
    }
    if (assistantRewriteBtn) {
      assistantRewriteBtn.addEventListener("click", () => {
        const step = assistantSteps[assistantStepIndex];
        if (!step || step.key === "review") {
          return;
        }

        const rewritten = rewriteAssistantAnswerForStep(step.key, assistantAnswer?.value ?? "");
        if (assistantAnswer) {
          assistantAnswer.value = rewritten;
        }
        persistAssistantAnswer();
        renderAssistantMirror(rewritten, "我幫你改寫成這樣");
        renderAssistantWizard({ preserveMirror: true });
      });
    }
    if (assistantLoadBtn) {
      assistantLoadBtn.addEventListener("click", () => {
        loadAssistantFromRequestInput();
      });
    }
    if (assistantBackBtn) {
      assistantBackBtn.addEventListener("click", () => {
        persistAssistantAnswer();
        assistantStepIndex = Math.max(assistantStepIndex - 1, 0);
        renderAssistantWizard();
      });
    }
    if (assistantNextBtn) {
      assistantNextBtn.addEventListener("click", () => {
        persistAssistantAnswer();
        if (assistantStepIndex < assistantSteps.length - 1) {
          assistantStepIndex += 1;
        }
        renderAssistantWizard();
      });
    }
    if (assistantApplyBtn) {
      assistantApplyBtn.addEventListener("click", () => {
        persistAssistantAnswer();
        renderAssistantWizard();
        if (!assistantHasMinimumFields()) {
          showToast("warn", "需求尚未填完", "請先完成 5 個需求步驟，再套用到上方需求內容。");
          return;
        }
        applyAssistantToRequestInput();
      });
    }
    if (assistantApplyRunBtn) {
      assistantApplyRunBtn.addEventListener("click", async () => {
        persistAssistantAnswer();
        renderAssistantWizard();
        if (!assistantHasMinimumFields()) {
          showToast("warn", "需求尚未填完", "請先完成 5 個需求步驟，再直接開始。");
          return;
        }
        applyAssistantToRequestInput();
        await runQuickStartSafe();
      });
    }
    if (assistantResetBtn) {
      assistantResetBtn.addEventListener("click", () => {
        resetAssistantWizard();
        showToast("info", "已清空助手", "可以從第 1 步重新確認需求。");
      });
    }
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
      document.getElementById("previewIntakeBtn").addEventListener("click", previewIntake);
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

    renderStartCheckCard(null);
    renderHumanStatusCard(null);
    renderResultCard(null);
    loadAssistantFromRequestInput({ silent: true });
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
