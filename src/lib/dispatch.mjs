import { execFile } from "node:child_process";
import { access, open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import { buildPowerShellFileArgs, getPowerShellInvocation } from "./powershell.mjs";
import { renderRunReport, updateTaskInRunState } from "./run-state.mjs";

const execFileAsync = promisify(execFile);
const dispatchLockSuffix = ".dispatch.lock";
const dispatchLockTimeoutMs = 15000;
const dispatchLockRetryDelayMs = 100;
const dispatchLockStaleMs = 120000;

function readPositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name];
  const parsedValue = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function getPowerShellTimeoutMs() {
  return readPositiveIntegerEnv("AI_FACTORY_POWERSHELL_TIMEOUT_MS", 120000);
}

function renderDispatchReport(summary, results) {
  return [
    "# Dispatch Report",
    "",
    `- mode: ${summary.mode}`,
    `- total: ${summary.total}`,
    `- executed: ${summary.executed}`,
    `- completed: ${summary.completed}`,
    `- incomplete: ${summary.incomplete}`,
    `- would_execute: ${summary.wouldExecute}`,
    `- skipped: ${summary.skipped}`,
    `- would_skip: ${summary.wouldSkip}`,
    `- failed: ${summary.failed}`,
    "",
    "## Results",
    ...results.map((result) => `- ${result.taskId} -> ${result.status} (${result.runtime})`)
  ].join("\n");
}

async function runPowerShellScript(scriptPath) {
  if (!(await fileExists(scriptPath))) {
    throw new Error(`Launcher script not found: ${scriptPath}`);
  }

  const runtime = getPowerShellInvocation();
  const powerShellTimeoutMs = getPowerShellTimeoutMs();

  try {
    return await execFileAsync(
      runtime.command,
      buildPowerShellFileArgs(scriptPath),
      {
        encoding: "utf8",
        windowsHide: runtime.windowsHide,
        timeout: powerShellTimeoutMs
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const timedOut =
      (typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "ETIMEDOUT") ||
          ("killed" in error && error.killed === true && "signal" in error && error.signal === "SIGTERM"))) ||
      /timed out/i.test(errorMessage);

    if (timedOut) {
      throw new Error(`Launcher timed out after ${powerShellTimeoutMs / 1000} seconds: ${scriptPath}`, {
        cause: error
      });
    }

    throw error;
  }
}

function shouldAutoExecute(runtimeId) {
  return runtimeId === "openclaw" || runtimeId === "local-ci" || runtimeId === "codex";
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value, { allowEmpty = false } = {}) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => isNonEmptyString(item))
  );
}

async function readResultArtifact(resultPath) {
  if (!resultPath || !(await fileExists(resultPath))) {
    return {
      exists: false,
      valid: false,
      artifact: null,
      reason: "Result artifact was not written."
    };
  }

  try {
    const artifact = await readJson(resultPath);
    const validStatus = new Set(["completed", "failed", "blocked"]);
    const valid =
      isNonEmptyString(artifact.summary) &&
      artifact.summary.trim().length >= 5 &&
      validStatus.has(artifact.status) &&
      isStringArray(artifact.changedFiles, { allowEmpty: true }) &&
      isStringArray(artifact.verification) &&
      isStringArray(artifact.notes);

    return {
      exists: true,
      valid,
      artifact,
      reason: valid ? null : "Result artifact exists but does not match the expected schema."
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      artifact: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function mapDispatchResultToTaskStatus(result) {
  if (result.status === "completed") {
    return "completed";
  }

  if (result.status === "failed") {
    return "failed";
  }

  if (result.status === "incomplete") {
    return "blocked";
  }

  return null;
}

export async function dispatchHandoffs(indexPath, mode = "dry-run") {
  if (mode !== "dry-run" && mode !== "execute") {
    throw new Error(`Unsupported dispatch mode: ${mode}`);
  }

  const resolvedIndexPath = path.resolve(indexPath);
  const handoffIndex = await readJson(resolvedIndexPath);
  const outputDir = path.dirname(resolvedIndexPath);
  const results = [];

  for (const descriptor of handoffIndex.descriptors) {
    const runtimeId = descriptor.runtime.id;

    if (mode === "dry-run") {
      results.push({
        taskId: descriptor.taskId,
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
        runtime: runtimeId,
        status: "skipped",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        note: "This runtime is currently treated as manual or hybrid only."
      });
      continue;
    }

    try {
      const execution = await runPowerShellScript(descriptor.launcherPath);
      const resultArtifact = await readResultArtifact(descriptor.resultPath ?? null);
      let status = "incomplete";
      let note = resultArtifact.reason ?? "Launcher finished but no result artifact was written.";

      if (resultArtifact.valid && resultArtifact.artifact?.status === "completed") {
        status = "completed";
        note = "Launcher finished and result artifact passed validation.";
      } else if (resultArtifact.valid && resultArtifact.artifact?.status === "failed") {
        status = "failed";
        note = "Runtime reported a failed task in the result artifact.";
      }

      results.push({
        taskId: descriptor.taskId,
        runtime: runtimeId,
        status,
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        stdout: execution.stdout.trim(),
        stderr: execution.stderr.trim(),
        note,
        artifact: resultArtifact.artifact
      });
    } catch (error) {
      results.push({
        taskId: descriptor.taskId,
        runtime: runtimeId,
        status: "failed",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode,
    total: results.length,
    executed: results.filter((item) => item.status === "completed" || item.status === "incomplete").length,
    completed: results.filter((item) => item.status === "completed").length,
    incomplete: results.filter((item) => item.status === "incomplete").length,
    wouldExecute: results.filter((item) => item.status === "would_execute").length,
    skipped: results.filter((item) => item.status === "skipped" || item.status === "would_skip").length,
    wouldSkip: results.filter((item) => item.status === "would_skip").length,
    failed: results.filter((item) => item.status === "failed").length
  };

  let runStateSync = null;

  if (mode === "execute") {
    const runDirectory = path.resolve(outputDir, "..");
    const runStatePath = path.join(runDirectory, "run-state.json");
    const planPath = path.join(runDirectory, "execution-plan.json");
    const reportPath = path.join(runDirectory, "report.md");

    if (await fileExists(runStatePath)) {
      runStateSync = await withDispatchLock(runStatePath, async () => {
        let runState = await readJson(runStatePath);
        const updatedTasks = [];

        for (const result of results) {
          const nextStatus = mapDispatchResultToTaskStatus(result);

          if (!nextStatus) {
            continue;
          }

          runState = updateTaskInRunState(
            runState,
            result.taskId,
            nextStatus,
            `dispatch:${result.status}`
          );
          updatedTasks.push({
            taskId: result.taskId,
            nextStatus
          });
        }

        await writeJson(runStatePath, runState);

        if (await fileExists(planPath)) {
          const plan = await readJson(planPath);
          await writeFile(reportPath, `${renderRunReport(runState, plan)}\n`, "utf8");
        }

        return {
          runStatePath,
          reportPath: (await fileExists(reportPath)) ? reportPath : null,
          updatedTasks
        };
      });
    }
  }

  await ensureDirectory(outputDir);

  const resultJsonPath = path.join(outputDir, "dispatch-results.json");
  const resultMarkdownPath = path.join(outputDir, "dispatch-results.md");

  await writeJson(resultJsonPath, {
    summary,
    results,
    runStateSync
  });
  await writeFile(resultMarkdownPath, `${renderDispatchReport(summary, results)}\n`, "utf8");

  return {
    resultJsonPath,
    resultMarkdownPath,
    summary,
    results,
    runStateSync
  };
}
