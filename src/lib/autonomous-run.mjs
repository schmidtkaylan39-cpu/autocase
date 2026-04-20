import path from "node:path";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";

import { tickProjectRun } from "./commands.mjs";
import { dispatchHandoffs } from "./dispatch.mjs";
import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import { runRuntimeDoctor } from "./doctor.mjs";
import { renderRunReport, refreshRunState, summarizeRunState } from "./run-state.mjs";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function dedupeText(items) {
  return [...new Set(safeArray(items).filter(isNonEmptyString).map((item) => item.trim()))];
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

function getAutonomousNoProgressCycleLimit() {
  return readPositiveIntegerEnv("AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES", 2);
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

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePositiveInteger(value, fallbackValue) {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function countAutonomousRequeues(task, sourceTaskId = null) {
  const sourcePattern = isNonEmptyString(sourceTaskId)
    ? new RegExp(`autonomous-requeue:${escapeForRegex(sourceTaskId)}\\b`, "i")
    : /autonomous-requeue:/i;

  return safeArray(task.notes).filter((note) => sourcePattern.test(note)).length;
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

function resolveFeatureReplanBudget(runState, sourceTaskId, ids) {
  const retryPolicy = runState.retryPolicy ?? {};
  const implementationTask = runState.taskLedger.find((task) => task.id === ids.implementationTaskId);
  const reviewTask = runState.taskLedger.find((task) => task.id === ids.reviewTaskId);
  const verificationTask = runState.taskLedger.find((task) => task.id === ids.verificationTaskId);

  if (typeof sourceTaskId === "string" && sourceTaskId.startsWith("review-")) {
    return normalizePositiveInteger(
      reviewTask?.retriesBeforeReplan ?? retryPolicy.review,
      normalizePositiveInteger(retryPolicy.implementation, 2)
    );
  }

  if (typeof sourceTaskId === "string" && sourceTaskId.startsWith("verify-")) {
    return normalizePositiveInteger(
      verificationTask?.retriesBeforeReplan ?? retryPolicy.verification,
      normalizePositiveInteger(retryPolicy.implementation, 2)
    );
  }

  return normalizePositiveInteger(
    implementationTask?.retriesBeforeReplan ?? retryPolicy.implementation,
    3
  );
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
    return {
      exists: false,
      recovered: false,
      recoveryReason: null
    };
  }

  const executionLockPath = `${path.resolve(task.activeResultPath)}${descriptorExecutionLockSuffix}`;

  if (!(await fileExists(executionLockPath))) {
    return {
      exists: false,
      recovered: false,
      recoveryReason: null
    };
  }

  try {
    const [lockContent, lockStats] = await Promise.all([
      readFile(executionLockPath, "utf8").catch(() => ""),
      stat(executionLockPath)
    ]);
    const lockPid = parseLockPid(lockContent);
    const lockAgeMs = Date.now() - lockStats.mtimeMs;

    if (lockPid !== null && !isProcessAlive(lockPid)) {
      await rm(executionLockPath, { force: true }).catch(() => undefined);
      return {
        exists: false,
        recovered: true,
        recoveryReason:
          `recovered orphaned execution lock for task ${task.id} ` +
          `(dead pid ${lockPid}, path ${executionLockPath})`
      };
    }

    if (lockStats.size === 0 && lockAgeMs > autonomousLockUninitializedMs) {
      await rm(executionLockPath, { force: true }).catch(() => undefined);
      return {
        exists: false,
        recovered: true,
        recoveryReason:
          `recovered uninitialized execution lock for task ${task.id} ` +
          `(age ${lockAgeMs}ms, path ${executionLockPath})`
      };
    }

    if (lockAgeMs > descriptorExecutionLockStaleMs) {
      await rm(executionLockPath, { force: true }).catch(() => undefined);
      return {
        exists: false,
        recovered: true,
        recoveryReason:
          `recovered stale execution lock for task ${task.id} ` +
          `(age ${lockAgeMs}ms, path ${executionLockPath})`
      };
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        exists: false,
        recovered: false,
        recoveryReason: null
      };
    }

    throw error;
  }

  return {
    exists: true,
    recovered: false,
    recoveryReason: null
  };
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

    const executionLockState = await taskExecutionLockExists(task);

    if (executionLockState.exists) {
      continue;
    }

    const reason = executionLockState.recovered
      ? `stale in-progress task without dispatch completion note (${executionLockState.recoveryReason})`
      : "stale in-progress task without dispatch completion note";

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

  const currentRequeueCount = countAutonomousRequeues(implementationTask, sourceTaskId);
  const maxRequeues = resolveFeatureReplanBudget(runState, sourceTaskId, ids);

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

function markSkippedDispatchTasksAsBlocked(runState, dispatchResults, reason) {
  const skippedTaskIds = new Set(
    safeArray(dispatchResults)
      .filter((result) => result?.status === "skipped" && isNonEmptyString(result?.taskId))
      .map((result) => result.taskId)
  );

  if (skippedTaskIds.size === 0) {
    for (const task of safeArray(runState.taskLedger)) {
      if (task?.status === "ready" && isNonEmptyString(task?.id)) {
        skippedTaskIds.add(task.id);
      }
    }
  }

  if (skippedTaskIds.size === 0) {
    return runState;
  }

  const nextTaskLedger = runState.taskLedger.map((task) => {
    if (!skippedTaskIds.has(task.id)) {
      return task;
    }

    if (["blocked", "failed", "completed"].includes(task.status)) {
      return task;
    }

    return appendAutonomousNote(
      {
        ...clearTaskExecutionState(task),
        status: "blocked"
      },
      `autonomous-runtime-unavailable:${reason}`
    );
  });

  return refreshRunState({
    ...runState,
    updatedAt: new Date().toISOString(),
    taskLedger: nextTaskLedger
  });
}

async function writeRunReport(runDirectory, runState) {
  const planPath = path.join(runDirectory, "execution-plan.json");
  const plan = await readJson(planPath);
  const reportPath = path.join(runDirectory, "report.md");
  await writeJson(path.join(runDirectory, "run-state.json"), runState);
  await writeFile(reportPath, `${renderRunReport(runState, plan)}\n`, "utf8");
}

function findTaskStatusTransition(previousRunState, nextRunState, targetStatus) {
  const previousStatuses = new Map(
    safeArray(previousRunState?.taskLedger).map((task) => [task.id, task.status])
  );

  for (const task of safeArray(nextRunState?.taskLedger)) {
    if (!isNonEmptyString(task?.id) || task?.status !== targetStatus) {
      continue;
    }

    if (previousStatuses.get(task.id) !== targetStatus) {
      return task.id;
    }
  }

  return null;
}

function listTaskIdsByStatus(taskLedger, statuses) {
  const allowedStatuses = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  return safeArray(taskLedger)
    .filter((task) => allowedStatuses.has(task?.status) && isNonEmptyString(task?.id))
    .map((task) => task.id);
}

function hasDegradedRuntimeSignal(runState) {
  return safeArray(runState?.taskLedger).some((task) =>
    safeArray(task?.notes).some((note) => /acceptance-model-degrade:/i.test(String(note)))
  );
}

function deriveRoundProgress({ beforeRunState, afterRunState, dispatchSummary = null, recovery = null }) {
  const beforeSummary = summarizeRunState(beforeRunState);
  const afterSummary = summarizeRunState(afterRunState);
  const completedTaskId = findTaskStatusTransition(beforeRunState, afterRunState, "completed");

  if (afterSummary.completedTasks > beforeSummary.completedTasks || completedTaskId) {
    return {
      progressed: true,
      event: "task_completed",
      taskId: completedTaskId
    };
  }

  const readyTaskId = findTaskStatusTransition(beforeRunState, afterRunState, "ready");

  if (afterSummary.readyTasks > beforeSummary.readyTasks) {
    return {
      progressed: true,
      event: recovery ? "automatic_recovery_ready" : "automatic_work_ready",
      taskId: readyTaskId ?? recovery?.targetTaskIds?.[0] ?? null
    };
  }

  if ((dispatchSummary?.completed ?? 0) > 0) {
    return {
      progressed: true,
      event: "dispatch_completed",
      taskId:
        safeArray(dispatchSummary?.results)
          .find((result) => result?.status === "completed" && isNonEmptyString(result?.taskId))
          ?.taskId ?? null
    };
  }

  return {
    progressed: false,
    event: null,
    taskId: null
  };
}

function shouldCountNoProgressCycle({ beforeRunState, afterRunState, dispatchSummary = null }) {
  const beforeSummary = summarizeRunState(beforeRunState);
  const afterSummary = summarizeRunState(afterRunState);
  const remainingTasks = afterSummary.totalTasks - afterSummary.completedTasks;
  const activeTaskIds = listTaskIdsByStatus(afterRunState.taskLedger, ["blocked", "waiting_retry", "in_progress"]);

  if (remainingTasks <= 0) {
    return false;
  }

  if (afterSummary.completedTasks > beforeSummary.completedTasks) {
    return false;
  }

  if (afterSummary.readyTasks > beforeSummary.readyTasks) {
    return false;
  }

  if ((dispatchSummary?.completed ?? 0) > 0) {
    return false;
  }

  return afterSummary.readyTasks === 0 && activeTaskIds.length > 0;
}

function materializeNoProgressAttention(runState, reason, skippedAutomaticTaskIds = []) {
  const targetTaskIds = new Set([
    ...listTaskIdsByStatus(runState.taskLedger, ["in_progress", "waiting_retry", "ready"]),
    ...safeArray(skippedAutomaticTaskIds).filter(isNonEmptyString)
  ]);

  if (targetTaskIds.size === 0) {
    return refreshRunState(runState);
  }

  const nextTaskLedger = runState.taskLedger.map((task) => {
    if (!targetTaskIds.has(task.id) || ["completed", "failed", "blocked"].includes(task.status)) {
      return task;
    }

    return appendAutonomousNote(
      {
        ...clearTaskExecutionState(task),
        status: "blocked"
      },
      `autonomous-no-progress:${reason}`
    );
  });

  return refreshRunState({
    ...runState,
    updatedAt: new Date().toISOString(),
    taskLedger: nextTaskLedger
  });
}

function buildAutonomousProgressDiagnostics(
  runState,
  {
    lastProgressAt = null,
    lastProgressTaskId = null,
    lastProgressEvent = null,
    consecutiveNoProgressCycles = 0,
    skippedAutomaticTaskIds = []
  } = {}
) {
  return {
    lastProgressAt,
    lastProgressTaskId,
    lastProgressEvent,
    consecutiveNoProgressCycles,
    blockedTaskIds: listTaskIdsByStatus(runState?.taskLedger, ["blocked"]),
    waitingRetryTaskIds: listTaskIdsByStatus(runState?.taskLedger, ["waiting_retry"]),
    skippedAutomaticTaskIds: Array.from(
      new Set(safeArray(skippedAutomaticTaskIds).filter(isNonEmptyString))
    ),
    degradedRuntimeActive: hasDegradedRuntimeSignal(runState)
  };
}

async function writeAutonomousSummaryArtifacts(runDirectory, summary) {
  const summaryJsonPath = path.join(runDirectory, "autonomous-summary.json");
  const summaryMarkdownPath = path.join(runDirectory, "autonomous-summary.md");

  await writeJson(summaryJsonPath, summary);
  await writeFile(summaryMarkdownPath, `${buildSummaryMarkdown(summary)}\n`, "utf8");

  return {
    summaryJsonPath,
    summaryMarkdownPath
  };
}

function buildSummaryMarkdown(summary) {
  const lines = [
    "# Autonomous Run Summary",
    "",
    `- Run ID: ${summary.runId}`,
    `- Final status: ${summary.finalStatus}`,
    `- Rounds attempted: ${summary.rounds.length}`,
    `- Doctor report: ${summary.doctorReportPath}`,
    `- Failure-feedback artifacts: ${summary.failureFeedback?.count ?? 0}`,
    "",
    "## Diagnostics",
    `- Last progress at: ${summary.progressDiagnostics?.lastProgressAt ?? "n/a"}`,
    `- Last progress task: ${summary.progressDiagnostics?.lastProgressTaskId ?? "n/a"}`,
    `- Last progress event: ${summary.progressDiagnostics?.lastProgressEvent ?? "n/a"}`,
    `- Consecutive no-progress cycles: ${summary.progressDiagnostics?.consecutiveNoProgressCycles ?? 0}`,
    `- Blocked task ids: ${(summary.progressDiagnostics?.blockedTaskIds ?? []).join(", ") || "none"}`,
    `- Waiting-retry task ids: ${(summary.progressDiagnostics?.waitingRetryTaskIds ?? []).join(", ") || "none"}`,
    `- Skipped automatic task ids: ${(summary.progressDiagnostics?.skippedAutomaticTaskIds ?? []).join(", ") || "none"}`,
    `- Degraded runtime active: ${summary.progressDiagnostics?.degradedRuntimeActive ? "yes" : "no"}`,
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

        if (round.recovery.reason) {
          bits.push(`recoveryReason=${round.recovery.reason}`);
        }
      }

      if (round.stopReason) {
        bits.push(`stop=${round.stopReason}`);
      }

      if (round.progressEvent) {
        bits.push(`progress=${round.progressEvent}${round.progressTaskId ? `:${round.progressTaskId}` : ""}`);
      }

      if (Number.isFinite(round.consecutiveNoProgressCycles)) {
        bits.push(`noProgress=${round.consecutiveNoProgressCycles}`);
      }

      return bits.join(", ");
    })
  ];

  if ((summary.failureFeedback?.count ?? 0) > 0) {
    lines.push(
      "",
      "## Failure Feedback",
      `- index: ${summary.failureFeedback.indexPath ?? "n/a"}`,
      `- generated test cases: ${summary.failureFeedback.generatedTestCasesPath ?? "n/a"}`
    );
  }

  return lines.join("\n");
}

