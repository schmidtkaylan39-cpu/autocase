import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  describeRuntime,
  normalizeRuntimeChecks,
  pickRuntimeForRole
} from "../src/lib/runtime-registry.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultLauncherTimeoutMs = 300000;
const defaultMaxRounds = 12;
const defaultStepTimeoutMs = 8 * 60 * 1000;
const defaultStepStallTimeoutMs = 3 * 60 * 1000;
const defaultAutonomousStepStallTimeoutMs = 10 * 60 * 1000;
const defaultAutonomousOrphanedLockIdleMs = 30 * 1000;
const defaultAttemptTimeoutMs = 20 * 60 * 1000;
const defaultOverallTimeoutMs = 2 * 60 * 60 * 1000;
const defaultHeartbeatMs = 30 * 1000;
const defaultBackoffBaseMs = 10 * 1000;
const defaultBackoffMaxMs = 90 * 1000;
const defaultRetryCircuitFailures = 3;
const defaultAcceptanceGptRunnerLauncherAttempts = 5;
const defaultAcceptanceGptRunnerRetryBaseDelayMs = 2000;
const defaultAcceptanceGptRunnerRetryMaxDelayMs = 15000;
const defaultPlannerPreflightProbeTimeoutMs = 120000;
const defaultPlannerPreflightProbeMaxBufferBytes = 2 * 1024 * 1024;
const defaultEscalatedModelDegradeRoles = Object.freeze(["planner", "reviewer", "orchestrator"]);
const acceptanceRetryPolicyGuardrail = Object.freeze({
  implementation: 3,
  review: 2,
  verification: 2,
  replanning: 2
});

function timestampLabel() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("") + "-" + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
}

function parsePositiveInteger(value, fallbackValue) {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function msToSeconds(ms) {
  return Math.round(ms / 1000);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function extractExternalOutageDiagnostics(reason = "", runtimeId = "gpt-runner") {
  const text = String(reason);
  const normalizedText = text.toLowerCase();
  const hasUpstreamSignal =
    /stream disconnected|service unavailable|unexpected status 5\d\d|503|502|tokenrouter|\/responses/.test(
      normalizedText
    );

  if (!hasUpstreamSignal) {
    return null;
  }

  const statusMatch = /\bstatus\s+(\d{3})\b/i.exec(text) ?? /\b(5\d\d)\b/.exec(text);
  const urlMatch = /\burl:\s*(https?:\/\/[^\s,]+)/i.exec(text);
  const requestIdMatch = /\brequest id:\s*([a-z0-9._:-]+)/i.exec(text);
  const upstreamUrl = urlMatch?.[1] ?? null;
  let upstreamHost = null;

  if (isNonEmptyString(upstreamUrl)) {
    try {
      upstreamHost = new URL(upstreamUrl).host;
    } catch {
      upstreamHost = null;
    }
  }

  return {
    category: "external_upstream_outage",
    runtimeId,
    httpStatus: statusMatch ? Number.parseInt(statusMatch[1], 10) : null,
    upstreamUrl,
    upstreamHost,
    requestId: requestIdMatch?.[1] ?? null
  };
}

function hasDegradedRuntimeSignal(runState = null) {
  return Array.isArray(runState?.taskLedger)
    ? runState.taskLedger.some((task) =>
        Array.isArray(task?.notes)
          ? task.notes.some((note) => /acceptance-model-degrade:/i.test(String(note)))
          : false
      )
    : false;
}

function extractDegradedNoProgressDiagnostics({ reason = "", runState = null, autonomousSummary = null } = {}) {
  const progressDiagnostics = autonomousSummary?.progressDiagnostics ?? {};
  const combinedText = [
    reason,
    autonomousSummary?.stopReason,
    progressDiagnostics?.lastProgressEvent
  ]
    .filter(isNonEmptyString)
    .join(" ")
    .toLowerCase();
  const degradedRuntimeActive = Boolean(
    progressDiagnostics?.degradedRuntimeActive || hasDegradedRuntimeSignal(runState)
  );
  const blockedTaskIds = Array.isArray(progressDiagnostics?.blockedTaskIds)
    ? progressDiagnostics.blockedTaskIds.filter(isNonEmptyString)
    : [];
  const waitingRetryTaskIds = Array.isArray(progressDiagnostics?.waitingRetryTaskIds)
    ? progressDiagnostics.waitingRetryTaskIds.filter(isNonEmptyString)
    : [];
  const skippedAutomaticTaskIds = Array.isArray(progressDiagnostics?.skippedAutomaticTaskIds)
    ? progressDiagnostics.skippedAutomaticTaskIds.filter(isNonEmptyString)
    : [];
  const consecutiveNoProgressCycles = Number.parseInt(
    progressDiagnostics?.consecutiveNoProgressCycles ?? "",
    10
  );
  const hasNoProgressSignal =
    /autonomous no-progress circuit|no-progress circuit|no progress circuit/.test(combinedText) ||
    (Number.isFinite(consecutiveNoProgressCycles) &&
      consecutiveNoProgressCycles >= 2 &&
      (blockedTaskIds.length > 0 || waitingRetryTaskIds.length > 0 || skippedAutomaticTaskIds.length > 0));

  if (!hasNoProgressSignal) {
    return null;
  }

  return {
    category: "degraded_no_progress",
    degradedRuntimeActive,
    stopReason: autonomousSummary?.stopReason ?? null,
    lastProgressAt: progressDiagnostics?.lastProgressAt ?? null,
    lastProgressTaskId: progressDiagnostics?.lastProgressTaskId ?? null,
    lastProgressEvent: progressDiagnostics?.lastProgressEvent ?? null,
    consecutiveNoProgressCycles: Number.isFinite(consecutiveNoProgressCycles)
      ? consecutiveNoProgressCycles
      : 0,
    blockedTaskIds,
    waitingRetryTaskIds,
    skippedAutomaticTaskIds
  };
}

function extractOrphanedExecutionLockDiagnostics({ reason = "", runState = null, autonomousSummary = null } = {}) {
  const text = String(reason);
  const explicitMatch =
    /orphaned_execution_lock:\s*in-progress task (\S+)\s+is pinned by dead execution lock pid=([^\s]+)\s+path="([^"]+)" while autonomous recorded no progress \(rounds=(\d+)\s+lastProgressTaskId=([^\s]+)\s+lastProgressEvent=([^)]+)\)\./i.exec(
      text
    );

  if (explicitMatch) {
    const [, taskId, rawLockPid, lockPath, rawRoundCount, rawLastProgressTaskId, rawLastProgressEvent] =
      explicitMatch;
    const parsedLockPid = Number.parseInt(rawLockPid, 10);
    return {
      category: "logic_bug",
      failureKind: "orphaned_execution_lock",
      taskId,
      lockPid: Number.isFinite(parsedLockPid) ? parsedLockPid : null,
      lockPath,
      autonomousRoundCount: Number.parseInt(rawRoundCount, 10) || 0,
      lastProgressTaskId:
        rawLastProgressTaskId === "unknown" ? null : rawLastProgressTaskId,
      lastProgressEvent:
        rawLastProgressEvent === "unknown" ? null : rawLastProgressEvent
    };
  }

  return findOrphanedExecutionLockDiagnostics({
    runState,
    autonomousSummary,
    minimumIdleMs: 0
  });
}

function parseBooleanEnv(value, fallbackValue = true) {
  if (!isNonEmptyString(value)) {
    return fallbackValue;
  }

  const normalizedValue = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "y", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalizedValue)) {
    return false;
  }

  return fallbackValue;
}

function shouldAllowEscalatedModelDegrade() {
  return parseBooleanEnv(process.env.AI_FACTORY_ACCEPTANCE_ALLOW_ESCALATED_MODEL_DEGRADE, true);
}

function classifyFailureCategory(reason = "") {
  const text = String(reason).toLowerCase();
  const upstreamOutageDiagnostics = extractExternalOutageDiagnostics(reason);

  if (upstreamOutageDiagnostics) {
    return upstreamOutageDiagnostics.category;
  }

  if (/orphaned_execution_lock|orphaned execution lock/.test(text)) {
    return "logic_bug";
  }

  if (/autonomous no-progress circuit|no-progress circuit|degraded_no_progress/.test(text)) {
    return "degraded_no_progress";
  }

  if (/rate limit|too many requests|429/.test(text)) {
    return "rate_limit";
  }

  if (/timeout|timed out|etimedout|stall|stalled/.test(text)) {
    return "timeout";
  }

  if (/missing|not found|enoent|npm ci|dependency/.test(text)) {
    return "missing_dependency";
  }

  if (/502|bad gateway|network|connection|runtime (is|was) not available|no automatic runtime was available/.test(text)) {
    return "environment_mismatch";
  }

  if (/artifact|schema|invalid json|prompt hash mismatch|idempotency key mismatch/.test(text)) {
    return "artifact_invalid";
  }

  if (/verification|test failed|lint|typecheck|build failed/.test(text)) {
    return "verification_failed";
  }

  if (/logic|state transition|stale/.test(text)) {
    return "logic_bug";
  }

  return "unknown";
}

