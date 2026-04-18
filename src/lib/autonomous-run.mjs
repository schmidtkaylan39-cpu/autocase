import path from "node:path";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";

import { tickProjectRun } from "./commands.mjs";
import { dispatchHandoffs } from "./dispatch.mjs";
import { readJson, writeJson } from "./fs-utils.mjs";
import { runRuntimeDoctor } from "./doctor.mjs";
import { renderRunReport, refreshRunState, summarizeRunState } from "./run-state.mjs";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

const autonomousLockSuffix = ".autonomous.lock";
const descriptorExecutionLockSuffix = ".execute.lock";
const autonomousLockStaleMs = 10 * 60 * 1000;
const autonomousLockUninitializedMs = 5 * 1000;
const descriptorExecutionLockStaleMs = 3 * 60 * 1000;

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function jsonFileExists(targetPath) {
  try {
    await readJson(targetPath);
    return true;
  } catch {
    return false;
  }
}

function readPositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name];
  const parsedValue = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function getAutonomousLockTimeoutMs() {
  return readPositiveIntegerEnv("AI_FACTORY_AUTONOMOUS_LOCK_TIMEOUT_MS", 500);
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

async function lockOwnedByDeadProcess(lockPath) {
  try {
    const lockContent = await readFile(lockPath, "utf8");
    const lockPid = parseLockPid(lockContent);

    if (lockPid === null) {
      return false;
    }

    return !isProcessAlive(lockPid);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function tryRemoveStaleLockFile(lockPath, staleAfterMs) {
  if (await lockOwnedByDeadProcess(lockPath)) {
    await rm(lockPath, { force: true }).catch(() => undefined);
    return true;
  }

  try {
    const lockStats = await stat(lockPath);
    const lockAgeMs = Date.now() - lockStats.mtimeMs;

    if (lockStats.size === 0 && lockAgeMs > autonomousLockUninitializedMs) {
      await rm(lockPath, { force: true }).catch(() => undefined);
      return true;
    }

    if (lockAgeMs > staleAfterMs) {
      await rm(lockPath, { force: true }).catch(() => undefined);
      return true;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }

    throw error;
  }

  return false;
}

async function acquireAutonomousLock(runStatePath) {
  const lockPath = `${runStatePath}${autonomousLockSuffix}`;
  const deadline = Date.now() + getAutonomousLockTimeoutMs();

  while (true) {
    try {
      const lockToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await writeFile(lockPath, `${process.pid} ${new Date().toISOString()} ${lockToken}\n`, {
        encoding: "utf8",
        flag: "wx"
      });

      return async () => {
        try {
          const currentLockContent = await readFile(lockPath, "utf8");

          if (currentLockContent.includes(lockToken)) {
            await rm(lockPath, { force: true });
          }
        } catch {
          // ignore lock cleanup errors
        }
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      if (await tryRemoveStaleLockFile(lockPath, autonomousLockStaleMs)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Another autonomous loop is already running for this run-state: ${runStatePath}`,
          { cause: error }
        );
      }
    }
  }
}

function clearTaskExecutionState(task) {
  return {
    ...task,
    activeHandoffId: null,
    activeResultPath: null,
    activeHandoffOutputDir: null,
    nextRetryAt: null,
    lastRetryReason: null
  };
}

function appendAutonomousNote(task, note) {
  return {
    ...task,
    notes: [...safeArray(task.notes), `${new Date().toISOString()} ${note}`]
  };
}

function countAutonomousRequeues(task) {
  return safeArray(task.notes).filter((note) => /autonomous-requeue:/i.test(note)).length;
}

function extractFeatureId(taskId) {
  const match = /^(implement|review|verify)-(.+)$/.exec(String(taskId));
  return match ? match[2] : null;
}

function buildFeatureTaskIds(sourceTaskId) {
  const featureId = extractFeatureId(sourceTaskId);

  if (!featureId) {
    return null;
  }

  return {
    featureId,
    implementationTaskId: `implement-${featureId}`,
    reviewTaskId: `review-${featureId}`,
    verificationTaskId: `verify-${featureId}`
  };
}

function parseNoteTimestamp(note) {
  const match = /^(\d{4}-\d{2}-\d{2}T[^\s]+)/.exec(String(note));

  if (!match) {
    return null;
  }

  const timestampMs = Date.parse(match[1]);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function findLatestDispatchClaimTimestamp(task) {
  let latest = null;

  for (const note of safeArray(task.notes)) {
    if (!/dispatch:claimed/i.test(note)) {
      continue;
    }

    const timestampMs = parseNoteTimestamp(note);

    if (timestampMs === null) {
      continue;
    }

    if (latest === null || timestampMs > latest) {
      latest = timestampMs;
    }
  }

  return latest;
}

function hasDispatchOutcomeAfter(task, claimTimestampMs) {
  for (const note of safeArray(task.notes)) {
    if (
      !/dispatch:(completed|failed|blocked|incomplete|invalid-automation-decision)/i.test(note)
    ) {
      continue;
    }

    const timestampMs = parseNoteTimestamp(note);

    if (timestampMs !== null && timestampMs > claimTimestampMs) {
      return true;
    }
  }

  return false;
}

async function taskExecutionLockExists(task) {
  if (typeof task.activeResultPath !== "string" || task.activeResultPath.trim().length === 0) {
    return false;
  }

  const executionLockPath = `${path.resolve(task.activeResultPath)}${descriptorExecutionLockSuffix}`;

  if (!(await fileExists(executionLockPath))) {
    return false;
  }

  if (await tryRemoveStaleLockFile(executionLockPath, descriptorExecutionLockStaleMs)) {
    return false;
  }

  return true;
}

async function maybeRecoverStalledInProgress(runState) {
  for (const task of runState.taskLedger) {
    if (task.status !== "in_progress") {
      continue;
    }

    const latestClaimTimestamp = findLatestDispatchClaimTimestamp(task);

    if (latestClaimTimestamp === null) {
      continue;
    }

    if (hasDispatchOutcomeAfter(task, latestClaimTimestamp)) {
      continue;
    }

    if (await taskExecutionLockExists(task)) {
      continue;
    }

    const reason = "stale in-progress task without dispatch completion note";

    if (task.role === "reviewer" || task.role === "verifier" || task.role === "executor") {
      const recovery = reopenFeatureChain(runState, task.id, reason);

      if (recovery.changed) {
        return recovery;
      }
    }

    if ((task.role === "planner" || task.role === "orchestrator") && task.id === "planning-brief") {
      return reopenPlannerTask(runState, task.id, reason);
    }

    if (task.role === "orchestrator" && task.id === "delivery-package") {
      return reopenSingleTask(runState, task.id, reason);
    }
  }

  return {
    changed: false,
    recovery: null,
    runState
  };
}

function reopenFeatureChain(runState, sourceTaskId, reason) {
  const ids = buildFeatureTaskIds(sourceTaskId);

  if (!ids) {
    return {
      changed: false,
      recovery: null,
      runState
    };
  }

  const implementationTask = runState.taskLedger.find((task) => task.id === ids.implementationTaskId);

  if (!implementationTask) {
    return {
      changed: false,
      recovery: null,
      runState
    };
  }

  const currentRequeueCount = countAutonomousRequeues(implementationTask);
  const maxRequeues = implementationTask.retriesBeforeReplan ?? runState.retryPolicy?.implementation ?? 3;

  if (currentRequeueCount >= maxRequeues) {
    return reopenPlanningForFeature(runState, ids, reason);
  }

  const nextTaskLedger = runState.taskLedger.map((task) => {
    if (task.id === ids.implementationTaskId) {
      return appendAutonomousNote(
        {
          ...clearTaskExecutionState(task),
          status: "ready"
        },
        `autonomous-requeue:${sourceTaskId} ${reason}`
      );
    }

    if (task.id === ids.reviewTaskId || task.id === ids.verificationTaskId) {
      return appendAutonomousNote(
        {
          ...clearTaskExecutionState(task),
          status: "pending"
        },
        `autonomous-reset:${sourceTaskId} ${reason}`
      );
    }

    if (task.id === "delivery-package" && task.status !== "completed") {
      return {
        ...clearTaskExecutionState(task),
        status: "pending"
      };
    }

    return task;
  });

  return {
    changed: true,
    recovery: {
      type: "feature_rework",
      sourceTaskId,
      targetTaskIds: [ids.implementationTaskId, ids.reviewTaskId, ids.verificationTaskId],
      reason
    },
    runState: refreshRunState({
      ...runState,
      updatedAt: new Date().toISOString(),
      taskLedger: nextTaskLedger
    })
  };
}

function reopenPlanningForFeature(runState, ids, reason) {
  const nextTaskLedger = runState.taskLedger.map((task) => {
    if (task.id === "planning-brief") {
      return appendAutonomousNote(
        {
          ...clearTaskExecutionState(task),
          status: "ready"
        },
        `autonomous-replan:${ids.featureId} ${reason}`
      );
    }

    if ([ids.implementationTaskId, ids.reviewTaskId, ids.verificationTaskId].includes(task.id)) {
      return appendAutonomousNote(
        {
          ...clearTaskExecutionState(task),
          status: "pending"
        },
        `autonomous-replan-wait:${ids.featureId} ${reason}`
      );
    }

    if (task.id === "delivery-package" && task.status !== "completed") {
      return {
        ...clearTaskExecutionState(task),
        status: "pending"
      };
    }

    return task;
  });

  return {
    changed: true,
    recovery: {
      type: "feature_replan",
      sourceTaskId: `implement-${ids.featureId}`,
      targetTaskIds: ["planning-brief", ids.implementationTaskId, ids.reviewTaskId, ids.verificationTaskId],
      reason
    },
    runState: refreshRunState({
      ...runState,
      updatedAt: new Date().toISOString(),
      taskLedger: nextTaskLedger
    })
  };
}

function reopenPlannerTask(runState, taskId, reason) {
  const nextTaskLedger = runState.taskLedger.map((task) =>
    task.id === taskId
      ? appendAutonomousNote(
          {
            ...clearTaskExecutionState(task),
            status: "ready"
          },
          `autonomous-planner-retry:${reason}`
        )
      : task
  );

  return {
    changed: true,
    recovery: {
      type: "planner_retry",
      sourceTaskId: taskId,
      targetTaskIds: [taskId],
      reason
    },
    runState: refreshRunState({
      ...runState,
      updatedAt: new Date().toISOString(),
      taskLedger: nextTaskLedger
    })
  };
}

function reopenSingleTask(runState, taskId, reason) {
  const nextTaskLedger = runState.taskLedger.map((task) =>
    task.id === taskId
      ? appendAutonomousNote(
          {
            ...clearTaskExecutionState(task),
            status: "ready"
          },
          `autonomous-task-retry:${reason}`
        )
      : task
  );

  return {
    changed: true,
    recovery: {
      type: "task_retry",
      sourceTaskId: taskId,
      targetTaskIds: [taskId],
      reason
    },
    runState: refreshRunState({
      ...runState,
      updatedAt: new Date().toISOString(),
      taskLedger: nextTaskLedger
    })
  };
}

function maybeRecoverRunState(runState) {
  for (const task of runState.taskLedger) {
    if (!["blocked", "failed"].includes(task.status)) {
      continue;
    }

    if (task.role === "reviewer" || task.role === "verifier" || task.role === "executor") {
      const reason = task.status === "failed" ? "task failed during autonomous loop" : "task blocked during autonomous loop";
      const recovery = reopenFeatureChain(runState, task.id, reason);

      if (recovery.changed) {
        return recovery;
      }
    }

    if ((task.role === "planner" || task.role === "orchestrator") && task.id === "planning-brief") {
      return reopenPlannerTask(runState, task.id, "planning task requires another automated pass");
    }

    if (task.role === "orchestrator" && task.id === "delivery-package") {
      return reopenSingleTask(runState, task.id, "delivery packaging requires another automated pass");
    }
  }

  return {
    changed: false,
    recovery: null,
    runState
  };
}

async function writeRunReport(runDirectory, runState) {
  const planPath = path.join(runDirectory, "execution-plan.json");
  const plan = await readJson(planPath);
  const reportPath = path.join(runDirectory, "report.md");
  await writeJson(path.join(runDirectory, "run-state.json"), runState);
  await writeFile(reportPath, `${renderRunReport(runState, plan)}\n`, "utf8");
}

function buildSummaryMarkdown(summary) {
  return [
    "# Autonomous Run Summary",
    "",
    `- Run ID: ${summary.runId}`,
    `- Final status: ${summary.finalStatus}`,
    `- Rounds attempted: ${summary.rounds.length}`,
    `- Doctor report: ${summary.doctorReportPath}`,
    "",
    "## Rounds",
    ...summary.rounds.map((round) => {
      const bits = [
        `- round ${round.round}: status=${round.statusBefore}`,
        `ready=${round.readyTaskCount}`,
        `dispatchCompleted=${round.dispatchSummary?.completed ?? 0}`,
        `dispatchBlocked=${round.dispatchSummary?.incomplete ?? 0}`,
        `dispatchFailed=${round.dispatchSummary?.failed ?? 0}`
      ];

      if (round.recovery) {
        bits.push(`recovery=${round.recovery.type}`);
      }

      if (round.stopReason) {
        bits.push(`stop=${round.stopReason}`);
      }

      return bits.join(", ");
    })
  ].join("\n");
}

/**
 * @typedef {object} AutonomousOperations
 * @property {(outputDir?: string, workspaceRoot?: string) => Promise<{ jsonPath: string }>} [runRuntimeDoctor]
 * @property {(runStatePath: string, doctorReportPath?: string, outputDir?: string) => Promise<{ handoffIndexPath: string, readyTaskCount: number }>} [tickProjectRun]
 * @property {(handoffIndexPath: string, mode?: string) => Promise<{ summary: { executed?: number, completed?: number, continued?: number, incomplete?: number, failed?: number, skipped?: number } }>} [dispatchHandoffs]
 */

/**
 * @typedef {object} AutonomousRunOptions
 * @property {string} [doctorOutputDir]
 * @property {string} [doctorReportPath]
 * @property {string} [handoffOutputDir]
 * @property {number} [maxRounds]
 * @property {AutonomousOperations} [operations]
 */

/**
 * @param {string} runStatePath
 * @param {AutonomousRunOptions} [options]
 */
export async function runAutonomousLoop(
  runStatePath,
  {
    doctorOutputDir,
    doctorReportPath,
    handoffOutputDir,
    maxRounds = 20,
    operations = {}
  } = {}
) {
  const runDoctorOperation = operations.runRuntimeDoctor ?? runRuntimeDoctor;
  const tickOperation = operations.tickProjectRun ?? tickProjectRun;
  const dispatchOperation = operations.dispatchHandoffs ?? dispatchHandoffs;
  const resolvedRunStatePath = path.resolve(runStatePath);
  const releaseAutonomousLock = await acquireAutonomousLock(resolvedRunStatePath);

  try {
    const runDirectory = path.dirname(resolvedRunStatePath);
    const runState = await readJson(resolvedRunStatePath);
    const workspaceRoot =
      typeof runState?.workspacePath === "string" && runState.workspacePath.trim().length > 0
        ? path.resolve(runState.workspacePath)
        : path.resolve(runDirectory, "..");
    const resolvedDoctorOutputDir = doctorOutputDir
      ? path.resolve(doctorOutputDir)
      : path.join(workspaceRoot, "reports");
    const doctorResult = await runDoctorOperation(resolvedDoctorOutputDir, workspaceRoot);
    const requestedDoctorReportPath =
      typeof doctorReportPath === "string" && doctorReportPath.trim().length > 0
        ? path.isAbsolute(doctorReportPath)
          ? path.resolve(doctorReportPath)
          : path.resolve(workspaceRoot, doctorReportPath)
        : null;
    const effectiveDoctorReportPath =
      requestedDoctorReportPath && (await jsonFileExists(requestedDoctorReportPath))
        ? requestedDoctorReportPath
        : doctorResult.jsonPath;
    const resolvedHandoffOutputDir = handoffOutputDir
      ? path.resolve(handoffOutputDir)
      : path.join(runDirectory, "handoffs-autonomous");
    const rounds = [];
    let stopReason = null;

    for (let round = 1; round <= maxRounds; round += 1) {
      let currentRunState = refreshRunState(await readJson(resolvedRunStatePath));
      await writeRunReport(runDirectory, currentRunState);

      if (currentRunState.status === "completed") {
        stopReason = "run completed";
        break;
      }

      const roundRecord = {
        round,
        statusBefore: currentRunState.status,
        readyTaskCount: 0,
        dispatchSummary: null,
        recovery: null,
        stopReason: null
      };

      const staleInProgressRecovery = await maybeRecoverStalledInProgress(currentRunState);

      if (staleInProgressRecovery.changed) {
        await writeRunReport(runDirectory, staleInProgressRecovery.runState);
        roundRecord.recovery = staleInProgressRecovery.recovery;
        rounds.push(roundRecord);
        continue;
      }

      const recoveryBeforeTick = maybeRecoverRunState(currentRunState);

      if (recoveryBeforeTick.changed) {
        await writeRunReport(runDirectory, recoveryBeforeTick.runState);
        roundRecord.recovery = recoveryBeforeTick.recovery;
        rounds.push(roundRecord);
        continue;
      }

      const tickResult = await tickOperation(
        resolvedRunStatePath,
        effectiveDoctorReportPath,
        resolvedHandoffOutputDir
      );
      roundRecord.readyTaskCount = tickResult.readyTaskCount;

      if (tickResult.readyTaskCount === 0) {
        currentRunState = refreshRunState(await readJson(resolvedRunStatePath));

        if (currentRunState.status === "completed") {
          stopReason = "run completed";
        } else if (currentRunState.status === "attention_required") {
          stopReason = "attention required with no automatic recovery available";
        } else {
          stopReason = "no ready tasks were available for autonomous dispatch";
        }

        roundRecord.stopReason = stopReason;
        rounds.push(roundRecord);
        break;
      }

      const dispatchResult = await dispatchOperation(tickResult.handoffIndexPath, "execute");
      roundRecord.dispatchSummary = dispatchResult.summary;

      if ((dispatchResult.summary?.executed ?? 0) === 0) {
        stopReason =
          (dispatchResult.summary?.skipped ?? 0) > 0
            ? "dispatch skipped all ready tasks; no automatic runtime was available"
            : "dispatch produced no executable work";
        roundRecord.stopReason = stopReason;
        rounds.push(roundRecord);
        break;
      }

      const recoveryAfterDispatch = maybeRecoverRunState(refreshRunState(await readJson(resolvedRunStatePath)));

      if (recoveryAfterDispatch.changed) {
        await writeRunReport(runDirectory, recoveryAfterDispatch.runState);
        roundRecord.recovery = recoveryAfterDispatch.recovery;
      }

      rounds.push(roundRecord);
    }

    const finalRunState = refreshRunState(await readJson(resolvedRunStatePath));
    const summary = {
      runId: finalRunState.runId,
      finalStatus: finalRunState.status,
      doctorReportPath: effectiveDoctorReportPath,
      rounds,
      stopReason: stopReason ?? (finalRunState.status === "completed" ? "run completed" : "maximum rounds reached"),
      runSummary: summarizeRunState(finalRunState)
    };
    const summaryJsonPath = path.join(runDirectory, "autonomous-summary.json");
    const summaryMarkdownPath = path.join(runDirectory, "autonomous-summary.md");

    await writeJson(summaryJsonPath, summary);
    await writeFile(summaryMarkdownPath, `${buildSummaryMarkdown(summary)}\n`, "utf8");

    return {
      summaryJsonPath,
      summaryMarkdownPath,
      doctorReportPath: effectiveDoctorReportPath,
      rounds,
      summary
    };
  } finally {
    await releaseAutonomousLock();
  }
}