function slugifyLabel(value, fallback = "entry") {
  if (!isNonEmptyString(value)) {
    return fallback;
  }

  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : fallback;
}

function classifyFailureCategory(reason = "") {
  const text = String(reason).toLowerCase();

  if (/rate limit|too many requests|429/.test(text)) {
    return "rate_limit";
  }

  if (/timeout|timed out|etimedout/.test(text)) {
    return "timeout";
  }

  if (/missing|not found|enoent|npm ci|dependency/.test(text)) {
    return "missing_dependency";
  }

  if (
    /502|503|bad gateway|service unavailable|network|dns|connection|stream disconnected|reconnecting|provider or transport|runtime is not available|shell is not available|transient gpt runner|spawn eperm|spawn eacces|permission denied|operation not permitted|policy restriction|launcher process creation was denied/.test(
      text
    )
  ) {
    return "environment_mismatch";
  }

  if (/artifact|schema|invalid json|prompt hash mismatch|idempotency key mismatch/.test(text)) {
    return "artifact_invalid";
  }

  if (/verification|test failed|lint|typecheck|build failed/.test(text)) {
    return "verification_failed";
  }

  if (/logic|state transition|stale|dependency/.test(text)) {
    return "logic_bug";
  }

  return "unknown";
}

function isRetryableCategory(category) {
  return ["rate_limit", "timeout", "environment_mismatch", "missing_dependency"].includes(category);
}

