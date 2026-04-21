import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import { ensureRunStateIntakePlanningReady } from "./intake-state.mjs";
import {
  buildPowerShellFileArgs,
  getNonWindowsLauncherShellCommand,
  getPowerShellInvocation
} from "./powershell.mjs";
import { validateResultArtifact } from "./result-artifact.mjs";
import { applyTaskArtifactToRunState } from "./result-application.mjs";
import { renderRunReport, updateTaskInRunState } from "./run-state.mjs";

const execFileAsync = promisify(execFile);
const dispatchLockSuffix = ".dispatch.lock";
const descriptorExecutionLockSuffix = ".execute.lock";
const dispatchLockTimeoutMs = 15000;
const dispatchLockRetryDelayMs = 100;
const dispatchLockStaleMs = 120000;
const descriptorExecutionLockUninitializedMs = 5000;
const launcherTimeoutErrorCode = "AI_FACTORY_LAUNCHER_TIMEOUT";
const defaultLauncherMaxBufferBytes = 16 * 1024 * 1024;
const defaultDispatchOutputTailBytes = 64 * 1024;
const defaultGptRunnerLauncherAttempts = 3;
const defaultGptRunnerRetryBaseDelayMs = 2000;
const defaultGptRunnerRetryMaxDelayMs = 15000;
const defaultLauncherPermissionRetryDelayMinutes = 1;

function readPositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name];
  const parsedValue = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function hashTextSha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function normalizePositiveInteger(value, fallbackValue) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : fallbackValue;
}

function fallbackRetryBudgetForRole(role) {
  if (role === "executor") {
    return 3;
  }

  if (role === "reviewer" || role === "verifier") {
    return 2;
  }

  return 1;
}

function getLauncherTimeoutMs(stepTimeoutMs = null) {
  const explicitLauncherTimeoutMs = readPositiveIntegerEnv("AI_FACTORY_LAUNCHER_TIMEOUT_MS", 0);

  if (explicitLauncherTimeoutMs > 0) {
    return explicitLauncherTimeoutMs;
  }

  return readPositiveIntegerEnv(
    "AI_FACTORY_POWERSHELL_TIMEOUT_MS",
    normalizePositiveInteger(stepTimeoutMs, 300000)
  );
}

function getLauncherMaxBufferBytes() {
  return readPositiveIntegerEnv("AI_FACTORY_LAUNCHER_MAX_BUFFER_BYTES", defaultLauncherMaxBufferBytes);
}

function getDispatchOutputTailBytes() {
  return readPositiveIntegerEnv("AI_FACTORY_DISPATCH_OUTPUT_TAIL_BYTES", defaultDispatchOutputTailBytes);
}

function getGptRunnerLauncherAttempts() {
  return readPositiveIntegerEnv(
    "AI_FACTORY_GPT_RUNNER_LAUNCHER_ATTEMPTS",
    defaultGptRunnerLauncherAttempts
  );
}

function getGptRunnerRetryBaseDelayMs() {
  return readPositiveIntegerEnv(
    "AI_FACTORY_GPT_RUNNER_RETRY_BASE_DELAY_MS",
    defaultGptRunnerRetryBaseDelayMs
  );
}

function getGptRunnerRetryMaxDelayMs() {
  return readPositiveIntegerEnv(
    "AI_FACTORY_GPT_RUNNER_RETRY_MAX_DELAY_MS",
    defaultGptRunnerRetryMaxDelayMs
  );
}

function computeGptRunnerRetryDelayMs(attemptIndex) {
  const normalizedAttemptIndex = Math.max(1, normalizePositiveInteger(attemptIndex, 1));
  const baseDelayMs = getGptRunnerRetryBaseDelayMs();
  const maxDelayMs = Math.max(baseDelayMs, getGptRunnerRetryMaxDelayMs());
  const jitterFactor = 0.85 + Math.random() * 0.3;
  const delayMs = Math.round(baseDelayMs * (2 ** (normalizedAttemptIndex - 1)) * jitterFactor);
  return Math.min(maxDelayMs, delayMs);
}

function tailTruncateExecutionOutput(value) {
  const normalizedValue = typeof value === "string" ? value.trim() : "";

  if (!normalizedValue) {
    return "";
  }

  const maxBytes = getDispatchOutputTailBytes();
  const encodedValue = Buffer.from(normalizedValue, "utf8");

  if (encodedValue.length <= maxBytes) {
    return normalizedValue;
  }

  return encodedValue.subarray(encodedValue.length - maxBytes).toString("utf8");
}

function classifyGptRunnerTransientSignal(value) {
  const text = String(value ?? "").toLowerCase();
  return /stream disconnected|reconnecting|503 service unavailable|502 bad gateway|service temporarily unavailable|connection reset|econnreset|network/i.test(
    text
  );
}

function shouldRetryGptRunnerLauncher({
  runtimeId,
  attemptNumber,
  maxAttempts,
  execution = null,
  error = null,
  resultArtifact = null
}) {
  if (runtimeId !== "gpt-runner") {
    return false;
  }

  if (attemptNumber >= maxAttempts) {
    return false;
  }

  if (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const message = error instanceof Error ? error.message : String(error);
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    return (
      code === launcherTimeoutErrorCode ||
      code === "ETIMEDOUT" ||
      classifyGptRunnerTransientSignal(message) ||
      classifyGptRunnerTransientSignal(stdout) ||
      classifyGptRunnerTransientSignal(stderr)
    );
  }

  if (!resultArtifact || resultArtifact.valid) {
    return false;
  }

  const reason = resultArtifact.reason ?? "";
  const stdout = execution?.stdout ?? "";
  const stderr = execution?.stderr ?? "";

  if (!/result artifact was not written|no such file|enoent/i.test(String(reason))) {
    return false;
  }

  return classifyGptRunnerTransientSignal(`${stdout}\n${stderr}`);
}

function isLauncherPermissionDeniedError(error) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    code === "EPERM" ||
    code === "EACCES" ||
    /spawn eperm|spawn eacces|permission denied|operation not permitted/i.test(message)
  );
}