function buildFailureFeedbackRecord({
  attemptNumber,
  attemptLabel,
  reason,
  outputRoot,
  diagnostics = null,
  categoryOverride = null,
  evidencePaths = []
}) {
  const upstreamOutageDiagnostics =
    diagnostics?.category === "external_upstream_outage"
      ? diagnostics
      : extractExternalOutageDiagnostics(reason);
  const noProgressDiagnostics =
    diagnostics?.category === "degraded_no_progress" ? diagnostics : null;
  const category =
    categoryOverride ??
    diagnostics?.category ??
    upstreamOutageDiagnostics?.category ??
    classifyFailureCategory(reason);
  const retryable = [
    "rate_limit",
    "timeout",
    "missing_dependency",
    "environment_mismatch",
    "external_upstream_outage",
    "degraded_no_progress"
  ].includes(category);

  return {
    taskId: `live-roundtrip-${String(attemptNumber).padStart(2, "0")}`,
    category,
    summary: isNonEmptyString(reason)
      ? reason
      : "Live roundtrip attempt failed without a detailed message.",
    evidence: [
      path.join(outputRoot, attemptLabel, "logs"),
      ...(Array.isArray(evidencePaths) ? evidencePaths : []).filter(isNonEmptyString)
    ],
    likelyCause:
      category === "timeout"
        ? "Launcher exceeded timeout budget during this attempt."
        : category === "external_upstream_outage"
          ? "External upstream runtime service was unavailable (for example HTTP 5xx or stream disconnects)."
          : category === "degraded_no_progress"
            ? "Autonomous execution entered a degraded path and stopped making real progress across consecutive cycles."
          : diagnostics?.failureKind === "orphaned_execution_lock"
            ? "A previous autonomous dispatch died after claiming a handoff and left behind a dead execution lock."
          : category === "environment_mismatch"
            ? "Runtime or network condition was unstable."
            : "See attempt logs for the most specific error details.",
    nextBestAction:
      category === "timeout"
        ? "Inspect attempt logs, then tune timeout only if evidence shows long-running valid work."
        : category === "external_upstream_outage"
          ? "Restore upstream service availability (or switch to an available runtime route) before retrying acceptance."
          : category === "degraded_no_progress"
            ? "Inspect autonomous-summary and run-state diagnostics, unblock the stalled task path, then rerun the same acceptance route."
          : diagnostics?.failureKind === "orphaned_execution_lock"
            ? "Recover the dead execution lock path, then rerun the same acceptance route to verify dispatch can continue."
          : "Rerun after addressing the captured failure signal.",
    diagnostics: diagnostics ?? upstreamOutageDiagnostics ?? noProgressDiagnostics,
    retryable
  };
}