function deriveLikelyCause(category, reason) {
  if (category === "rate_limit") {
    return "Upstream service throttled the request.";
  }

  if (category === "timeout") {
    return "Runtime execution exceeded the configured step timeout.";
  }

  if (category === "missing_dependency") {
    return "Required local dependency or runtime binary was unavailable.";
  }

  if (category === "environment_mismatch") {
    return "Runtime, network, or upstream provider availability was unstable.";
  }

  if (category === "artifact_invalid") {
    return "Generated artifact did not satisfy the expected contract.";
  }

  if (category === "verification_failed") {
    return "Verification gates reported a failing result.";
  }

  if (category === "logic_bug") {
    return "State machine behavior or transition assumptions were violated.";
  }

  return isNonEmptyString(reason)
    ? "Unable to classify automatically; inspect evidence for precise cause."
    : "No diagnostic message was captured.";
}

function deriveNextBestAction(category) {
  if (category === "rate_limit") {
    return "Retry with backoff and keep deterministic prompt/hash inputs unchanged.";
  }

  if (category === "timeout") {
    return "Inspect runtime logs, then increase timeout budget only if required by evidence.";
  }

  if (category === "missing_dependency") {
    return "Install missing dependencies (for example run npm ci) and rerun the failed task.";
  }

  if (category === "environment_mismatch") {
    return "Retry the same handoff after runtime, network, or upstream provider availability recovers.";
  }

  if (category === "artifact_invalid") {
    return "Fix artifact contract compliance and rerun the same task with identical inputs.";
  }

  if (category === "verification_failed") {
    return "Address failing checks and rerun the verifier stage.";
  }

  if (category === "logic_bug") {
    return "Capture a minimal repro and add a targeted regression test before retrying.";
  }

  return "Review evidence and choose the smallest safe retry or recovery step.";
}