function normalizeExecutionGuardrails(descriptor) {
  const role = descriptor.role ?? descriptor.task?.role ?? null;
  const promptHash =
    descriptor.prompt?.hash ??
    descriptor.launcher?.metadata?.promptHash ??
    null;
  const promptHashAlgorithm =
    descriptor.prompt?.hashAlgorithm ??
    descriptor.launcher?.metadata?.promptHashAlgorithm ??
    null;
  const retryBudget = normalizePositiveInteger(
    descriptor.execution?.retryBudget,
    fallbackRetryBudgetForRole(role)
  );
  const timeoutMs = normalizePositiveInteger(
    descriptor.execution?.timeoutMs,
    descriptor.runtime?.id === "local-ci" ? 900000 : 300000
  );
  const circuitBreakerLimit = normalizePositiveInteger(
    descriptor.execution?.circuitBreakerLimit,
    retryBudget
  );
  const expectedIdempotencyKey = hashTextSha256(
    JSON.stringify({
      runId: descriptor.runId ?? null,
      taskId: descriptor.taskId ?? descriptor.task?.id ?? null,
      handoffId: descriptor.handoffId ?? null,
      runtimeId: descriptor.runtime?.id ?? null,
      promptHash
    })
  );
  const persistedIdempotencyKey = descriptor.execution?.idempotencyKey;

  if (isNonEmptyString(persistedIdempotencyKey) && persistedIdempotencyKey !== expectedIdempotencyKey) {
    throw new Error(
      `Descriptor idempotency key mismatch for task ${descriptor.taskId}: expected ${expectedIdempotencyKey}, received ${persistedIdempotencyKey}.`
    );
  }

  return {
    timeoutMs,
    retryBudget,
    circuitBreakerLimit,
    promptHash,
    promptHashAlgorithm,
    idempotencyKey: persistedIdempotencyKey ?? expectedIdempotencyKey
  };
}

function countDispatchFailureNotes(task) {
  return Array.isArray(task?.notes)
    ? task.notes.filter((note) => /dispatch:(failed|incomplete|prompt-hash-mismatch|retry-budget-exhausted|circuit-open)/i.test(note)).length
    : 0;
}

function countRetryBudgetConsumption(task) {
  const attempts = normalizePositiveInteger(task?.attempts, 0);
  const retryCount = normalizePositiveInteger(task?.retryCount, 0);
  const automaticRetriesConsumed = Math.max(0, retryCount - 1);

  return {
    attempts,
    retryCount,
    consumed: Math.max(attempts, automaticRetriesConsumed)
  };
}

function buildLauncherExecutionError(message, code, cause) {
  const error = /** @type {Error & { code?: string, stdout?: string, stderr?: string }} */ (
    new Error(message, { cause })
  );

  error.code = code;
  error.stdout =
    typeof cause?.stdout === "string"
      ? cause.stdout
      : "";
  error.stderr =
    typeof cause?.stderr === "string"
      ? cause.stderr
      : "";

  return error;
}

async function classifyLauncherCommandStartError(command, unavailableMessage, error) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";

  if (code !== "ENOENT" || !isNonEmptyString(command)) {
    return buildLauncherExecutionError(unavailableMessage, "ENOENT", error);
  }

  try {
    const commandStats = await stat(command);

    if (commandStats.isDirectory()) {
      return buildLauncherExecutionError(
        `Launcher runtime path is not executable because it resolves to a directory: ${command}`,
        "EPERM",
        error
      );
    }

    if (!commandStats.isFile()) {
      return buildLauncherExecutionError(
        `Launcher runtime path is not executable: ${command}`,
        "EPERM",
        error
      );
    }
  } catch (statError) {
    if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") {
      throw statError;
    }
  }

  return buildLauncherExecutionError(unavailableMessage, "ENOENT", error);
}

function isLauncherTimeoutError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === launcherTimeoutErrorCode);
}

function executionFromError(error) {
  return {
    stdout: typeof error?.stdout === "string" ? error.stdout : "",
    stderr: typeof error?.stderr === "string" ? error.stderr : ""
  };
}

function renderDispatchReport(summary, results) {
  return [
    "# Dispatch Report",
    "",
    `- mode: ${summary.mode}`,
    `- total: ${summary.total}`,
    `- executed: ${summary.executed}`,
    `- completed: ${summary.completed}`,
    `- continued: ${summary.continued}`,
    `- incomplete: ${summary.incomplete}`,
    `- would_execute: ${summary.wouldExecute}`,
    `- skipped: ${summary.skipped}`,
    `- would_skip: ${summary.wouldSkip}`,
    `- failed: ${summary.failed}`,
    "",
    "## Results",
    ...results.map(
      (result) =>
        `- ${result.taskId} -> ${result.status}${result.nextTaskStatus ? ` [task=${result.nextTaskStatus}]` : ""} (${result.runtime})`
    )
  ].join("\n");
}

async function runPowerShellScript(scriptPath, timeoutMs = null) {
  if (!(await fileExists(scriptPath))) {
    throw new Error(`Launcher script not found: ${scriptPath}`);
  }

  const runtime = getPowerShellInvocation();
  const powerShellTimeoutMs = getLauncherTimeoutMs(timeoutMs);
  const powerShellMaxBufferBytes = getLauncherMaxBufferBytes();

  try {
    return await execFileAsync(
      runtime.command,
      buildPowerShellFileArgs(scriptPath),
      {
        encoding: "utf8",
        maxBuffer: powerShellMaxBufferBytes,
        windowsHide: runtime.windowsHide,
        timeout: powerShellTimeoutMs
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const powerShellMissing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT";
    const timedOut =
      (typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "ETIMEDOUT") ||
          ("killed" in error && error.killed === true && "signal" in error && error.signal === "SIGTERM"))) ||
      /timed out/i.test(errorMessage);

    if (powerShellMissing) {
      throw await classifyLauncherCommandStartError(
        runtime.command,
        `PowerShell runtime is not available: ${runtime.command}`,
        error
      );
    }

    if (timedOut) {
      throw buildLauncherExecutionError(
        `Launcher timed out after ${powerShellTimeoutMs / 1000} seconds: ${scriptPath}`,
        launcherTimeoutErrorCode,
        error
      );
    }

    throw error;
  }
}

