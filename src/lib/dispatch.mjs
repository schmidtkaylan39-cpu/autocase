import { execFile } from "node:child_process";
import { access, open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import {
  buildPowerShellFileArgs,
  getNonWindowsLauncherShellCommand,
  getPowerShellInvocation
} from "./powershell.mjs";
import { validateResultArtifact } from "./result-artifact.mjs";
import { renderRunReport, updateTaskInRunState } from "./run-state.mjs";

const execFileAsync = promisify(execFile);
const dispatchLockSuffix = ".dispatch.lock";
const descriptorExecutionLockSuffix = ".execute.lock";
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
      throw new Error(`PowerShell runtime is not available: ${runtime.command}`, {
        cause: error
      });
    }

    if (timedOut) {
      throw new Error(`Launcher timed out after ${powerShellTimeoutMs / 1000} seconds: ${scriptPath}`, {
        cause: error
      });
    }

    throw error;
  }
}

async function runShellScript(scriptPath) {
  if (!(await fileExists(scriptPath))) {
    throw new Error(`Launcher script not found: ${scriptPath}`);
  }

  const shellCommand = getNonWindowsLauncherShellCommand();
  const shellTimeoutMs = getPowerShellTimeoutMs();

  try {
    return await execFileAsync(shellCommand, [scriptPath], {
      encoding: "utf8",
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
      throw new Error(`Launcher shell is not available: ${shellCommand}`, {
        cause: error
      });
    }

    if (timedOut) {
      throw new Error(`Launcher timed out after ${shellTimeoutMs / 1000} seconds: ${scriptPath}`, {
        cause: error
      });
    }

    throw error;
  }
}

async function runLauncherScript(scriptPath) {
  return path.extname(scriptPath).toLowerCase() === ".sh"
    ? runShellScript(scriptPath)
    : runPowerShellScript(scriptPath);
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

function resolveDescriptorExecutionLockPath(descriptor) {
  const lockTarget = descriptor.resultPath ?? descriptor.launcherPath;
  return `${path.resolve(lockTarget)}${descriptorExecutionLockSuffix}`;
}

async function tryAcquireDescriptorExecutionLock(descriptor) {
  const lockPath = resolveDescriptorExecutionLockPath(descriptor);

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
        return tryAcquireDescriptorExecutionLock(descriptor);
      }
    } catch (statError) {
      if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") {
        throw statError;
      }

      return tryAcquireDescriptorExecutionLock(descriptor);
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
    note = withPrefix("Runtime reported a blocked task in the result artifact.");
  }

  return {
    taskId: descriptor.taskId,
    handoffId: descriptor.handoffId ?? null,
    runtime: runtimeId,
    status,
    launcherPath: descriptor.launcherPath,
    resultPath: descriptor.resultPath ?? null,
    artifact: resultArtifact.artifact,
    note,
    stdout: execution?.stdout ?? "",
    stderr: execution?.stderr ?? ""
  };
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

async function prepareTaskForExecution(runStatePath, planPath, reportPath, descriptor) {
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

    for (const result of results) {
      const nextStatus = mapDispatchResultToTaskStatus(result);

      if (!nextStatus) {
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

      runState = updateTaskInRunState(
        {
          ...runState,
          taskLedger: runState.taskLedger.map((item) =>
            item.id === result.taskId ? clearActiveHandoffFields(item) : item
          )
        },
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

export async function dispatchHandoffs(indexPath, mode = "dry-run") {
  if (mode !== "dry-run" && mode !== "execute") {
    throw new Error(`Unsupported dispatch mode: ${mode}`);
  }

  const resolvedIndexPath = path.resolve(indexPath);
  const handoffIndex = await readJson(resolvedIndexPath);
  const outputDir = path.dirname(resolvedIndexPath);
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
   *   stdout?: string,
   *   stderr?: string
   * }>} */
  const results = [];

  for (const descriptor of handoffIndex.descriptors) {
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

    try {
      const runDirectory = handoffIndex.runDirectory
        ? path.resolve(handoffIndex.runDirectory)
        : path.resolve(outputDir, "..");
      const runStatePath = handoffIndex.runStatePath
        ? path.resolve(handoffIndex.runStatePath)
        : path.join(runDirectory, "run-state.json");
      const planPath = path.join(runDirectory, "execution-plan.json");
      const reportPath = path.join(runDirectory, "report.md");
      const runId = descriptor.runId ?? handoffIndex.runId ?? null;
      const releaseExecutionLock = await tryAcquireDescriptorExecutionLock(descriptor);

      if (!releaseExecutionLock) {
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

      try {
        const preparation = await prepareTaskForExecution(runStatePath, planPath, reportPath, descriptor);

        if (!preparation.shouldExecute) {
          results.push({
            taskId: descriptor.taskId,
            handoffId: descriptor.handoffId ?? null,
            runtime: runtimeId,
            status: "skipped",
            launcherPath: descriptor.launcherPath,
            resultPath: descriptor.resultPath ?? null,
            note: preparation.note
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

        await removeExistingResultArtifact(descriptor.resultPath ?? null);
        const launcherStartedAtMs = Date.now();
        const execution = await runLauncherScript(descriptor.launcherPath);
        const resultArtifact = await readResultArtifactForExecution(descriptor.resultPath ?? null, {
          runId,
          taskId: descriptor.taskId,
          handoffId: descriptor.handoffId ?? null,
          minimumMtimeMs: launcherStartedAtMs
        });

        results.push(
          buildDispatchResultFromArtifact(
            descriptor,
            runtimeId,
            {
              ...resultArtifact,
              artifact: resultArtifact.artifact,
              reason: resultArtifact.reason
            },
            {
              stdout: execution.stdout.trim(),
              stderr: execution.stderr.trim()
            },
            "Launcher finished."
          )
        );
      } finally {
        await releaseExecutionLock();
      }
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
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode,
    total: results.length,
    executed: results.filter((item) =>
      item.status === "completed" || item.status === "incomplete" || item.status === "failed"
    ).length,
    completed: results.filter((item) => item.status === "completed").length,
    incomplete: results.filter((item) => item.status === "incomplete").length,
    wouldExecute: results.filter((item) => item.status === "would_execute").length,
    skipped: results.filter((item) => item.status === "skipped" || item.status === "would_skip").length,
    wouldSkip: results.filter((item) => item.status === "would_skip").length,
    failed: results.filter((item) => item.status === "failed").length
  };

  const runDirectory = handoffIndex.runDirectory
    ? path.resolve(handoffIndex.runDirectory)
    : path.resolve(outputDir, "..");
  const runStatePath = handoffIndex.runStatePath
    ? path.resolve(handoffIndex.runStatePath)
    : path.join(runDirectory, "run-state.json");
  const planPath = path.join(runDirectory, "execution-plan.json");
  const reportPath = path.join(runDirectory, "report.md");
  const runStateSync =
    mode === "execute"
      ? await syncDispatchResults(runStatePath, planPath, reportPath, results)
      : null;

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