function parseArgs(argv) {
  const options = {
    successes: 5,
    maxAttempts: 8,
    maxRounds: defaultMaxRounds,
    launcherTimeoutMs: defaultLauncherTimeoutMs,
    stepTimeoutMs: defaultStepTimeoutMs,
    stepStallTimeoutMs: defaultStepStallTimeoutMs,
    attemptTimeoutMs: defaultAttemptTimeoutMs,
    overallTimeoutMs: defaultOverallTimeoutMs,
    heartbeatMs: defaultHeartbeatMs,
    retryBackoffBaseMs: defaultBackoffBaseMs,
    retryBackoffMaxMs: defaultBackoffMaxMs,
    retryCircuitFailures: defaultRetryCircuitFailures,
    outputRoot: path.join(projectRoot, "reports", "acceptance", `live-roundtrip-${timestampLabel()}`)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];

    switch (argument) {
      case "--successes":
        options.successes = parsePositiveInteger(nextValue, options.successes);
        index += 1;
        break;
      case "--max-attempts":
        options.maxAttempts = parsePositiveInteger(nextValue, options.maxAttempts);
        index += 1;
        break;
      case "--max-rounds":
        options.maxRounds = parsePositiveInteger(nextValue, options.maxRounds);
        index += 1;
        break;
      case "--launcher-timeout-ms":
        options.launcherTimeoutMs = parsePositiveInteger(nextValue, options.launcherTimeoutMs);
        index += 1;
        break;
      case "--step-timeout-ms":
        options.stepTimeoutMs = parsePositiveInteger(nextValue, options.stepTimeoutMs);
        index += 1;
        break;
      case "--step-stall-timeout-ms":
        options.stepStallTimeoutMs = parsePositiveInteger(nextValue, options.stepStallTimeoutMs);
        index += 1;
        break;
      case "--attempt-timeout-ms":
        options.attemptTimeoutMs = parsePositiveInteger(nextValue, options.attemptTimeoutMs);
        index += 1;
        break;
      case "--overall-timeout-ms":
        options.overallTimeoutMs = parsePositiveInteger(nextValue, options.overallTimeoutMs);
        index += 1;
        break;
      case "--heartbeat-ms":
        options.heartbeatMs = parsePositiveInteger(nextValue, options.heartbeatMs);
        index += 1;
        break;
      case "--retry-backoff-base-ms":
        options.retryBackoffBaseMs = parsePositiveInteger(nextValue, options.retryBackoffBaseMs);
        index += 1;
        break;
      case "--retry-backoff-max-ms":
        options.retryBackoffMaxMs = parsePositiveInteger(nextValue, options.retryBackoffMaxMs);
        index += 1;
        break;
      case "--retry-circuit-failures":
        options.retryCircuitFailures = parsePositiveInteger(nextValue, options.retryCircuitFailures);
        index += 1;
        break;
      case "--output-root":
        options.outputRoot = path.resolve(projectRoot, nextValue ?? options.outputRoot);
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node scripts/live-roundtrip-acceptance.mjs [options]

Options:
  --successes <count>            Successful runs required before passing (default: 5)
  --max-attempts <count>         Maximum total attempts before failing (default: 8)
  --max-rounds <count>           Autonomous max rounds per run (default: ${defaultMaxRounds})
  --launcher-timeout-ms <ms>     Launcher timeout override for GPT/Codex/local-ci (default: ${defaultLauncherTimeoutMs})
  --step-timeout-ms <ms>         Hard timeout for each command step (default: ${defaultStepTimeoutMs})
  --step-stall-timeout-ms <ms>   Stall timeout when no output/state activity is observed (default: ${defaultStepStallTimeoutMs})
  --attempt-timeout-ms <ms>      Hard timeout for each attempt end-to-end (default: ${defaultAttemptTimeoutMs})
  --overall-timeout-ms <ms>      Hard timeout for the entire acceptance run (default: ${defaultOverallTimeoutMs})
  --heartbeat-ms <ms>            Heartbeat interval for progress logs (default: ${defaultHeartbeatMs})
  --retry-backoff-base-ms <ms>   Retry backoff base delay for retryable failures (default: ${defaultBackoffBaseMs})
  --retry-backoff-max-ms <ms>    Retry backoff max delay for retryable failures (default: ${defaultBackoffMaxMs})
  --retry-circuit-failures <n>   Consecutive retryable failures before circuit opens (default: ${defaultRetryCircuitFailures})
  --output-root <dir>            Directory for acceptance artifacts
`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.maxAttempts < options.successes) {
    options.maxAttempts = options.successes;
  }

  if (options.retryBackoffMaxMs < options.retryBackoffBaseMs) {
    options.retryBackoffMaxMs = options.retryBackoffBaseMs;
  }

  return options;
}

async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
  return targetPath;
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(targetPath) {
  return JSON.parse((await readFile(targetPath, "utf8")).replace(/^\uFEFF/, ""));
}

async function readTextFile(targetPath) {
  return (await readFile(targetPath, "utf8")).replace(/^\uFEFF/, "");
}

async function readOptionalJson(targetPath) {
  if (!isNonEmptyString(targetPath) || !(await fileExists(targetPath))) {
    return null;
  }

  try {
    return await readJson(targetPath);
  } catch {
    return null;
  }
}

function parseLockPid(lockContent) {
  const match = /^(\d+)/.exec(String(lockContent).trim());

  if (!match) {
    return null;
  }

  const parsedPid = Number.parseInt(match[1], 10);
  return Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "EINVAL")
    ) {
      return false;
    }

    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }

    return true;
  }
}

function formatOrphanedExecutionLockReason(diagnostics) {
  return (
    `orphaned_execution_lock: in-progress task ${diagnostics.taskId} ` +
    `is pinned by dead execution lock pid=${diagnostics.lockPid ?? "unknown"} ` +
    `path="${diagnostics.lockPath}" while autonomous recorded no progress ` +
    `(rounds=${diagnostics.autonomousRoundCount ?? 0} ` +
    `lastProgressTaskId=${diagnostics.lastProgressTaskId ?? "unknown"} ` +
    `lastProgressEvent=${diagnostics.lastProgressEvent ?? "unknown"}).`
  );
}

function findOrphanedExecutionLockDiagnostics({
  runState = null,
  autonomousSummary = null,
  idleMs = Number.POSITIVE_INFINITY,
  minimumIdleMs = defaultAutonomousOrphanedLockIdleMs,
  lockChecks = []
} = {}) {
  if (!runState || !Array.isArray(runState.taskLedger) || idleMs < minimumIdleMs) {
    return null;
  }

  const progressDiagnostics = autonomousSummary?.progressDiagnostics ?? {};
  const rounds = Array.isArray(autonomousSummary?.rounds) ? autonomousSummary.rounds : [];
  const hasAutonomousProgress =
    rounds.length > 0 ||
    isNonEmptyString(progressDiagnostics.lastProgressAt) ||
    isNonEmptyString(progressDiagnostics.lastProgressTaskId) ||
    isNonEmptyString(progressDiagnostics.lastProgressEvent);

  if (hasAutonomousProgress) {
    return null;
  }

  for (const task of runState.taskLedger) {
    if (task?.status !== "in_progress" || !isNonEmptyString(task?.activeResultPath)) {
      continue;
    }

    const lockCheck = lockChecks.find((candidate) => candidate.taskId === task.id && candidate.deadPid);

    if (!lockCheck) {
      continue;
    }

    return {
      category: "logic_bug",
      failureKind: "orphaned_execution_lock",
      taskId: task.id,
      lockPid: lockCheck.lockPid,
      lockPath: lockCheck.lockPath,
      lockAgeMs: lockCheck.lockAgeMs,
      runStatus: runState.status ?? null,
      autonomousFinalStatus: autonomousSummary?.finalStatus ?? null,
      autonomousRoundCount: rounds.length,
      lastProgressAt: progressDiagnostics.lastProgressAt ?? null,
      lastProgressTaskId: progressDiagnostics.lastProgressTaskId ?? null,
      lastProgressEvent: progressDiagnostics.lastProgressEvent ?? null
    };
  }

  return null;
}

async function inspectAutonomousOrphanedExecutionLock({
  runStatePath,
  autonomousSummaryPath,
  idleMs = Number.POSITIVE_INFINITY,
  minimumIdleMs = defaultAutonomousOrphanedLockIdleMs
}) {
  const runState = await readOptionalJson(runStatePath);

  if (!runState || !Array.isArray(runState.taskLedger)) {
    return null;
  }

  const autonomousSummary = await readOptionalJson(autonomousSummaryPath);
  const lockChecks = [];

  for (const task of runState.taskLedger) {
    if (task?.status !== "in_progress" || !isNonEmptyString(task?.activeResultPath)) {
      continue;
    }

    const lockPath = `${path.resolve(task.activeResultPath)}.execute.lock`;

    if (!(await fileExists(lockPath))) {
      continue;
    }

    let lockContent = "";
    let lockStats;

    try {
      [lockContent, lockStats] = await Promise.all([
        readFile(lockPath, "utf8").catch(() => ""),
        stat(lockPath)
      ]);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }

    const lockPid = parseLockPid(lockContent);
    lockChecks.push({
      taskId: task.id,
      lockPath,
      lockPid,
      lockAgeMs: Date.now() - lockStats.mtimeMs,
      deadPid: lockPid !== null && !isProcessAlive(lockPid)
    });
  }

  const diagnostics = findOrphanedExecutionLockDiagnostics({
    runState,
    autonomousSummary,
    idleMs,
    minimumIdleMs,
    lockChecks
  });

  return diagnostics
    ? {
        ...diagnostics,
        reason: formatOrphanedExecutionLockReason(diagnostics)
      }
    : null;
}

async function writeJson(targetPath, value) {
  await ensureDirectory(path.dirname(targetPath));
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(targetPath, content) {
  await ensureDirectory(path.dirname(targetPath));
  await writeFile(targetPath, content, "utf8");
}

function computeRetryBackoffMs({ failureCount, baseMs, maxMs }) {
  const normalizedFailureCount = Math.max(1, parsePositiveInteger(failureCount, 1));
  const multiplier = 2 ** (normalizedFailureCount - 1);
  const baseDelay = Math.max(1, parsePositiveInteger(baseMs, defaultBackoffBaseMs));
  const capDelay = Math.max(baseDelay, parsePositiveInteger(maxMs, defaultBackoffMaxMs));
  const jitterFactor = 0.85 + Math.random() * 0.3;
  return Math.min(capDelay, Math.round(baseDelay * multiplier * jitterFactor));
}

function tailText(value, maxChars = 1200) {
  const normalizedValue = typeof value === "string" ? value.trim() : "";

  if (!normalizedValue) {
    return "";
  }

  if (normalizedValue.length <= maxChars) {
    return normalizedValue;
  }

  return normalizedValue.slice(-maxChars);
}

async function collectAttemptFailureArtifacts({ runRoot, handoffRoot }) {
  const runStatePath = path.join(runRoot, "run-state.json");
  const autonomousSummaryPath = path.join(runRoot, "autonomous-summary.json");
  const dispatchResultsPath = path.join(handoffRoot, "dispatch-results.json");
  const runState = await readOptionalJson(runStatePath);
  const autonomousSummary = await readOptionalJson(autonomousSummaryPath);
  const dispatchResults = await readOptionalJson(dispatchResultsPath);

  return {
    runStatePath,
    autonomousSummaryPath,
    dispatchResultsPath,
    runState,
    autonomousSummary,
    dispatchResults
  };
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function escapeShellSingleQuoted(value) {
  return String(value).replace(/'/g, "'\\''");
}

async function probeGptRunnerModel({ workspaceRoot, modelId }) {
  const token = `AI_FACTORY_GPT_RUNNER_READY_${Date.now().toString(36)}`;
  const prompt = `Reply with EXACT token: ${token}`;
  const execOptions = {
    encoding: "utf8",
    windowsHide: true,
    timeout: defaultPlannerPreflightProbeTimeoutMs,
    maxBuffer: defaultPlannerPreflightProbeMaxBufferBytes
  };

  try {
    const execution =
      process.platform === "win32"
        ? await execFileAsync(
            "powershell.exe",
            [
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              [
                "$ErrorActionPreference = 'Stop'",
                `$prompt = '${escapePowerShellSingleQuoted(prompt)}'`,
                `$prompt | & codex -m '${escapePowerShellSingleQuoted(modelId)}' -a never exec -C '${escapePowerShellSingleQuoted(
                  workspaceRoot
                )}' -s workspace-write -`
              ].join("; ")
            ],
            execOptions
          )
        : await execFileAsync(
            "sh",
            [
              "-lc",
              `prompt='${escapeShellSingleQuoted(prompt)}'; printf '%s' "$prompt" | codex -m '${escapeShellSingleQuoted(
                modelId
              )}' -a never exec -C '${escapeShellSingleQuoted(workspaceRoot)}' -s workspace-write -`
            ],
            execOptions
          );
    const stdout = typeof execution?.stdout === "string" ? execution.stdout : "";
    const stderr = typeof execution?.stderr === "string" ? execution.stderr : "";
    const combined = `${stdout}\n${stderr}`;

    if (!combined.includes(token)) {
      throw new Error(
        `probe token was not returned by gpt-runner (model=${modelId}); ` +
          `stdoutTail=${tailText(stdout)} stderrTail=${tailText(stderr)}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";

    throw new Error(
      `Planner runtime preflight probe failed for gpt-runner (model=${modelId}): ${message}. ` +
        `stdoutTail=${tailText(stdout)} stderrTail=${tailText(stderr)}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

function normalizeRoleModelPolicy(rolePolicy = {}, fallbackModelId) {
  const defaultModel = isNonEmptyString(rolePolicy?.defaultModel)
    ? rolePolicy.defaultModel
    : fallbackModelId;

  return {
    ...rolePolicy,
    defaultModel,
    escalatedModel: defaultModel,
    autoSwitch: false
  };
}

async function applyEscalatedModelDegradeToRunState({
  runStatePath,
  fallbackModelId,
  reason,
  roles = defaultEscalatedModelDegradeRoles
}) {
  const runState = await readJson(runStatePath);
  const modelPolicy = {
    ...(runState.modelPolicy ?? {})
  };
  const normalizedRoles = Array.from(new Set(
    (Array.isArray(roles) ? roles : defaultEscalatedModelDegradeRoles)
      .filter((role) => isNonEmptyString(role))
  ));
  const degradationNote =
    `acceptance-model-degrade: switched to ${fallbackModelId} because escalated model was unavailable (${reason})`;

  let changed = false;

  for (const role of normalizedRoles) {
    const currentRolePolicy = modelPolicy?.[role] ?? {};
    const nextRolePolicy = normalizeRoleModelPolicy(currentRolePolicy, fallbackModelId);

    if (
      currentRolePolicy.defaultModel !== nextRolePolicy.defaultModel ||
      currentRolePolicy.escalatedModel !== nextRolePolicy.escalatedModel ||
      currentRolePolicy.autoSwitch !== nextRolePolicy.autoSwitch
    ) {
      changed = true;
    }

    modelPolicy[role] = nextRolePolicy;
  }

  const nextTaskLedger = (Array.isArray(runState.taskLedger) ? runState.taskLedger : []).map((task) => {
    if (!normalizedRoles.includes(task?.role)) {
      return task;
    }

    const nextNotes = [...(Array.isArray(task.notes) ? task.notes : []), `${new Date().toISOString()} ${degradationNote}`];
    changed = true;
    return {
      ...task,
      notes: nextNotes
    };
  });

  if (!changed) {
    return {
      changed: false,
      roles: normalizedRoles,
      fallbackModelId
    };
  }

  const nextRunState = {
    ...runState,
    updatedAt: new Date().toISOString(),
    modelPolicy,
    taskLedger: nextTaskLedger
  };
  await writeJson(runStatePath, nextRunState);

  return {
    changed: true,
    roles: normalizedRoles,
    fallbackModelId
  };
}

async function runPlannerRuntimePreflight({
  workspaceRoot,
  runStatePath,
  doctorReportPath,
  factoryConfig,
  probeGptRunner = probeGptRunnerModel,
  allowEscalatedModelDegrade = shouldAllowEscalatedModelDegrade()
}) {
  const runState = await readJson(runStatePath);
  const doctorReport = await readJson(doctorReportPath);
  const runtimeChecks = normalizeRuntimeChecks(doctorReport);
  const plannerSelection = pickRuntimeForRole("planner", runtimeChecks, runState.runtimeRouting);
  const plannerRuntime = describeRuntime(plannerSelection.runtimeId);
  const plannerStatus = runtimeChecks[plannerSelection.runtimeId];
  const gptRunnerStatus = runtimeChecks["gpt-runner"];

  if (plannerRuntime.mode !== "automated") {
    throw new Error(
      `Planner runtime preflight failed: selected runtime "${plannerSelection.runtimeId}" is ${plannerRuntime.mode}. ` +
        `planner runtime was not available for automated execution. ` +
        `selectionReason=${plannerSelection.reason}. ` +
        `gpt-runner.ok=${Boolean(gptRunnerStatus?.ok)} ` +
        `gpt-runner.source=${gptRunnerStatus?.source ?? "unknown"} ` +
        `gpt-runner.error=${gptRunnerStatus?.error ?? "none"}`
    );
  }

  if (!plannerStatus?.ok) {
    throw new Error(
      `Planner runtime preflight failed: runtime "${plannerSelection.runtimeId}" is not ready. ` +
        `planner runtime was not available. ` +
        `source=${plannerStatus?.source ?? "unknown"} error=${plannerStatus?.error ?? "unknown"} ` +
        `selectionReason=${plannerSelection.reason}`
    );
  }

  if (plannerSelection.runtimeId === "gpt-runner") {
    const plannerModelPolicy = factoryConfig?.modelPolicy?.planner ?? {};
    const plannerDefaultModel = plannerModelPolicy.defaultModel ?? "gpt-5.4";
    const plannerEscalatedModel = plannerModelPolicy.escalatedModel ?? null;
    const plannerAutoSwitch = plannerModelPolicy.autoSwitch !== false;
    await probeGptRunner({
      workspaceRoot,
      modelId: plannerDefaultModel
    });

    const shouldProbeEscalatedModel =
      plannerAutoSwitch &&
      isNonEmptyString(plannerEscalatedModel) &&
      plannerEscalatedModel !== plannerDefaultModel;

    if (shouldProbeEscalatedModel) {
      try {
        await probeGptRunner({
          workspaceRoot,
          modelId: plannerEscalatedModel
        });
      } catch (error) {
        const degradeReason = error instanceof Error ? error.message : String(error);

        if (!allowEscalatedModelDegrade) {
          throw error;
        }

        return {
          runtimeId: plannerSelection.runtimeId,
          selectionReason: plannerSelection.reason,
          degraded: true,
          degradedModels: [plannerEscalatedModel],
          degradedRoles: [...defaultEscalatedModelDegradeRoles],
          fallbackModelId: plannerDefaultModel,
          degradeReason
        };
      }
    }
  }

  return {
    runtimeId: plannerSelection.runtimeId,
    selectionReason: plannerSelection.reason,
    degraded: false,
    degradedModels: [],
    degradedRoles: [],
    fallbackModelId: null,
    degradeReason: null
  };
}

async function readLatestActivityFromPaths(paths, knownActivityMap) {
  let changed = false;

  for (const targetPath of paths) {
    if (!isNonEmptyString(targetPath)) {
      continue;
    }

    try {
      const currentStat = await stat(targetPath);
      const previousMtimeMs = knownActivityMap.get(targetPath) ?? 0;

      if (currentStat.mtimeMs > previousMtimeMs) {
        knownActivityMap.set(targetPath, currentStat.mtimeMs);
        changed = true;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  return changed;
}

async function terminateProcessTree(childPid) {
  if (!Number.isFinite(childPid) || childPid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(childPid), "/T", "/F"], {
        encoding: "utf8",
        windowsHide: true
      });
      return;
    } catch {
      // fall through
    }
  } else {
    try {
      process.kill(-childPid, "SIGKILL");
      return;
    } catch {
      // fall through
    }
  }

  try {
    process.kill(childPid, "SIGKILL");
  } catch {
    // ignore final kill failure
  }
}

function createAttemptTokens(attemptNumber) {
  const prefix = String(attemptNumber).padStart(2, "0");
  const entropy = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`.toUpperCase();
  return {
    alphaToken: `ALPHA-${prefix}-${entropy.slice(0, 8)}`,
    betaToken: `BETA-${prefix}-${entropy.slice(8, 16).padEnd(8, "0")}`
  };
}

function buildWorkspacePackageJson() {
  return {
    name: "ai-factory-live-roundtrip-acceptance",
    private: true,
    version: "1.0.0",
    scripts: {
      build: 'node -e "console.log(\'build ok\')"',
      lint: 'node -e "console.log(\'lint ok\')"',
      typecheck: 'node -e "console.log(\'typecheck ok\')"',
      test: "node scripts/verify-summary.mjs",
      "test:integration": "node scripts/verify-summary.mjs",
      "test:e2e": "node scripts/verify-summary.mjs"
    }
  };
}

function buildWorkspaceSummaryVerifierScript() {
  return `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const workspaceRoot = process.cwd();
  const summaryPath = path.join(workspaceRoot, "artifacts", "generated", "summary.md");
  const briefPath = path.join(workspaceRoot, "data", "brief.txt");
  const detailsPath = path.join(workspaceRoot, "data", "details.txt");
  const summary = await readFile(summaryPath, "utf8");
  const brief = await readFile(briefPath, "utf8");
  const details = await readFile(detailsPath, "utf8");
  const briefToken = brief.match(/Brief token:\\s*(\\S+)/)?.[1];
  const detailToken = details.match(/Details token:\\s*(\\S+)/)?.[1];

  assert.ok(briefToken, "brief token is required");
  assert.ok(detailToken, "details token is required");
  assert.match(summary, /^# Combined Notes/m, "summary must include Combined Notes heading");
  assert.match(summary, new RegExp(briefToken.replace(/[.*+?^\\\${}()|[\\]\\\\]/g, "\\\\$&")));
  assert.match(summary, new RegExp(detailToken.replace(/[.*+?^\\\${}()|[\\]\\\\]/g, "\\\\$&")));
  assert.match(summary, /\\p{Script=Han}/u, "summary should contain Chinese text");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
`;
}

function applyAcceptanceWorkspaceGuardrails(factoryConfig = {}) {
  return {
    ...factoryConfig,
    retryPolicy: {
      ...(factoryConfig.retryPolicy ?? {}),
      ...acceptanceRetryPolicyGuardrail
    }
  };
}

function buildWorkspaceSpec(attemptNumber) {
  return {
    projectName: `Live Roundtrip Acceptance ${String(attemptNumber).padStart(2, "0")}`,
    summary: "Validate real GPT and Codex roundtrip behavior against local workspace files.",
    projectGoal: {
      oneLine: "Use GPT and Codex to process local files and leave verifiable artifacts.",
      details:
        "Exercise the full automated route: GPT planning, Codex implementation, GPT review, local-ci verification, and GPT delivery packaging, all against local workspace files."
    },
    targetUsers: [
      "Operators validating autonomous runs before release",
      "Non-programmers who need auditable local-file handling"
    ],
    coreFeatures: [
      {
        id: "local-file-summary",
        title: "Summarize local files into markdown",
        description:
          "Read the local files data/brief.txt and data/details.txt. Create artifacts/generated/summary.md. The markdown must include the exact tokens found in both files, a heading named Combined Notes, and a short Chinese summary. Do not modify the input files.",
        acceptanceCriteria: [
          "artifacts/generated/summary.md exists",
          "summary.md includes the exact token from data/brief.txt",
          "summary.md includes the exact token from data/details.txt",
          "summary.md contains a heading named Combined Notes",
          "summary.md includes a short Chinese summary"
        ]
      }
    ],
    backlogFeatures: [],
    nonGoals: [
      "Do not modify the input files in data/",
      "Do not call arbitrary third-party services outside the configured runtime route"
    ],
    design: {
      tone: "Clear, concise, and operator-friendly",
      references: [],
      mobileRequired: false,
      desktopRequired: true
    },
    technicalConstraints: {
      preferredStack: ["Node.js", "Markdown artifacts", "Local workspace files"],
      forbiddenTools: [
        "Claiming success without verification artifacts",
        "Modifying the input files under data/"
      ],
      deploymentTarget: "Local machine workflow"
    },
    integrations: [
      {
        name: "GPT Runner",
        status: "active",
        notes: "Planner, reviewer, and delivery path"
      },
      {
        name: "Codex",
        status: "active",
        notes: "Implementation path"
      },
      {
        name: "local-ci",
        status: "active",
        notes: "Verification path"
      }
    ],
    dataSources: ["data/brief.txt", "data/details.txt"],
    definitionOfDone: [
      "The planner, executor, reviewer, verifier, and delivery tasks all complete successfully",
      "artifacts/generated/summary.md exists",
      "The output markdown includes both local file tokens and the Combined Notes heading"
    ],
    acceptanceCriteria: [
      "The planner handoff runs on gpt-runner",
      "The implementation handoff runs on codex",
      "The review handoff runs on gpt-runner",
      "The verification handoff runs on local-ci",
      "The delivery handoff runs on gpt-runner"
    ],
    riskStopRules: [
      "Pause if the workflow needs to delete production data",
      "Pause if an irreversible migration is required",
      "Pause if a new paid external service must be added"
    ],
    priorities: [
      "Verification before convenience",
      "Preserve local file evidence",
      "Keep routing explicit"
    ],
    deliverables: [
      "Generated markdown summary",
      "Planner, implementation, review, verification, and delivery result artifacts",
      "Autonomous summary and run-state artifacts"
    ]
  };
}

async function configureAttemptWorkspace(workspaceRoot, attemptNumber) {
  const dataRoot = path.join(workspaceRoot, "data");
  const scriptsRoot = path.join(workspaceRoot, "scripts");
  const specsRoot = path.join(workspaceRoot, "specs");
  const configPath = path.join(workspaceRoot, "config", "factory.config.json");
  const specPath = path.join(specsRoot, "project-spec.json");
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const verifySummaryScriptPath = path.join(scriptsRoot, "verify-summary.mjs");
  const { alphaToken, betaToken } = createAttemptTokens(attemptNumber);

  await ensureDirectory(dataRoot);
  await ensureDirectory(scriptsRoot);
  await ensureDirectory(specsRoot);
  await writeText(path.join(dataRoot, "brief.txt"), `Brief token: ${alphaToken}\n`);
  await writeText(path.join(dataRoot, "details.txt"), `Details token: ${betaToken}\n`);
  await writeText(verifySummaryScriptPath, buildWorkspaceSummaryVerifierScript());
  await writeJson(packageJsonPath, buildWorkspacePackageJson());
  await writeJson(specPath, buildWorkspaceSpec(attemptNumber));

  const factoryConfig = await readJson(configPath);
  const guardedFactoryConfig = applyAcceptanceWorkspaceGuardrails(factoryConfig);
  await writeJson(configPath, guardedFactoryConfig);

  return {
    specPath,
    packageJsonPath,
    configPath,
    alphaToken,
    betaToken,
    factoryConfig: guardedFactoryConfig
  };
}

async function runNodeStep(
  stepName,
  args,
  {
    env,
    logDirectory,
    stepTimeoutMs = defaultStepTimeoutMs,
    stallTimeoutMs = defaultStepStallTimeoutMs,
    heartbeatMs = defaultHeartbeatMs,
    watchActivityPaths = [],
    monitorStep = null
  }
) {
  await ensureDirectory(logDirectory);
  const stdoutPath = path.join(logDirectory, `${stepName}.out.log`);
  const stderrPath = path.join(logDirectory, `${stepName}.err.log`);
  const startedMs = Date.now();
  let lastActivityMs = startedMs;
  let lastHeartbeatMs = startedMs;
  let heartbeatCount = 0;
  let monitorInFlight = false;
  let terminationReason = null;
  const knownPathActivity = new Map();

  const stdoutStream = createWriteStream(stdoutPath, { encoding: "utf8" });
  const stderrStream = createWriteStream(stderrPath, { encoding: "utf8" });
  stdoutStream.on("error", () => undefined);
  stderrStream.on("error", () => undefined);
  let logsClosed = false;

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  const markActivity = () => {
    lastActivityMs = Date.now();
  };

  child.stdout?.on("data", (chunk) => {
    stdoutStream.write(chunk);
    markActivity();
  });

  child.stderr?.on("data", (chunk) => {
    stderrStream.write(chunk);
    markActivity();
  });

  const closeLogs = async () => {
    if (logsClosed) {
      return;
    }

    logsClosed = true;
    await Promise.all([
      new Promise((resolve) => stdoutStream.end(resolve)),
      new Promise((resolve) => stderrStream.end(resolve))
    ]);
  };

  const monitorStepProgress = async () => {
    if (monitorInFlight || terminationReason) {
      return;
    }

    monitorInFlight = true;
    let monitorFailure = null;

    try {
      if (watchActivityPaths.length > 0) {
        const hasFileActivity = await readLatestActivityFromPaths(watchActivityPaths, knownPathActivity);

        if (hasFileActivity) {
          markActivity();
        }
      }

      const now = Date.now();
      const elapsedMs = now - startedMs;
      const idleMs = now - lastActivityMs;

      if (typeof monitorStep === "function") {
        const monitorResult = await monitorStep({
          stepName,
          childPid: child.pid ?? null,
          startedMs,
          elapsedMs,
          idleMs,
          stdoutPath,
          stderrPath
        });

        if (monitorResult?.activity) {
          markActivity();
        }

        if (isNonEmptyString(monitorResult?.terminationReason)) {
          terminationReason = monitorResult.terminationReason;
          await terminateProcessTree(child.pid ?? -1);
          return;
        }
      }
    } catch (error) {
      monitorFailure = error instanceof Error ? error.message : String(error);
    } finally {
      monitorInFlight = false;
    }

    if (monitorFailure) {
      terminationReason = `monitor failed: ${monitorFailure}`;
      await terminateProcessTree(child.pid ?? -1);
      return;
    }

    const now = Date.now();
    const elapsedMs = now - startedMs;
    const idleMs = now - lastActivityMs;

    if (now - lastHeartbeatMs >= heartbeatMs) {
      heartbeatCount += 1;
      lastHeartbeatMs = now;
      console.log(
        `[heartbeat] ${stepName} elapsed=${msToSeconds(elapsedMs)}s idle=${msToSeconds(idleMs)}s pid=${child.pid ?? "n/a"}`
      );
    }

    if (elapsedMs >= stepTimeoutMs) {
      terminationReason = `step timed out after ${msToSeconds(stepTimeoutMs)}s`;
      await terminateProcessTree(child.pid ?? -1);
      return;
    }

    if (idleMs >= stallTimeoutMs) {
      terminationReason = `step stalled after ${msToSeconds(stallTimeoutMs)}s without activity`;
      await terminateProcessTree(child.pid ?? -1);
    }
  };

  if (watchActivityPaths.length > 0) {
    await readLatestActivityFromPaths(watchActivityPaths, knownPathActivity);
  }

  const monitorIntervalMs = Math.max(1000, Math.min(5000, Math.floor(heartbeatMs / 2)));
  const monitorTimer = setInterval(() => {
    void monitorStepProgress();
  }, monitorIntervalMs);

  try {
    const completion = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code: code ?? 1, signal: signal ?? null }));
    });

    clearInterval(monitorTimer);

    await closeLogs();

    if (terminationReason) {
      throw new Error(
        `Step failed: ${stepName}\n` +
          `args=${args.join(" ")}\n` +
          `stdout=${stdoutPath}\n` +
          `stderr=${stderrPath}\n` +
          `reason=${terminationReason}`
      );
    }

    if (completion.code !== 0) {
      throw new Error(
        `Step failed: ${stepName}\n` +
          `args=${args.join(" ")}\n` +
          `stdout=${stdoutPath}\n` +
          `stderr=${stderrPath}\n` +
          `reason=exit code ${completion.code}${completion.signal ? ` signal=${completion.signal}` : ""}`
      );
    }

    return {
      stepName,
      args,
      stdoutPath,
      stderrPath,
      exitCode: completion.code,
      durationSeconds: msToSeconds(Date.now() - startedMs),
      heartbeatCount,
      timedOut: false,
      stalled: false
    };
  } catch (error) {
    clearInterval(monitorTimer);

    await terminateProcessTree(child.pid ?? -1);
    await closeLogs();

    const reason = error instanceof Error ? error.message : String(error);
    const timeoutOrStall = terminationReason ?? reason;

    throw new Error(
      `Step failed: ${stepName}\n` +
        `args=${args.join(" ")}\n` +
        `stdout=${stdoutPath}\n` +
        `stderr=${stderrPath}\n` +
        `reason=${timeoutOrStall}`,
      { cause: error }
    );
  }
}

function ensureHanCharacters(text, label) {
  assert.match(text, /\p{Script=Han}/u, `${label} should contain readable Chinese characters`);
}

async function verifyAttemptArtifacts({
  workspaceRoot,
  runRoot,
  handoffRoot,
  doctorReportPath,
  alphaToken,
  betaToken
}) {
  const runStatePath = path.join(runRoot, "run-state.json");
  const autonomousSummaryPath = path.join(runRoot, "autonomous-summary.json");
  const dispatchResultsPath = path.join(handoffRoot, "dispatch-results.json");
  const implementationBriefPath = path.join(runRoot, "task-briefs", "implement-local-file-summary.md");
  const summaryMarkdownPath = path.join(workspaceRoot, "artifacts", "generated", "summary.md");
  const runState = await readJson(runStatePath);
  const autonomousSummary = await readJson(autonomousSummaryPath);

  if (runState.status !== "completed" || autonomousSummary.finalStatus !== "completed") {
    const blockerSummary = runState.taskLedger
      .filter((task) => ["blocked", "failed", "in_progress"].includes(task.status))
      .map((task) => {
        const recentNotes = Array.isArray(task.notes)
          ? task.notes.slice(-2).map((note) => String(note)).join(" | ")
          : "no-notes";
        return `${task.id}:${task.status} notes=${recentNotes}`;
      })
      .join(" ; ");

    throw new Error(
      `run did not complete before artifact verification ` +
        `(runStatus=${runState.status}, autonomousStatus=${autonomousSummary.finalStatus}, ` +
        `stopReason=${autonomousSummary.stopReason ?? "unknown"}, blockers=${blockerSummary || "none"})`
    );
  }

  if (!(await fileExists(summaryMarkdownPath))) {
    throw new Error(`summary artifact missing after completed run: ${summaryMarkdownPath}`);
  }

  const dispatchResults = await readJson(dispatchResultsPath);
  const doctorReport = await readJson(doctorReportPath);
  const implementationBrief = await readTextFile(implementationBriefPath);
  const summaryMarkdown = await readTextFile(summaryMarkdownPath);

  assert.equal(runState.status, "completed", "run-state should end completed");
  assert.equal(autonomousSummary.finalStatus, "completed", "autonomous final status should be completed");
  assert.equal(autonomousSummary.stopReason, "run completed", "autonomous stop reason should be run completed");
  assert.ok(runState.taskLedger.every((task) => task.status === "completed"), "every task should complete");
  assert.match(implementationBrief, /data\/brief\.txt/i, "implementation brief should mention data/brief.txt");
  assert.match(implementationBrief, /data\/details\.txt/i, "implementation brief should mention data/details.txt");
  assert.match(summaryMarkdown, /^# Combined Notes/m, "summary markdown should include Combined Notes heading");
  assert.match(summaryMarkdown, new RegExp(alphaToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "summary markdown should include alpha token");
  assert.match(summaryMarkdown, new RegExp(betaToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "summary markdown should include beta token");
  ensureHanCharacters(summaryMarkdown, "summary markdown");
  assert.equal(dispatchResults.summary.completed, 1, "final dispatch should complete one task");
  assert.equal(dispatchResults.results[0]?.taskId, "delivery-package", "final dispatch should package delivery");
  assert.equal(dispatchResults.results[0]?.status, "completed", "delivery dispatch result should complete");

  const requiredRuntimeStatuses = new Map(
    doctorReport.checks
      .filter((check) => check.requiredByDefaultRoute)
      .map((check) => [check.id, check.ok])
  );
  assert.equal(requiredRuntimeStatuses.get("gpt-runner"), true, "gpt-runner should be ready");
  assert.equal(requiredRuntimeStatuses.get("codex"), true, "codex should be ready");
  assert.equal(requiredRuntimeStatuses.get("local-ci"), true, "local-ci should be ready");

  const expectedRuntimes = new Map([
    ["planning-brief", "gpt-runner"],
    ["implement-local-file-summary", "codex"],
    ["review-local-file-summary", "gpt-runner"],
    ["verify-local-file-summary", "local-ci"],
    ["delivery-package", "gpt-runner"]
  ]);
  const taskEvidence = [];

  for (const [taskId, expectedRuntimeId] of expectedRuntimes) {
    const descriptorPath = path.join(handoffRoot, `${taskId}.handoff.json`);
    assert.equal(await fileExists(descriptorPath), true, `descriptor should exist for ${taskId}`);
    const descriptor = await readJson(descriptorPath);
    assert.equal(descriptor.runtime?.id, expectedRuntimeId, `${taskId} should route to ${expectedRuntimeId}`);
    assert.equal(await fileExists(descriptor.paths?.resultPath), true, `result artifact should exist for ${taskId}`);
    const result = await readJson(descriptor.paths.resultPath);
    assert.equal(result.status, "completed", `${taskId} result should be completed`);
    taskEvidence.push({
      taskId,
      runtimeId: descriptor.runtime.id,
      resultPath: descriptor.paths.resultPath
    });
  }

  return {
    runStatePath,
    autonomousSummaryPath,
    dispatchResultsPath,
    doctorReportPath,
    summaryMarkdownPath,
    taskEvidence
  };
}

async function runAttempt({
  attemptNumber,
  maxRounds,
  launcherTimeoutMs,
  outputRoot,
  attemptTimeoutMs,
  stepTimeoutMs,
  stepStallTimeoutMs,
  heartbeatMs
}) {
  const attemptLabel = `attempt-${String(attemptNumber).padStart(2, "0")}`;
  const attemptRoot = path.join(outputRoot, attemptLabel);
  const workspaceRoot = path.join(attemptRoot, "workspace");
  const runsRoot = path.join(workspaceRoot, "runs");
  const reportsRoot = path.join(workspaceRoot, "reports");
  const logDirectory = path.join(attemptRoot, "logs");
  const runId = `live-roundtrip-${String(attemptNumber).padStart(2, "0")}`;
  const runRoot = path.join(runsRoot, runId);
  const runStatePath = path.join(runRoot, "run-state.json");
  const autonomousSummaryPath = path.join(runRoot, "autonomous-summary.json");
  const doctorReportPath = path.join(reportsRoot, "runtime-doctor.json");
  const handoffRoot = path.join(runRoot, "handoffs-autonomous");
  const steps = [];
  const startedAt = new Date();
  const attemptDeadlineMs = startedAt.getTime() + attemptTimeoutMs;
  const env = {
    ...process.env,
    AI_FACTORY_LAUNCHER_TIMEOUT_MS: String(launcherTimeoutMs),
    AI_FACTORY_POWERSHELL_TIMEOUT_MS: String(launcherTimeoutMs),
    AI_FACTORY_GPT_RUNNER_LAUNCHER_ATTEMPTS: String(
      parsePositiveInteger(
        process.env.AI_FACTORY_GPT_RUNNER_LAUNCHER_ATTEMPTS,
        defaultAcceptanceGptRunnerLauncherAttempts
      )
    ),
    AI_FACTORY_GPT_RUNNER_RETRY_BASE_DELAY_MS: String(
      parsePositiveInteger(
        process.env.AI_FACTORY_GPT_RUNNER_RETRY_BASE_DELAY_MS,
        defaultAcceptanceGptRunnerRetryBaseDelayMs
      )
    ),
    AI_FACTORY_GPT_RUNNER_RETRY_MAX_DELAY_MS: String(
      parsePositiveInteger(
        process.env.AI_FACTORY_GPT_RUNNER_RETRY_MAX_DELAY_MS,
        defaultAcceptanceGptRunnerRetryMaxDelayMs
      )
    )
  };

  const runAttemptStep = async (
    stepName,
    args,
    {
      watchActivityPaths = [],
      stallTimeoutMsOverride = null,
      stepTimeoutMsOverride = null,
      monitorStep = null
    } = {}
  ) => {
    const remainingMs = attemptDeadlineMs - Date.now();

    if (remainingMs <= 0) {
      throw new Error(`Attempt timed out before ${stepName} could start.`);
    }

    const configuredStepTimeoutMs = parsePositiveInteger(stepTimeoutMsOverride, stepTimeoutMs);
    const effectiveStepTimeoutMs = Math.max(1000, Math.min(configuredStepTimeoutMs, remainingMs));
    const configuredStallTimeoutMs = parsePositiveInteger(stallTimeoutMsOverride, stepStallTimeoutMs);
    const effectiveStallTimeoutMs = Math.max(
      1000,
      Math.min(configuredStallTimeoutMs, effectiveStepTimeoutMs - 500)
    );

    const result = await runNodeStep(stepName, args, {
      env,
      logDirectory,
      stepTimeoutMs: effectiveStepTimeoutMs,
      stallTimeoutMs: effectiveStallTimeoutMs,
      heartbeatMs,
      watchActivityPaths,
      monitorStep
    });

    steps.push(result);
  };

  try {
    await ensureDirectory(attemptRoot);
    await runAttemptStep("01-init", ["src/index.mjs", "init", workspaceRoot]);

    const workspaceConfig = await configureAttemptWorkspace(workspaceRoot, attemptNumber);

    await runAttemptStep("02-validate", ["src/index.mjs", "validate", workspaceConfig.specPath]);
    await runAttemptStep("03-run", ["src/index.mjs", "run", workspaceConfig.specPath, runsRoot, runId]);
    await runAttemptStep("04-doctor", ["src/index.mjs", "doctor", reportsRoot]);
    const plannerPreflight = await runPlannerRuntimePreflight({
      workspaceRoot,
      runStatePath,
      doctorReportPath,
      factoryConfig: workspaceConfig.factoryConfig
    });

    if (plannerPreflight.degraded) {
      const degradationResult = await applyEscalatedModelDegradeToRunState({
        runStatePath,
        fallbackModelId: plannerPreflight.fallbackModelId,
        reason: plannerPreflight.degradeReason,
        roles: plannerPreflight.degradedRoles
      });

      if (degradationResult.changed) {
        console.warn(
          `[degrade] escalated GPT model unavailable; switched roles (${degradationResult.roles.join(
            ", "
          )}) to ${degradationResult.fallbackModelId}.`
        );
      }
    }

    await runAttemptStep(
      "05-autonomous",
      ["src/index.mjs", "autonomous", runStatePath, doctorReportPath, handoffRoot, String(maxRounds)],
      {
        watchActivityPaths: [
          runStatePath,
          autonomousSummaryPath,
          path.join(runRoot, "report.md"),
          path.join(runRoot, "roles.json")
        ],
        stallTimeoutMsOverride: Math.max(stepStallTimeoutMs, defaultAutonomousStepStallTimeoutMs),
        stepTimeoutMsOverride: attemptTimeoutMs,
        monitorStep: async ({ idleMs }) => {
          const diagnostics = await inspectAutonomousOrphanedExecutionLock({
            runStatePath,
            autonomousSummaryPath,
            idleMs,
            minimumIdleMs: Math.max(1000, Math.min(defaultAutonomousOrphanedLockIdleMs, heartbeatMs))
          });

          if (!diagnostics) {
            return null;
          }

          return {
            terminationReason: diagnostics.reason
          };
        }
      }
    );

    const evidence = await verifyAttemptArtifacts({
      workspaceRoot,
      runRoot,
      handoffRoot,
      doctorReportPath,
      alphaToken: workspaceConfig.alphaToken,
      betaToken: workspaceConfig.betaToken
    });

    return {
      attemptNumber,
      attemptLabel,
      success: true,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      workspaceRoot,
      runId,
      runRoot,
      handoffRoot,
      tokens: {
        alpha: workspaceConfig.alphaToken,
        beta: workspaceConfig.betaToken
      },
      steps,
      plannerPreflight,
      evidence
    };
  } catch (error) {
    if (error instanceof Error && !error.attemptContext) {
      error.attemptContext = {
        attemptNumber,
        attemptLabel,
        attemptRoot,
        workspaceRoot,
        runRoot,
        handoffRoot,
        runStatePath,
        doctorReportPath
      };
    }

    throw error;
  }
}

function renderSummaryMarkdown(summary) {
  const lines = [
    "# Live Roundtrip Acceptance Summary",
    "",
    `- Generated at: ${summary.generatedAt}`,
    `- Required successes: ${summary.requiredSuccesses}`,
    `- Achieved successes: ${summary.achievedSuccesses}`,
    `- Attempt limit: ${summary.maxAttempts}`,
    `- Launcher timeout (ms): ${summary.launcherTimeoutMs}`,
    `- Step timeout (ms): ${summary.stepTimeoutMs}`,
    `- Step stall timeout (ms): ${summary.stepStallTimeoutMs}`,
    `- Attempt timeout (ms): ${summary.attemptTimeoutMs}`,
    `- Overall timeout (ms): ${summary.overallTimeoutMs}`,
    `- Heartbeat interval (ms): ${summary.heartbeatMs}`,
    `- Autonomous max rounds: ${summary.maxRounds}`,
    `- Final status: ${summary.status}`,
    `- Stop reason: ${summary.stopReason ?? "n/a"}`,
    `- Retry circuit opened: ${summary.retryCircuitOpened ? "yes" : "no"}`,
    `- Backoff events: ${Array.isArray(summary.backoffEvents) ? summary.backoffEvents.length : 0}`,
    `- Failure feedback artifacts: ${summary.failureFeedback?.count ?? 0}`,
    "",
    "## Attempts"
  ];

  for (const attempt of summary.attempts) {
    lines.push(
      `- ${attempt.attemptLabel}: ${attempt.success ? "success" : "failed"} | runId=${attempt.runId ?? "n/a"} | duration=${attempt.durationSeconds ?? 0}s`
    );
    if (attempt.failure) {
      lines.push(`  reason: ${attempt.failure}`);
    }
    if (attempt.failureDiagnostics?.category === "external_upstream_outage") {
      lines.push(
        `  outage: runtime=${attempt.failureDiagnostics.runtimeId ?? "unknown"} ` +
          `status=${attempt.failureDiagnostics.httpStatus ?? "unknown"} ` +
          `host=${attempt.failureDiagnostics.upstreamHost ?? "unknown"} ` +
          `requestId=${attempt.failureDiagnostics.requestId ?? "unknown"}`
      );
    }
    if (attempt.failureDiagnostics?.category === "degraded_no_progress") {
      lines.push(
        `  no-progress: degraded=${attempt.failureDiagnostics.degradedRuntimeActive ? "yes" : "no"} ` +
          `lastProgressTask=${attempt.failureDiagnostics.lastProgressTaskId ?? "unknown"} ` +
          `lastEvent=${attempt.failureDiagnostics.lastProgressEvent ?? "unknown"} ` +
          `cycles=${attempt.failureDiagnostics.consecutiveNoProgressCycles ?? 0}`
      );
      lines.push(
        `  blockers: blocked=${(attempt.failureDiagnostics.blockedTaskIds ?? []).join(", ") || "none"} ` +
          `waitingRetry=${(attempt.failureDiagnostics.waitingRetryTaskIds ?? []).join(", ") || "none"} ` +
          `skipped=${(attempt.failureDiagnostics.skippedAutomaticTaskIds ?? []).join(", ") || "none"}`
      );
    }
    if (attempt.failureDiagnostics?.failureKind === "orphaned_execution_lock") {
      lines.push(
        `  orphaned-lock: task=${attempt.failureDiagnostics.taskId ?? "unknown"} ` +
          `pid=${attempt.failureDiagnostics.lockPid ?? "unknown"} ` +
          `rounds=${attempt.failureDiagnostics.autonomousRoundCount ?? 0} ` +
          `lastProgressTask=${attempt.failureDiagnostics.lastProgressTaskId ?? "unknown"} ` +
          `lastEvent=${attempt.failureDiagnostics.lastProgressEvent ?? "unknown"}`
      );
      lines.push(`  orphaned-lock-path: ${attempt.failureDiagnostics.lockPath ?? "unknown"}`);
    }
    if (attempt.artifactPaths) {
      lines.push(
        `  artifacts: autonomousSummary=${attempt.artifactPaths.autonomousSummaryPath ?? "missing"} ` +
          `runState=${attempt.artifactPaths.runStatePath ?? "missing"} ` +
          `dispatchResults=${attempt.artifactPaths.dispatchResultsPath ?? "missing"}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

async function writeFailureFeedbackArtifacts(outputRoot, feedbackRecords) {
  const records = Array.isArray(feedbackRecords) ? feedbackRecords : [];

  if (records.length === 0) {
    return {
      count: 0,
      directory: null,
      indexPath: null,
      generatedTestCasesPath: null
    };
  }

  const feedbackDirectory = path.join(outputRoot, "failure-feedback");
  await ensureDirectory(feedbackDirectory);
  const written = [];

  for (const [index, record] of records.entries()) {
    const artifactPath = path.join(
      feedbackDirectory,
      `${String(index + 1).padStart(3, "0")}-${record.taskId}.json`
    );
    await writeJson(artifactPath, record);
    written.push({
      ...record,
      path: artifactPath
    });
  }

  const indexPath = path.join(feedbackDirectory, "failure-feedback-index.json");
  const generatedTestCasesPath = path.join(feedbackDirectory, "generated-test-cases.json");
  await writeJson(indexPath, {
    generatedAt: new Date().toISOString(),
    count: written.length,
    entries: written
  });
  await writeJson(generatedTestCasesPath, {
    generatedAt: new Date().toISOString(),
    sourceIndexPath: indexPath,
    cases: written.map((entry, index) => ({
      id: `live-ff-${String(index + 1).padStart(3, "0")}`,
      sourceFeedbackPath: entry.path,
      category: entry.category,
      scenario: entry.summary,
      expectedBehavior: entry.nextBestAction,
      retryable: entry.retryable
    }))
  });

  return {
    count: written.length,
    directory: feedbackDirectory,
    indexPath,
    generatedTestCasesPath
  };
}

function isMainModule() {
  return path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDirectory(options.outputRoot);

  const attempts = [];
  const failureFeedbackRecords = [];
  const startedAt = new Date();
  const overallDeadlineMs = startedAt.getTime() + options.overallTimeoutMs;
  const backoffEvents = [];
  let successCount = 0;
  let consecutiveRetryableFailures = 0;
  let stopReason = null;

  for (let attemptNumber = 1; attemptNumber <= options.maxAttempts; attemptNumber += 1) {
    if (Date.now() >= overallDeadlineMs) {
      stopReason = `overall timeout reached after ${msToSeconds(options.overallTimeoutMs)}s`;
      console.error(`Stopping acceptance loop: ${stopReason}`);
      break;
    }

    console.log(`Starting live roundtrip attempt ${attemptNumber}/${options.maxAttempts}...`);

    try {
      const attempt = await runAttempt({
        attemptNumber,
        maxRounds: options.maxRounds,
        launcherTimeoutMs: options.launcherTimeoutMs,
        outputRoot: options.outputRoot,
        attemptTimeoutMs: options.attemptTimeoutMs,
        stepTimeoutMs: options.stepTimeoutMs,
        stepStallTimeoutMs: options.stepStallTimeoutMs,
        heartbeatMs: options.heartbeatMs
      });
      attempts.push(attempt);
      successCount += 1;
      consecutiveRetryableFailures = 0;
      console.log(
        `Attempt ${attemptNumber} succeeded: ${attempt.runId} (${attempt.durationSeconds}s, success ${successCount}/${options.successes})`
      );
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const attemptLabel = `attempt-${String(attemptNumber).padStart(2, "0")}`;
      const attemptContext = error instanceof Error ? error.attemptContext ?? null : null;
      const attemptArtifacts = attemptContext
        ? await collectAttemptFailureArtifacts({
            runRoot: attemptContext.runRoot,
            handoffRoot: attemptContext.handoffRoot
          })
        : null;
      const orphanedLockDiagnostics = attemptArtifacts
        ? await inspectAutonomousOrphanedExecutionLock({
            runStatePath: attemptArtifacts.runStatePath,
            autonomousSummaryPath: attemptArtifacts.autonomousSummaryPath,
            minimumIdleMs: 0
          })
        : null;
      const failureDiagnostics =
        extractOrphanedExecutionLockDiagnostics({
          reason: failureMessage,
          runState: attemptArtifacts?.runState ?? null,
          autonomousSummary: attemptArtifacts?.autonomousSummary ?? null
        }) ??
        orphanedLockDiagnostics ??
        extractDegradedNoProgressDiagnostics({
          reason: failureMessage,
          runState: attemptArtifacts?.runState ?? null,
          autonomousSummary: attemptArtifacts?.autonomousSummary ?? null
        }) ?? extractExternalOutageDiagnostics(failureMessage);
      const enrichedFailureMessage =
        failureDiagnostics?.failureKind === "orphaned_execution_lock"
          ? `${failureMessage}\n` +
            `orphanedTaskId=${failureDiagnostics.taskId ?? "unknown"} ` +
            `lockPid=${failureDiagnostics.lockPid ?? "unknown"} ` +
            `lockPath=${failureDiagnostics.lockPath ?? "unknown"} ` +
            `autonomousRoundCount=${failureDiagnostics.autonomousRoundCount ?? 0} ` +
            `lastProgressTaskId=${failureDiagnostics.lastProgressTaskId ?? "unknown"} ` +
            `lastProgressEvent=${failureDiagnostics.lastProgressEvent ?? "unknown"}`
        : failureDiagnostics?.category === "degraded_no_progress"
          ? `${failureMessage}\n` +
            `noProgressStopReason=${failureDiagnostics.stopReason ?? "unknown"} ` +
            `lastProgressTaskId=${failureDiagnostics.lastProgressTaskId ?? "unknown"} ` +
            `lastProgressEvent=${failureDiagnostics.lastProgressEvent ?? "unknown"} ` +
            `blockedTaskIds=${(failureDiagnostics.blockedTaskIds ?? []).join(",") || "none"} ` +
            `waitingRetryTaskIds=${(failureDiagnostics.waitingRetryTaskIds ?? []).join(",") || "none"} ` +
            `skippedAutomaticTaskIds=${(failureDiagnostics.skippedAutomaticTaskIds ?? []).join(",") || "none"}`
          : failureMessage;
      const feedbackRecord = buildFailureFeedbackRecord({
        attemptNumber,
        attemptLabel,
        reason: enrichedFailureMessage,
        outputRoot: options.outputRoot,
        diagnostics: failureDiagnostics,
        categoryOverride: failureDiagnostics?.category ?? null,
        evidencePaths: [
          attemptArtifacts?.runStatePath ?? null,
          attemptArtifacts?.autonomousSummaryPath ?? null,
          attemptArtifacts?.dispatchResultsPath ?? null
        ]
      });
      attempts.push({
        attemptNumber,
        attemptLabel,
        success: false,
        finishedAt: new Date().toISOString(),
        durationSeconds: 0,
        failure: enrichedFailureMessage,
        failureCategory: feedbackRecord.category,
        failureDiagnostics,
        artifactPaths: attemptArtifacts
          ? {
              autonomousSummaryPath: attemptArtifacts.autonomousSummaryPath,
              runStatePath: attemptArtifacts.runStatePath,
              dispatchResultsPath: attemptArtifacts.dispatchResultsPath
            }
          : null
      });
      failureFeedbackRecords.push(feedbackRecord);
      console.error(`Attempt ${attemptNumber} failed.`);
      console.error(enrichedFailureMessage);

      if (feedbackRecord.retryable) {
        consecutiveRetryableFailures += 1;

        if (consecutiveRetryableFailures >= options.retryCircuitFailures) {
          stopReason =
            `retry circuit opened after ${consecutiveRetryableFailures} consecutive retryable failures ` +
            `(latest category=${feedbackRecord.category})`;
          console.error(`Stopping acceptance loop: ${stopReason}`);
          break;
        }

        if (attemptNumber < options.maxAttempts) {
          const backoffMs = computeRetryBackoffMs({
            failureCount: consecutiveRetryableFailures,
            baseMs: options.retryBackoffBaseMs,
            maxMs: options.retryBackoffMaxMs
          });
          const backoffRecord = {
            attemptNumber,
            failureCategory: feedbackRecord.category,
            delayMs: backoffMs,
            occurredAt: new Date().toISOString()
          };
          backoffEvents.push(backoffRecord);
          console.log(
            `Retryable failure detected (${feedbackRecord.category}); backing off ${backoffMs}ms before next attempt.`
          );
          await sleep(backoffMs);
        }
      } else {
        consecutiveRetryableFailures = 0;
      }
    }

    if (successCount >= options.successes) {
      stopReason = "required success count reached";
      break;
    }
  }

  if (!stopReason) {
    stopReason =
      successCount >= options.successes
        ? "required success count reached"
        : "attempt limit reached before required successes";
  }

  const failureFeedback = await writeFailureFeedbackArtifacts(options.outputRoot, failureFeedbackRecords);
  const summary = {
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status: successCount >= options.successes ? "passed" : "failed",
    stopReason,
    requiredSuccesses: options.successes,
    achievedSuccesses: successCount,
    maxAttempts: options.maxAttempts,
    maxRounds: options.maxRounds,
    launcherTimeoutMs: options.launcherTimeoutMs,
    stepTimeoutMs: options.stepTimeoutMs,
    stepStallTimeoutMs: options.stepStallTimeoutMs,
    attemptTimeoutMs: options.attemptTimeoutMs,
    overallTimeoutMs: options.overallTimeoutMs,
    heartbeatMs: options.heartbeatMs,
    retryBackoffBaseMs: options.retryBackoffBaseMs,
    retryBackoffMaxMs: options.retryBackoffMaxMs,
    retryCircuitFailures: options.retryCircuitFailures,
    retryCircuitOpened: /retry circuit opened/i.test(stopReason),
    backoffEvents,
    outputRoot: options.outputRoot,
    failureFeedback,
    attempts
  };
  const summaryJsonPath = path.join(options.outputRoot, "acceptance-summary.json");
  const summaryMarkdownPath = path.join(options.outputRoot, "acceptance-summary.md");

  await writeJson(summaryJsonPath, summary);
  await writeText(summaryMarkdownPath, renderSummaryMarkdown(summary));

  console.log(`Acceptance summary JSON: ${summaryJsonPath}`);
  console.log(`Acceptance summary Markdown: ${summaryMarkdownPath}`);

  if (summary.status !== "passed") {
    throw new Error(
      `Live roundtrip acceptance did not reach ${options.successes} successful attempts (got ${successCount}/${options.successes}).`
    );
  }
}

export {
  applyAcceptanceWorkspaceGuardrails,
  extractExternalOutageDiagnostics,
  extractDegradedNoProgressDiagnostics,
  extractOrphanedExecutionLockDiagnostics,
  findOrphanedExecutionLockDiagnostics,
  buildWorkspacePackageJson,
  buildWorkspaceSummaryVerifierScript,
  classifyFailureCategory,
  computeRetryBackoffMs,
  configureAttemptWorkspace,
  inspectAutonomousOrphanedExecutionLock,
  parseArgs,
  applyEscalatedModelDegradeToRunState,
  runPlannerRuntimePreflight,
  runNodeStep
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