async function runShellScript(scriptPath, timeoutMs = null) {
  if (!(await fileExists(scriptPath))) {
    throw new Error(`Launcher script not found: ${scriptPath}`);
  }

  const shellCommand = getNonWindowsLauncherShellCommand();
  const shellTimeoutMs = getLauncherTimeoutMs(timeoutMs);
  const shellMaxBufferBytes = getLauncherMaxBufferBytes();

  try {
    return await execFileAsync(shellCommand, [scriptPath], {
      encoding: "utf8",
      maxBuffer: shellMaxBufferBytes,
      timeout: shellTimeoutMs
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const shellMissing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT";
    const timedOut =
      (typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "ETIMEDOUT") ||
          ("killed" in error && error.killed === true && "signal" in error && error.signal === "SIGTERM"))) ||
      /timed out/i.test(errorMessage);

    if (shellMissing) {
      throw await classifyLauncherCommandStartError(
        shellCommand,
        `Launcher shell is not available: ${shellCommand}`,
        error
      );
    }

    if (timedOut) {
      throw buildLauncherExecutionError(
        `Launcher timed out after ${shellTimeoutMs / 1000} seconds: ${scriptPath}`,
        launcherTimeoutErrorCode,
        error
      );
    }

    throw error;
  }
}

async function runLauncherScript(scriptPath, timeoutMs = null) {
  return path.extname(scriptPath).toLowerCase() === ".sh"
    ? runShellScript(scriptPath, timeoutMs)
    : runPowerShellScript(scriptPath, timeoutMs);
}