function createFailureFeedbackEntry({
  runId,
  round,
  taskId,
  status,
  reason,
  evidence
}) {
  const category = classifyFailureCategory(reason);

  return {
    runId,
    taskId: taskId ?? "unknown-task",
    round,
    category,
    summary: isNonEmptyString(reason)
      ? reason
      : `Autonomous dispatch produced status=${status} without a detailed error message.`,
    evidence: safeArray(evidence).filter(isNonEmptyString),
    likelyCause: deriveLikelyCause(category, reason),
    nextBestAction: deriveNextBestAction(category),
    retryable: isRetryableCategory(category),
    status: status ?? "failed"
  };
}

function buildFailureLearningCase(entry, artifactPath) {
  return {
    id: `ff-${slugifyLabel(entry.runId, "run")}-r${entry.round}-${slugifyLabel(entry.taskId, "task")}`,
    sourceFeedbackPath: artifactPath,
    scenario: entry.summary,
    category: entry.category,
    expectedBehavior: entry.nextBestAction,
    retryable: entry.retryable
  };
}

async function persistFailureFeedbackArtifacts(runDirectory, entries) {
  const normalizedEntries = safeArray(entries);

  if (normalizedEntries.length === 0) {
    return {
      count: 0,
      directory: null,
      indexPath: null,
      generatedTestCasesPath: null
    };
  }

  const feedbackDirectory = path.join(runDirectory, "artifacts", "failure-feedback");
  await ensureDirectory(feedbackDirectory);
  const writtenArtifacts = [];

  for (const [index, entry] of normalizedEntries.entries()) {
    const fileName = [
      String(index + 1).padStart(3, "0"),
      `round-${entry.round ?? "0"}`,
      slugifyLabel(entry.taskId, "task"),
      slugifyLabel(entry.category, "unknown")
    ].join("-") + ".json";
    const artifactPath = path.join(feedbackDirectory, fileName);

    await writeJson(artifactPath, entry);
    writtenArtifacts.push({
      path: artifactPath,
      ...entry
    });
  }

  const indexPath = path.join(feedbackDirectory, "failure-feedback-index.json");
  const generatedTestCasesPath = path.join(feedbackDirectory, "generated-test-cases.json");
  const generatedAt = new Date().toISOString();
  const indexArtifact = {
    generatedAt,
    runDirectory,
    count: writtenArtifacts.length,
    entries: writtenArtifacts
  };
  const generatedTestCases = {
    generatedAt,
    sourceIndexPath: indexPath,
    cases: writtenArtifacts.map((entry) => buildFailureLearningCase(entry, entry.path))
  };

  await writeJson(indexPath, indexArtifact);
  await writeJson(generatedTestCasesPath, generatedTestCases);

  return {
    count: writtenArtifacts.length,
    directory: feedbackDirectory,
    indexPath,
    generatedTestCasesPath
  };
}

