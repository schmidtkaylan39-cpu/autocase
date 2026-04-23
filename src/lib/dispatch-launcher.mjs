import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildPowerShellFileArgs,
  getNonWindowsLauncherShellCommand,
  getPowerShellInvocation
} from "./powershell.mjs";
import {
  fileExists,
  isNonEmptyString,
  normalizePositiveInteger,
  readPositiveIntegerEnv
} from "./dispatch-utils.mjs";

const execFileAsync = promisify(execFile);
export const launcherTimeoutErrorCode = "AI_FACTORY_LAUNCHER_TIMEOUT";
const defaultLauncherMaxBufferBytes = 16 * 1024 * 1024;
const defaultDispatchOutputTailBytes = 64 * 1024;
const defaultGptRunnerLauncherAttempts = 3;
const defaultGptRunnerRetryBaseDelayMs = 2000;
const defaultGptRunnerRetryMaxDelayMs = 15000;

export function getLauncherTimeoutMs(stepTimeoutMs = null) {
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

export function getGptRunnerLauncherAttempts() {
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

export function computeGptRunnerRetryDelayMs(attemptIndex) {
  const normalizedAttemptIndex = Math.max(1, normalizePositiveInteger(attemptIndex, 1));
  const baseDelayMs = getGptRunnerRetryBaseDelayMs();
  const maxDelayMs = Math.max(baseDelayMs, getGptRunnerRetryMaxDelayMs());
  const jitterFactor = 0.85 + Math.random() * 0.3;
  const delayMs = Math.round(baseDelayMs * (2 ** (normalizedAttemptIndex - 1)) * jitterFactor);
  return Math.min(maxDelayMs, delayMs);
}

export function tailTruncateExecutionOutput(value) {
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

export function classifyGptRunnerTransientSignal(value) {
  const text = String(value ?? "").toLowerCase();
  return /stream disconnected|reconnecting|503 service unavailable|502 bad gateway|service temporarily unavailable|connection reset|econnreset|network/i.test(
    text
  );
}

export function isMissingResultArtifactReason(reason) {
  return /result artifact was not written|no such file|enoent/i.test(String(reason ?? ""));
}

export function shouldRetryGptRunnerLauncher({
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

  if (!isMissingResultArtifactReason(reason)) {
    return false;
  }

  return classifyGptRunnerTransientSignal(`${stdout}\n${stderr}`);
}

export function isExhaustedTransientGptRunnerFailure({
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

  if (!isMissingResultArtifactReason(reason)) {
    return false;
  }

  return classifyGptRunnerTransientSignal(`${execution?.stdout ?? ""}\n${execution?.stderr ?? ""}`);
}

export function isLauncherPermissionDeniedError(error) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    code === "EPERM" ||
    code === "EACCES" ||
    /spawn eperm|spawn eacces|permission denied|operation not permitted/i.test(message)
  );
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

export function isLauncherTimeoutError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === launcherTimeoutErrorCode);
}

export function executionFromError(error) {
  return {
    stdout: typeof error?.stdout === "string" ? error.stdout : "",
    stderr: typeof error?.stderr === "string" ? error.stderr : ""
  };
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

export async function runLauncherScript(scriptPath, timeoutMs = null) {
  return path.extname(scriptPath).toLowerCase() === ".sh"
    ? runShellScript(scriptPath, timeoutMs)
    : runPowerShellScript(scriptPath, timeoutMs);
}