function shouldAutoExecute(runtimeId) {
  return (
    runtimeId === "openclaw" ||
    runtimeId === "gpt-runner" ||
    runtimeId === "local-ci" ||
    runtimeId === "codex"
  );
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hydrateDescriptor(indexDescriptor) {
  const handoffJsonPath = indexDescriptor.handoffJsonPath;

  if (!isNonEmptyString(handoffJsonPath) || !(await fileExists(handoffJsonPath))) {
    return indexDescriptor;
  }

  const persistedDescriptor = await readJson(handoffJsonPath);

  return {
    ...persistedDescriptor,
    ...indexDescriptor,
    taskId: indexDescriptor.taskId ?? persistedDescriptor.taskId,
    handoffId: indexDescriptor.handoffId ?? persistedDescriptor.handoffId,
    runId: indexDescriptor.runId ?? persistedDescriptor.runId,
    role: indexDescriptor.role ?? persistedDescriptor.role,
    runtime: {
      ...(persistedDescriptor.runtime ?? {}),
      ...(indexDescriptor.runtime ?? {})
    },
    task: {
      ...(persistedDescriptor.task ?? {}),
      ...(indexDescriptor.task ?? {})
    },
    launcher: {
      ...(persistedDescriptor.launcher ?? {}),
      ...(indexDescriptor.launcher ?? {})
    },
    paths: {
      ...(persistedDescriptor.paths ?? {}),
      ...(indexDescriptor.paths ?? {})
    },
    prompt: indexDescriptor.prompt ?? persistedDescriptor.prompt,
    execution: indexDescriptor.execution ?? persistedDescriptor.execution,
    launcherPath:
      indexDescriptor.launcherPath ??
      persistedDescriptor.launcherPath ??
      persistedDescriptor.paths?.launcherPath ??
      null,
    promptPath:
      indexDescriptor.promptPath ??
      persistedDescriptor.promptPath ??
      persistedDescriptor.paths?.promptPath ??
      null,
    resultPath:
      indexDescriptor.resultPath ??
      persistedDescriptor.resultPath ??
      persistedDescriptor.paths?.resultPath ??
      null
  };
}

async function validatePromptIntegrity(descriptor, executionGuardrails) {
  if (!isNonEmptyString(executionGuardrails.promptHash)) {
    return;
  }

  const algorithm = String(executionGuardrails.promptHashAlgorithm ?? "sha256").toLowerCase();

  if (algorithm !== "sha256") {
    throw new Error(
      `Unsupported prompt hash algorithm for task ${descriptor.taskId}: ${executionGuardrails.promptHashAlgorithm}`
    );
  }

  const promptPath = descriptor.promptPath ?? descriptor.paths?.promptPath ?? null;

  if (!isNonEmptyString(promptPath) || !(await fileExists(promptPath))) {
    throw new Error(`Prompt file not found for prompt-hash validation: ${promptPath ?? "unknown"}`);
  }

  const promptText = await readFile(promptPath, "utf8");
  const actualPromptHash = hashTextSha256(promptText);

  if (actualPromptHash !== executionGuardrails.promptHash) {
    throw new Error(
      `Prompt hash mismatch for ${promptPath}: expected ${executionGuardrails.promptHash}, received ${actualPromptHash}.`
    );
  }
}

function sleep(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function acquireDispatchLock(lockPath) {
  const deadline = Date.now() + dispatchLockTimeoutMs;

  while (true) {
    try {
      const lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");

      return async () => {
        await lockHandle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      try {
        const existingLockStats = await stat(lockPath);

        if (Date.now() - existingLockStats.mtimeMs > dispatchLockStaleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") {
          throw statError;
        }

        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for dispatch run-state lock: ${lockPath}`, {
          cause: error
        });
      }

      await sleep(dispatchLockRetryDelayMs);
    }
  }
}

async function withDispatchLock(runStatePath, action) {
  const releaseLock = await acquireDispatchLock(`${runStatePath}${dispatchLockSuffix}`);

  try {
    return await action();
  } finally {
    await releaseLock();
  }
}

function resolveDescriptorExecutionLockPath(descriptor) {
  const lockTarget = descriptor.resultPath ?? descriptor.launcherPath;
  return `${path.resolve(lockTarget)}${descriptorExecutionLockSuffix}`;
}

function appendNoteFragment(baseNote, nextNote) {
  if (!isNonEmptyString(baseNote)) {
    return isNonEmptyString(nextNote) ? nextNote.trim() : null;
  }

  if (!isNonEmptyString(nextNote)) {
    return baseNote.trim();
  }

  return `${baseNote.trim()} ${nextNote.trim()}`.trim();
}

async function recoverDescriptorExecutionLock(lockPath, descriptor) {
  let lockContent;
  let lockStats;

  try {
    [lockContent, lockStats] = await Promise.all([
      readFile(lockPath, "utf8").catch(() => ""),
      stat(lockPath)
    ]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        recovered: true,
        note: null
      };
    }

    throw error;
  }

  const lockPid = parseLockPid(lockContent);
  const lockAgeMs = Date.now() - lockStats.mtimeMs;

  if (lockPid !== null && !isProcessAlive(lockPid)) {
    await rm(lockPath, { force: true });
    return {
      recovered: true,
      note:
        `Recovered stale orphaned execution lock for task ${descriptor.taskId} ` +
        `(dead pid ${lockPid}).`
    };
  }

  if ((lockStats.size === 0 || lockPid === null) && lockAgeMs > descriptorExecutionLockUninitializedMs) {
    await rm(lockPath, { force: true });
    return {
      recovered: true,
      note:
        `Recovered uninitialized execution lock for task ${descriptor.taskId} ` +
        `(age ${lockAgeMs}ms).`
    };
  }

  if (lockAgeMs > dispatchLockStaleMs) {
    await rm(lockPath, { force: true });
    return {
      recovered: true,
      note:
        `Recovered aged execution lock for task ${descriptor.taskId} ` +
        `(pid ${lockPid}, age ${lockAgeMs}ms).`
    };
  }

  return {
    recovered: false,
    note: null
  };
}

async function tryAcquireDescriptorExecutionLock(descriptor, recoveredNote = null) {
  const lockPath = resolveDescriptorExecutionLockPath(descriptor);

  try {
    const lockHandle = await open(lockPath, "wx");
    await lockHandle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");

    return {
      recoveredNote,
      release: async () => {
        await lockHandle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }

    const recovery = await recoverDescriptorExecutionLock(lockPath, descriptor);

    if (recovery.recovered) {
      return tryAcquireDescriptorExecutionLock(
        descriptor,
        appendNoteFragment(recoveredNote, recovery.note)
      );
    }

    return null;
  }
}

async function readResultArtifactForExecution(
  resultPath,
  {
    runId = null,
    taskId = null,
    handoffId = null,
    minimumMtimeMs = null
  } = {}
) {
  if (!resultPath || !(await fileExists(resultPath))) {
    return {
      exists: false,
      valid: false,
      artifact: null,
      reason: "Result artifact was not written."
    };
  }

  try {
    const resultStats = await stat(resultPath);
    const minimumArtifactMtimeMs =
      typeof minimumMtimeMs === "number" ? minimumMtimeMs - 1000 : null;

    if (typeof minimumArtifactMtimeMs === "number" && resultStats.mtimeMs < minimumArtifactMtimeMs) {
      return {
        exists: true,
        valid: false,
        artifact: null,
        reason: "Result artifact predates this launcher execution."
      };
    }

    const artifact = await readJson(resultPath);

    try {
      return {
        exists: true,
        valid: true,
        artifact: validateResultArtifact(artifact, {
          runId: runId ?? undefined,
          taskId: taskId ?? undefined,
          handoffId: handoffId ?? undefined
        }),
        reason: null
      };
    } catch (validationError) {
      return {
        exists: true,
        valid: false,
        artifact,
        reason: validationError instanceof Error ? validationError.message : String(validationError)
      };
    }
  } catch (error) {
    return {
      exists: true,
      valid: false,
      artifact: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function removeExistingResultArtifact(resultPath) {
  if (!resultPath) {
    return;
  }

  await rm(resultPath, {
    force: true
  });
}

function clearActiveHandoffFields(task) {
  return {
    ...task,
    activeHandoffId: null,
    activeResultPath: null,
    activeHandoffOutputDir: null
  };
}

function buildDispatchResultFromArtifact(descriptor, runtimeId, resultArtifact, execution = null, notePrefix = null) {
  const withPrefix = (message) => (notePrefix ? `${notePrefix} ${message}` : message);
  let status = "incomplete";
  let note = resultArtifact.reason ?? "Launcher finished but no result artifact was written.";

  if (resultArtifact.valid && resultArtifact.artifact?.status === "completed") {
    status = "completed";
    note = withPrefix("Result artifact passed validation.");
  } else if (resultArtifact.valid && resultArtifact.artifact?.status === "failed") {
    status = "failed";
    note = withPrefix("Runtime reported a failed task in the result artifact.");
  } else if (resultArtifact.valid && resultArtifact.artifact?.status === "blocked") {
    status = resultArtifact.artifact?.automationDecision ? "continued" : "incomplete";
    note = resultArtifact.artifact?.automationDecision
      ? withPrefix("Runtime reported a blocked task with an automatic continuation decision.")
      : withPrefix("Runtime reported a blocked task in the result artifact.");
  }

  return {
    taskId: descriptor.taskId,
    handoffId: descriptor.handoffId ?? null,
    runtime: runtimeId,
    status,
    launcherPath: descriptor.launcherPath,
    resultPath: descriptor.resultPath ?? null,
    artifact: resultArtifact.artifact,
    artifactValid: resultArtifact.valid,
    note,
    stdout: tailTruncateExecutionOutput(execution?.stdout),
    stderr: tailTruncateExecutionOutput(execution?.stderr)
  };
}

function isExhaustedTransientGptRunnerFailure({
  runtimeId,
  attemptNumber,
  maxAttempts,
  error = null,
  execution = null,
  resultArtifact = null
}) {
  if (runtimeId !== "gpt-runner" || attemptNumber < maxAttempts) {
    return false;
  }

  if (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const message = error instanceof Error ? error.message : String(error);
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    return (
      code === launcherTimeoutErrorCode ||
      code === "ETIMEDOUT" ||
      classifyGptRunnerTransientSignal(message) ||
      classifyGptRunnerTransientSignal(stdout) ||
      classifyGptRunnerTransientSignal(stderr)
    );
  }

  if (!resultArtifact || resultArtifact.valid) {
    return false;
  }

  const reason = resultArtifact.reason ?? "";

  if (!/result artifact was not written|no such file|enoent/i.test(String(reason))) {
    return false;
  }

  return classifyGptRunnerTransientSignal(`${execution?.stdout ?? ""}\n${execution?.stderr ?? ""}`);
}

function buildTransientGptRunnerRetryResult(descriptor, execution = null, notePrefix = null) {
  const stdout = tailTruncateExecutionOutput(execution?.stdout);
  const stderr = tailTruncateExecutionOutput(execution?.stderr);
  const reason = dedupeText([
    "Transient GPT Runner upstream failure; automatically retrying the same task.",
    classifyGptRunnerTransientSignal(`${stdout}\n${stderr}`)
      ? "Observed transient provider or transport symptoms in launcher output."
      : null
  ]);
  const artifact = validateResultArtifact(
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? null,
      status: "blocked",
      summary: reason,
      changedFiles: [],
      verification: ["Observed transient GPT Runner provider failure and scheduled an automatic retry."],
      notes: [reason],
      automationDecision: {
        action: "retry_task",
        reason,
        delayMinutes: 0
      }
    },
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? undefined
    }
  );

  return buildDispatchResultFromArtifact(
    descriptor,
    "gpt-runner",
    {
      exists: true,
      valid: true,
      artifact,
      reason: null
    },
    execution,
    appendNoteFragment(notePrefix, "Converted exhausted transient GPT Runner failure into an automatic retry.")
  );
}

function buildLauncherPermissionRetryResult(
  descriptor,
  runtimeId,
  error = null,
  notePrefix = null
) {
  const execution = executionFromError(error);
  const stdout = tailTruncateExecutionOutput(execution.stdout);
  const stderr = tailTruncateExecutionOutput(execution.stderr);
  const errorMessage = error instanceof Error ? error.message : String(error ?? "");
  const reason = dedupeText([
    `Launcher process creation was denied for runtime ${runtimeId}; automatically retrying the same task after a short cooldown.`,
    "The host environment reported a permission or policy restriction while starting the launcher.",
    isNonEmptyString(errorMessage) ? errorMessage : null
  ]);
  const artifact = validateResultArtifact(
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? null,
      status: "blocked",
      summary: reason,
      changedFiles: [],
      verification: [
        `Observed launcher process creation denial while starting runtime ${runtimeId}.`
      ],
      notes: [reason],
      automationDecision: {
        action: "retry_task",
        reason,
        delayMinutes: defaultLauncherPermissionRetryDelayMinutes
      }
    },
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? undefined
    }
  );

  return buildDispatchResultFromArtifact(
    descriptor,
    runtimeId,
    {
      exists: true,
      valid: true,
      artifact,
      reason: null
    },
    {
      stdout,
      stderr
    },
    appendNoteFragment(
      notePrefix,
      "Converted launcher process permission denial into an automatic retry."
    )
  );
}

function dedupeText(items) {
  return [...new Set((items ?? []).filter(isNonEmptyString).map((item) => item.trim()))].join(" ");
}

async function tryRecoverExistingResultArtifact(runStatePath, descriptor, runtimeId, runId, notePrefix) {
  if (!(await fileExists(runStatePath)) || !descriptor.resultPath) {
    return null;
  }

  const recoveryState = await withDispatchLock(runStatePath, async () => {
    const runState = await readJson(runStatePath);
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

    if (!task || task.status !== "in_progress") {
      return null;
    }

    if (
      descriptor.handoffId &&
      (typeof task.activeHandoffId !== "string" ||
        task.activeHandoffId.trim().length === 0 ||
        task.activeHandoffId !== descriptor.handoffId)
    ) {
      return null;
    }

    if (
      typeof task.activeResultPath !== "string" ||
      task.activeResultPath.trim().length === 0 ||
      path.resolve(task.activeResultPath) !== path.resolve(descriptor.resultPath)
    ) {
      return null;
    }

    return {
      taskId: task.id,
      activeHandoffId: task.activeHandoffId,
      activeResultPath: task.activeResultPath
    };
  });

  if (!recoveryState) {
    return null;
  }

  const existingResultArtifact = await readResultArtifactForExecution(descriptor.resultPath, {
    runId: runId ?? null,
    taskId: descriptor.taskId,
    handoffId: descriptor.handoffId ?? null
  });

  if (!existingResultArtifact.valid) {
    return null;
  }

  return buildDispatchResultFromArtifact(
    descriptor,
    runtimeId,
    existingResultArtifact,
    null,
    notePrefix
  );
}

async function prepareTaskForExecution(
  runStatePath,
  planPath,
  reportPath,
  descriptor,
  executionGuardrails
) {
  if (!(await fileExists(runStatePath))) {
    return { shouldExecute: true, note: null };
  }

  return withDispatchLock(runStatePath, async () => {
    const runState = await readJson(runStatePath);
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

    if (!task) {
      return {
        shouldExecute: false,
        note: `Task not found in run-state: ${descriptor.taskId}`
      };
    }

    if (
      descriptor.handoffId &&
      (typeof task.activeHandoffId !== "string" ||
        task.activeHandoffId.trim().length === 0 ||
        task.activeHandoffId !== descriptor.handoffId)
    ) {
      return {
        shouldExecute: false,
        note: `Descriptor handoff ${descriptor.handoffId} is stale for task ${descriptor.taskId}.`
      };
    }

    if (
      descriptor.resultPath &&
      (typeof task.activeResultPath !== "string" ||
        task.activeResultPath.trim().length === 0 ||
        path.resolve(task.activeResultPath) !== path.resolve(descriptor.resultPath))
    ) {
      return {
        shouldExecute: false,
        note: `Descriptor result path is stale for task ${descriptor.taskId}.`
      };
    }

    if (!["ready", "in_progress"].includes(task.status)) {
      return {
        shouldExecute: false,
        note: `Task ${descriptor.taskId} is ${task.status}; launcher execution was skipped.`
      };
    }

    const retryBudgetState = countRetryBudgetConsumption(task);

    if (retryBudgetState.consumed >= executionGuardrails.retryBudget) {
      const guardedRunState = updateTaskInRunState(
        {
          ...runState,
          taskLedger: runState.taskLedger.map((item) =>
            item.id === descriptor.taskId ? clearActiveHandoffFields(item) : item
          )
        },
        descriptor.taskId,
        "blocked",
        `dispatch:retry-budget-exhausted attempts=${retryBudgetState.attempts} ` +
          `retryCount=${retryBudgetState.retryCount} budget=${executionGuardrails.retryBudget}`
      );

      await writeJson(runStatePath, guardedRunState);

      if (await fileExists(planPath)) {
        const plan = await readJson(planPath);
        await writeFile(reportPath, `${renderRunReport(guardedRunState, plan)}\n`, "utf8");
      }

      return {
        shouldExecute: false,
        note:
          `Retry budget exhausted for task ${descriptor.taskId} ` +
          `(attempts=${retryBudgetState.attempts}, retryCount=${retryBudgetState.retryCount}, ` +
          `budget=${executionGuardrails.retryBudget}).`
      };
    }

    const dispatchFailureCount = countDispatchFailureNotes(task);

    if (dispatchFailureCount >= executionGuardrails.circuitBreakerLimit) {
      const guardedRunState = updateTaskInRunState(
        {
          ...runState,
          taskLedger: runState.taskLedger.map((item) =>
            item.id === descriptor.taskId ? clearActiveHandoffFields(item) : item
          )
        },
        descriptor.taskId,
        "blocked",
        `dispatch:circuit-open failures=${dispatchFailureCount} limit=${executionGuardrails.circuitBreakerLimit}`
      );

      await writeJson(runStatePath, guardedRunState);

      if (await fileExists(planPath)) {
        const plan = await readJson(planPath);
        await writeFile(reportPath, `${renderRunReport(guardedRunState, plan)}\n`, "utf8");
      }

      return {
        shouldExecute: false,
        note:
          `Execution circuit breaker is open for task ${descriptor.taskId} ` +
          `(${dispatchFailureCount}/${executionGuardrails.circuitBreakerLimit} dispatch failures).`
      };
    }

    const taskStatus = task.status;

    if (task.status === "ready") {
      const nextRunState = updateTaskInRunState(
        runState,
        descriptor.taskId,
        "in_progress",
        `dispatch:claimed ${descriptor.handoffId ?? "unknown"}`
      );

      await writeJson(runStatePath, nextRunState);

      if (await fileExists(planPath)) {
        const plan = await readJson(planPath);
        await writeFile(reportPath, `${renderRunReport(nextRunState, plan)}\n`, "utf8");
      }
    }

    return { shouldExecute: true, note: null, taskStatus };
  });
}

async function syncDispatchResults(runStatePath, planPath, reportPath, results) {
  if (!(await fileExists(runStatePath))) {
    return null;
  }

  return withDispatchLock(runStatePath, async () => {
    let runState = await readJson(runStatePath);
    const updatedTasks = [];
    const resultUpdates = [];

    for (const result of results) {
      if (!["completed", "failed", "incomplete", "continued"].includes(result.status)) {
        continue;
      }

      const task = runState.taskLedger.find((item) => item.id === result.taskId);

      if (!task) {
        continue;
      }

      if (
        result.handoffId &&
        (typeof task.activeHandoffId !== "string" ||
          task.activeHandoffId.trim().length === 0 ||
          task.activeHandoffId !== result.handoffId)
      ) {
        continue;
      }

      if (
        result.resultPath &&
        (typeof task.activeResultPath !== "string" ||
          task.activeResultPath.trim().length === 0 ||
          path.resolve(task.activeResultPath) !== path.resolve(result.resultPath))
      ) {
        continue;
      }

      try {
        if (result.artifact && result.artifactValid) {
          const application = applyTaskArtifactToRunState(runState, result.taskId, result.artifact, {
            notePrefix: "dispatch"
          });
          runState = application.runState;
          updatedTasks.push(...application.updatedTasks);
          resultUpdates.push({
            taskId: result.taskId,
            status: result.status,
            nextTaskStatus: application.task?.status ?? null,
            appliedDecision: application.appliedDecision
          });
          continue;
        }

        runState = updateTaskInRunState(
          {
            ...runState,
            taskLedger: runState.taskLedger.map((item) =>
              item.id === result.taskId ? clearActiveHandoffFields(item) : item
            )
          },
          result.taskId,
          result.status === "failed" ? "failed" : "blocked",
          `dispatch:${result.status}`
        );
        updatedTasks.push({
          taskId: result.taskId,
          nextStatus: result.status === "failed" ? "failed" : "blocked"
        });
        resultUpdates.push({
          taskId: result.taskId,
          status: result.status,
          nextTaskStatus: result.status === "failed" ? "failed" : "blocked",
          appliedDecision: null
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        runState = updateTaskInRunState(
          {
            ...runState,
            taskLedger: runState.taskLedger.map((item) =>
              item.id === result.taskId ? clearActiveHandoffFields(item) : item
            )
          },
          result.taskId,
          "blocked",
          `dispatch:invalid-automation-decision ${reason}`
        );
        updatedTasks.push({
          taskId: result.taskId,
          nextStatus: "blocked"
        });
        resultUpdates.push({
          taskId: result.taskId,
          status: "incomplete",
          nextTaskStatus: "blocked",
          appliedDecision: null,
          error: reason
        });
      }
    }

    await writeJson(runStatePath, runState);

    if (await fileExists(planPath)) {
      const plan = await readJson(planPath);
      await writeFile(reportPath, `${renderRunReport(runState, plan)}\n`, "utf8");
    }

    return {
      runStatePath,
      reportPath: (await fileExists(reportPath)) ? reportPath : null,
      updatedTasks,
      resultUpdates
    };
  });
}

export async function dispatchHandoffs(indexPath, mode = "dry-run") {
  if (mode !== "dry-run" && mode !== "execute") {
    throw new Error(`Unsupported dispatch mode: ${mode}`);
  }

  const resolvedIndexPath = path.resolve(indexPath);
  const handoffIndex = await readJson(resolvedIndexPath);
  const outputDir = path.dirname(resolvedIndexPath);
  const runDirectory = handoffIndex.runDirectory
    ? path.resolve(handoffIndex.runDirectory)
    : path.resolve(outputDir, "..");
  const runStatePath = handoffIndex.runStatePath
    ? path.resolve(handoffIndex.runStatePath)
    : path.join(runDirectory, "run-state.json");

  if (await fileExists(runStatePath)) {
    const runState = await readJson(runStatePath);
    const workspaceRoot =
      typeof runState?.workspacePath === "string" && runState.workspacePath.trim().length > 0
        ? path.resolve(runState.workspacePath)
        : path.resolve(path.dirname(runDirectory));
    await ensureRunStateIntakePlanningReady(runState, workspaceRoot, null, `dispatch ${mode}`);
  }
  /** @type {Array<{
   *   taskId: string,
   *   handoffId?: string | null,
   *   runtime: string,
   *   status: string,
   *   launcherPath: string,
  *   resultPath?: string | null,
  *   note?: string,
  *   error?: string,
  *   artifact?: any,
  *   nextTaskStatus?: string | null,
  *   appliedDecision?: any,
  *   stdout?: string,
  *   stderr?: string
  * }>} */
  const results = [];
  const seenIdempotencyKeys = new Set();

  for (const indexDescriptor of handoffIndex.descriptors) {
    let descriptor;

    try {
      descriptor = await hydrateDescriptor(indexDescriptor);
    } catch (error) {
      results.push({
        taskId: indexDescriptor.taskId,
        handoffId: indexDescriptor.handoffId ?? null,
        runtime: indexDescriptor.runtime?.id ?? "unknown",
        status: "failed",
        launcherPath: indexDescriptor.launcherPath,
        resultPath: indexDescriptor.resultPath ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const runtimeId = descriptor.runtime.id;

    if (mode === "dry-run") {
      results.push({
        taskId: descriptor.taskId,
        handoffId: descriptor.handoffId ?? null,
        runtime: runtimeId,
        status: shouldAutoExecute(runtimeId) ? "would_execute" : "would_skip",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null
      });
      continue;
    }

    if (!shouldAutoExecute(runtimeId)) {
      results.push({
        taskId: descriptor.taskId,
        handoffId: descriptor.handoffId ?? null,
        runtime: runtimeId,
        status: "skipped",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        note: "This runtime is currently treated as manual or hybrid only."
      });
      continue;
    }

    let executionGuardrails;

    try {
      executionGuardrails = normalizeExecutionGuardrails(descriptor);
    } catch (error) {
      results.push({
        taskId: descriptor.taskId,
        handoffId: descriptor.handoffId ?? null,
        runtime: runtimeId,
        status: "failed",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    let executionLock = null;

    try {
      const planPath = path.join(runDirectory, "execution-plan.json");
      const reportPath = path.join(runDirectory, "report.md");
      const runId = descriptor.runId ?? handoffIndex.runId ?? null;

      if (seenIdempotencyKeys.has(executionGuardrails.idempotencyKey)) {
        results.push({
          taskId: descriptor.taskId,
          handoffId: descriptor.handoffId ?? null,
          runtime: runtimeId,
          status: "skipped",
          launcherPath: descriptor.launcherPath,
          resultPath: descriptor.resultPath ?? null,
          note: `Duplicate idempotency key detected for task ${descriptor.taskId}; launcher execution was skipped.`
        });
        continue;
      }

      seenIdempotencyKeys.add(executionGuardrails.idempotencyKey);
      executionLock = await tryAcquireDescriptorExecutionLock(descriptor);

      if (!executionLock) {
        const recoveredResult = await tryRecoverExistingResultArtifact(
          runStatePath,
          descriptor,
          runtimeId,
          runId,
          "Recovered existing result artifact after restart while the previous execution lock was still present."
        );

        if (recoveredResult) {
          results.push(recoveredResult);
          continue;
        }

        results.push({
          taskId: descriptor.taskId,
          runtime: runtimeId,
          status: "skipped",
          launcherPath: descriptor.launcherPath,
          resultPath: descriptor.resultPath ?? null,
          note: "Another dispatch process is already executing this handoff."
        });
        continue;
      }

      const lockRecoveryNote = executionLock.recoveredNote;

      try {
        const preparation = await prepareTaskForExecution(
          runStatePath,
          planPath,
          reportPath,
          descriptor,
          executionGuardrails
        );

        if (!preparation.shouldExecute) {
          results.push({
            taskId: descriptor.taskId,
            handoffId: descriptor.handoffId ?? null,
            runtime: runtimeId,
            status: "skipped",
            launcherPath: descriptor.launcherPath,
            resultPath: descriptor.resultPath ?? null,
            note: appendNoteFragment(lockRecoveryNote, preparation.note)
          });
          continue;
        }

        if (preparation.taskStatus === "in_progress") {
          const recoveredResult = await tryRecoverExistingResultArtifact(
            runStatePath,
            descriptor,
            runtimeId,
            runId,
            "Recovered existing result artifact after restart."
          );

          if (recoveredResult) {
            results.push(recoveredResult);
            continue;
          }
        }

        await validatePromptIntegrity(descriptor, executionGuardrails);
        const maxLauncherAttempts = runtimeId === "gpt-runner" ? getGptRunnerLauncherAttempts() : 1;
        let completedResult = null;

        for (let launcherAttempt = 1; launcherAttempt <= maxLauncherAttempts; launcherAttempt += 1) {
          await removeExistingResultArtifact(descriptor.resultPath ?? null);
          const launcherStartedAtMs = Date.now();
          let execution;
          let resultArtifact;

          try {
            execution = await runLauncherScript(descriptor.launcherPath, executionGuardrails.timeoutMs);
          } catch (error) {
            if (isLauncherTimeoutError(error)) {
              resultArtifact = await readResultArtifactForExecution(descriptor.resultPath ?? null, {
                runId,
                taskId: descriptor.taskId,
                handoffId: descriptor.handoffId ?? null,
                minimumMtimeMs: launcherStartedAtMs
              });

              if (resultArtifact.valid) {
                completedResult = buildDispatchResultFromArtifact(
                  descriptor,
                  runtimeId,
                  resultArtifact,
                  executionFromError(error),
                  appendNoteFragment(
                    lockRecoveryNote,
                    "Launcher timed out after writing a valid result artifact."
                  )
                );
                break;
              }
            }

            if (
              shouldRetryGptRunnerLauncher({
                runtimeId,
                attemptNumber: launcherAttempt,
                maxAttempts: maxLauncherAttempts,
                error,
                resultArtifact
              })
            ) {
              await sleep(computeGptRunnerRetryDelayMs(launcherAttempt));
              continue;
            }

            if (
              isExhaustedTransientGptRunnerFailure({
                runtimeId,
                attemptNumber: launcherAttempt,
                maxAttempts: maxLauncherAttempts,
                error,
                resultArtifact
              })
            ) {
              completedResult = buildTransientGptRunnerRetryResult(
                descriptor,
                executionFromError(error),
                lockRecoveryNote
              );
              break;
            }

            if (isLauncherPermissionDeniedError(error)) {
              completedResult = buildLauncherPermissionRetryResult(
                descriptor,
                runtimeId,
                error,
                lockRecoveryNote
              );
              break;
            }

            throw error;
          }

          resultArtifact = await readResultArtifactForExecution(descriptor.resultPath ?? null, {
            runId,
            taskId: descriptor.taskId,
            handoffId: descriptor.handoffId ?? null,
            minimumMtimeMs: launcherStartedAtMs
          });

          if (
            shouldRetryGptRunnerLauncher({
              runtimeId,
              attemptNumber: launcherAttempt,
              maxAttempts: maxLauncherAttempts,
              execution,
              resultArtifact
            })
          ) {
            await sleep(computeGptRunnerRetryDelayMs(launcherAttempt));
            continue;
          }

          if (
            isExhaustedTransientGptRunnerFailure({
              runtimeId,
              attemptNumber: launcherAttempt,
              maxAttempts: maxLauncherAttempts,
              execution,
              resultArtifact
            })
          ) {
            completedResult = buildTransientGptRunnerRetryResult(descriptor, execution, lockRecoveryNote);
            break;
          }

          completedResult = buildDispatchResultFromArtifact(
            descriptor,
            runtimeId,
            {
              ...resultArtifact,
              artifact: resultArtifact.artifact,
              reason: resultArtifact.reason
            },
            {
              stdout: execution.stdout,
              stderr: execution.stderr
            },
            appendNoteFragment(
              lockRecoveryNote,
              launcherAttempt > 1 ? `Launcher finished after ${launcherAttempt} attempts.` : "Launcher finished."
            )
          );
          break;
        }

        if (!completedResult) {
          throw new Error(`Launcher execution produced no dispatch result for task ${descriptor.taskId}.`);
        }

        results.push(completedResult);
      } finally {
        await executionLock.release();
      }
    } catch (error) {
      results.push({
        taskId: descriptor.taskId,
        handoffId: descriptor.handoffId ?? null,
        runtime: runtimeId,
        status: "failed",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        note: executionLock?.recoveredNote ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const planPath = path.join(runDirectory, "execution-plan.json");
  const reportPath = path.join(runDirectory, "report.md");
  const runStateSync =
    mode === "execute"
      ? await syncDispatchResults(runStatePath, planPath, reportPath, results)
      : null;
  const finalResults =
    mode === "execute" && Array.isArray(runStateSync?.resultUpdates)
      ? results.map((result) => {
          if (!["completed", "continued", "incomplete", "failed"].includes(result.status)) {
            return result;
          }

          const update = runStateSync.resultUpdates.find((candidate) => candidate.taskId === result.taskId);

          if (!update) {
            return result;
          }

          return {
            ...result,
            status: update.status ?? result.status,
            nextTaskStatus: update.nextTaskStatus ?? result.nextTaskStatus ?? null,
            appliedDecision: update.appliedDecision ?? result.appliedDecision ?? null,
            error: update.error ?? result.error
          };
        })
      : results;
  const summary = {
    generatedAt: new Date().toISOString(),
    mode,
    total: finalResults.length,
    executed: finalResults.filter((item) =>
      item.status === "completed" ||
      item.status === "continued" ||
      item.status === "incomplete" ||
      item.status === "failed"
    ).length,
    completed: finalResults.filter((item) => item.status === "completed").length,
    continued: finalResults.filter((item) => item.status === "continued").length,
    incomplete: finalResults.filter((item) => item.status === "incomplete").length,
    wouldExecute: finalResults.filter((item) => item.status === "would_execute").length,
    skipped: finalResults.filter((item) => item.status === "skipped" || item.status === "would_skip").length,
    wouldSkip: finalResults.filter((item) => item.status === "would_skip").length,
    failed: finalResults.filter((item) => item.status === "failed").length
  };

  await ensureDirectory(outputDir);

  const resultJsonPath = path.join(outputDir, "dispatch-results.json");
  const resultMarkdownPath = path.join(outputDir, "dispatch-results.md");

  await writeJson(resultJsonPath, {
    summary,
    results: finalResults,
    runStateSync
  });
  await writeFile(resultMarkdownPath, `${renderDispatchReport(summary, finalResults)}\n`, "utf8");

  return {
    resultJsonPath,
    resultMarkdownPath,
    summary,
    results: finalResults,
    runStateSync
  };
}