/**
 * @typedef {object} AutonomousOperations
 * @property {(outputDir?: string, workspaceRoot?: string) => Promise<{ jsonPath: string }>} [runRuntimeDoctor]
 * @property {(runStatePath: string, doctorReportPath?: string, outputDir?: string) => Promise<{ handoffIndexPath: string, readyTaskCount: number }>} [tickProjectRun]
 * @property {(handoffIndexPath: string, mode?: string) => Promise<{
 *   summary: { executed?: number, completed?: number, continued?: number, incomplete?: number, failed?: number, skipped?: number },
 *   results?: Array<{
 *     taskId?: string,
 *     status?: string,
 *     runtime?: string,
 *     error?: string,
 *     note?: string,
 *     launcherPath?: string,
 *     resultPath?: string
 *   }>,
 *   resultJsonPath?: string,
 *   resultMarkdownPath?: string
 * }>} [dispatchHandoffs]
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
    const failureFeedbackEntries = [];
    const noProgressCycleLimit = getAutonomousNoProgressCycleLimit();
    let lastProgressAt = null;
    let lastProgressTaskId = null;
    let lastProgressEvent = null;
    let consecutiveNoProgressCycles = 0;
    let skippedAutomaticTaskIds = [];
    let stopReason = null;
    const persistAutonomousSummary = async (
      finalRunState,
      currentFailureFeedback = {
        count: 0,
        directory: null,
        indexPath: null,
        generatedTestCasesPath: null
      }
    ) => {
      const summary = {
        runId: finalRunState.runId,
        finalStatus: finalRunState.status,
        doctorReportPath: effectiveDoctorReportPath,
        rounds,
        stopReason:
          stopReason ?? (finalRunState.status === "completed" ? "run completed" : "maximum rounds reached"),
        runSummary: summarizeRunState(finalRunState),
        progressDiagnostics: buildAutonomousProgressDiagnostics(finalRunState, {
          lastProgressAt,
          lastProgressTaskId,
          lastProgressEvent,
          consecutiveNoProgressCycles,
          skippedAutomaticTaskIds
        }),
        failureFeedback: currentFailureFeedback
      };

      const artifacts = await writeAutonomousSummaryArtifacts(runDirectory, summary);

      return {
        ...artifacts,
        summary
      };
    };

    await persistAutonomousSummary(refreshRunState(await readJson(resolvedRunStatePath)));

    for (let round = 1; round <= maxRounds; round += 1) {
      let currentRunState = refreshRunState(await readJson(resolvedRunStatePath));
      const beforeRoundState = currentRunState;
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
        stopReason: null,
        progressEvent: null,
        progressTaskId: null,
        consecutiveNoProgressCycles: 0,
        blockedTaskIds: [],
        waitingRetryTaskIds: [],
        skippedAutomaticTaskIds: [],
        degradedRuntimeActive: false
      };

      const staleInProgressRecovery = await maybeRecoverStalledInProgress(currentRunState);

      if (staleInProgressRecovery.changed) {
        await writeRunReport(runDirectory, staleInProgressRecovery.runState);
        roundRecord.recovery = staleInProgressRecovery.recovery;
        const progress = deriveRoundProgress({
          beforeRunState: beforeRoundState,
          afterRunState: staleInProgressRecovery.runState,
          recovery: staleInProgressRecovery.recovery
        });
        if (progress.progressed) {
          lastProgressAt = new Date().toISOString();
          lastProgressTaskId = progress.taskId;
          lastProgressEvent = progress.event;
          consecutiveNoProgressCycles = 0;
        }
        roundRecord.progressEvent = progress.event;
        roundRecord.progressTaskId = progress.taskId;
        roundRecord.consecutiveNoProgressCycles = consecutiveNoProgressCycles;
        roundRecord.blockedTaskIds = listTaskIdsByStatus(staleInProgressRecovery.runState.taskLedger, ["blocked"]);
        roundRecord.waitingRetryTaskIds = listTaskIdsByStatus(
          staleInProgressRecovery.runState.taskLedger,
          ["waiting_retry"]
        );
        roundRecord.skippedAutomaticTaskIds = [...skippedAutomaticTaskIds];
        roundRecord.degradedRuntimeActive = hasDegradedRuntimeSignal(staleInProgressRecovery.runState);
        rounds.push(roundRecord);
        await persistAutonomousSummary(staleInProgressRecovery.runState);
        continue;
      }

      const recoveryBeforeTick = maybeRecoverRunState(currentRunState);

      if (recoveryBeforeTick.changed) {
        await writeRunReport(runDirectory, recoveryBeforeTick.runState);
        roundRecord.recovery = recoveryBeforeTick.recovery;
        const progress = deriveRoundProgress({
          beforeRunState: beforeRoundState,
          afterRunState: recoveryBeforeTick.runState,
          recovery: recoveryBeforeTick.recovery
        });
        if (progress.progressed) {
          lastProgressAt = new Date().toISOString();
          lastProgressTaskId = progress.taskId;
          lastProgressEvent = progress.event;
          consecutiveNoProgressCycles = 0;
        }
        roundRecord.progressEvent = progress.event;
        roundRecord.progressTaskId = progress.taskId;
        roundRecord.consecutiveNoProgressCycles = consecutiveNoProgressCycles;
        roundRecord.blockedTaskIds = listTaskIdsByStatus(recoveryBeforeTick.runState.taskLedger, ["blocked"]);
        roundRecord.waitingRetryTaskIds = listTaskIdsByStatus(
          recoveryBeforeTick.runState.taskLedger,
          ["waiting_retry"]
        );
        roundRecord.skippedAutomaticTaskIds = [...skippedAutomaticTaskIds];
        roundRecord.degradedRuntimeActive = hasDegradedRuntimeSignal(recoveryBeforeTick.runState);
        rounds.push(roundRecord);
        await persistAutonomousSummary(recoveryBeforeTick.runState);
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
        roundRecord.consecutiveNoProgressCycles = consecutiveNoProgressCycles;
        roundRecord.blockedTaskIds = listTaskIdsByStatus(currentRunState.taskLedger, ["blocked"]);
        roundRecord.waitingRetryTaskIds = listTaskIdsByStatus(currentRunState.taskLedger, ["waiting_retry"]);
        roundRecord.skippedAutomaticTaskIds = [...skippedAutomaticTaskIds];
        roundRecord.degradedRuntimeActive = hasDegradedRuntimeSignal(currentRunState);
        rounds.push(roundRecord);
        await persistAutonomousSummary(currentRunState);
        break;
      }

      const dispatchResult = await dispatchOperation(tickResult.handoffIndexPath, "execute");
      roundRecord.dispatchSummary = dispatchResult.summary;
      const dispatchResults = safeArray(dispatchResult.results);
      skippedAutomaticTaskIds = dispatchResults
        .filter((result) => result?.status === "skipped" && isNonEmptyString(result?.taskId))
        .map((result) => result.taskId);

      for (const result of dispatchResults) {
        if (!["failed", "incomplete", "continued"].includes(result?.status)) {
          continue;
        }

        const reason = dedupeText([
          result?.error,
          result?.note,
          result?.artifact?.summary,
          ...safeArray(result?.artifact?.notes),
          ...safeArray(result?.artifact?.verification)
        ]).join(" | ");

        failureFeedbackEntries.push(
          createFailureFeedbackEntry({
            runId: currentRunState.runId,
            round,
            taskId: result?.taskId ?? null,
            status: result?.status ?? null,
            reason,
            evidence: [
              tickResult.handoffIndexPath,
              dispatchResult.resultJsonPath ?? null,
              dispatchResult.resultMarkdownPath ?? null,
              result?.launcherPath ?? null,
              result?.resultPath ?? null
            ]
          })
        );
      }

      if ((dispatchResult.summary?.executed ?? 0) === 0) {
        if ((dispatchResult.summary?.skipped ?? 0) > 0) {
          stopReason = "dispatch skipped all ready tasks; no automatic runtime was available";
          const blockedRunState = markSkippedDispatchTasksAsBlocked(
            refreshRunState(await readJson(resolvedRunStatePath)),
            dispatchResults,
            stopReason
          );
          await writeRunReport(runDirectory, blockedRunState);
          roundRecord.blockedTaskIds = listTaskIdsByStatus(blockedRunState.taskLedger, ["blocked"]);
          roundRecord.waitingRetryTaskIds = listTaskIdsByStatus(blockedRunState.taskLedger, ["waiting_retry"]);
          roundRecord.skippedAutomaticTaskIds = [...skippedAutomaticTaskIds];
          roundRecord.degradedRuntimeActive = hasDegradedRuntimeSignal(blockedRunState);
          roundRecord.consecutiveNoProgressCycles = consecutiveNoProgressCycles;
          await persistAutonomousSummary(blockedRunState);
        } else {
          stopReason = "dispatch produced no executable work";
          const nextRunState = refreshRunState(await readJson(resolvedRunStatePath));
          roundRecord.blockedTaskIds = listTaskIdsByStatus(nextRunState.taskLedger, ["blocked"]);
          roundRecord.waitingRetryTaskIds = listTaskIdsByStatus(nextRunState.taskLedger, ["waiting_retry"]);
          roundRecord.skippedAutomaticTaskIds = [...skippedAutomaticTaskIds];
          roundRecord.degradedRuntimeActive = hasDegradedRuntimeSignal(nextRunState);
          roundRecord.consecutiveNoProgressCycles = consecutiveNoProgressCycles;
          await persistAutonomousSummary(nextRunState);
        }

        roundRecord.stopReason = stopReason;
        rounds.push(roundRecord);
        break;
      }

      const runStateAfterDispatch = refreshRunState(await readJson(resolvedRunStatePath));
      const recoveryAfterDispatch = maybeRecoverRunState(runStateAfterDispatch);
      let roundEndState = recoveryAfterDispatch.changed ? recoveryAfterDispatch.runState : runStateAfterDispatch;

      if (recoveryAfterDispatch.changed) {
        await writeRunReport(runDirectory, recoveryAfterDispatch.runState);
        roundRecord.recovery = recoveryAfterDispatch.recovery;
      }

      const progress = deriveRoundProgress({
        beforeRunState: beforeRoundState,
        afterRunState: roundEndState,
        dispatchSummary: dispatchResult.summary,
        recovery: recoveryAfterDispatch.recovery
      });

      if (progress.progressed) {
        lastProgressAt = new Date().toISOString();
        lastProgressTaskId = progress.taskId;
        lastProgressEvent = progress.event;
        consecutiveNoProgressCycles = 0;
      } else if (
        shouldCountNoProgressCycle({
          beforeRunState: beforeRoundState,
          afterRunState: roundEndState,
          dispatchSummary: dispatchResult.summary
        })
      ) {
        consecutiveNoProgressCycles += 1;
      } else {
        consecutiveNoProgressCycles = 0;
      }

      roundRecord.progressEvent = progress.event;
      roundRecord.progressTaskId = progress.taskId;
      roundRecord.consecutiveNoProgressCycles = consecutiveNoProgressCycles;
      roundRecord.blockedTaskIds = listTaskIdsByStatus(roundEndState.taskLedger, ["blocked"]);
      roundRecord.waitingRetryTaskIds = listTaskIdsByStatus(roundEndState.taskLedger, ["waiting_retry"]);
      roundRecord.skippedAutomaticTaskIds = [...skippedAutomaticTaskIds];
      roundRecord.degradedRuntimeActive = hasDegradedRuntimeSignal(roundEndState);

      if (consecutiveNoProgressCycles >= noProgressCycleLimit) {
        stopReason =
          `autonomous no-progress circuit opened after ${consecutiveNoProgressCycles} consecutive cycles; ` +
          `lastProgressTaskId=${lastProgressTaskId ?? "unknown"} ` +
          `lastProgressEvent=${lastProgressEvent ?? "unknown"} ` +
          `blockedTasks=${roundRecord.blockedTaskIds.join(",") || "none"} ` +
          `waitingRetryTasks=${roundRecord.waitingRetryTaskIds.join(",") || "none"} ` +
          `skippedAutomaticTasks=${roundRecord.skippedAutomaticTaskIds.join(",") || "none"}`;
        roundEndState = materializeNoProgressAttention(
          roundEndState,
          stopReason,
          skippedAutomaticTaskIds
        );
        await writeRunReport(runDirectory, roundEndState);
        roundRecord.stopReason = stopReason;
        roundRecord.blockedTaskIds = listTaskIdsByStatus(roundEndState.taskLedger, ["blocked"]);
        roundRecord.waitingRetryTaskIds = listTaskIdsByStatus(roundEndState.taskLedger, ["waiting_retry"]);
      }

      rounds.push(roundRecord);
      await persistAutonomousSummary(roundEndState);

      if (roundRecord.stopReason) {
        break;
      }
    }

    const finalRunState = refreshRunState(await readJson(resolvedRunStatePath));
    const failureFeedback = await persistFailureFeedbackArtifacts(runDirectory, failureFeedbackEntries);
    const { summaryJsonPath, summaryMarkdownPath, summary } = await persistAutonomousSummary(
      finalRunState,
      failureFeedback
    );

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
