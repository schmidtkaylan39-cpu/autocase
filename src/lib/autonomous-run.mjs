import path from "node:path";
import { writeFile } from "node:fs/promises";

import { tickProjectRun } from "./commands.mjs";
import { dispatchHandoffs } from "./dispatch.mjs";
import { readJson, writeJson } from "./fs-utils.mjs";
import { runRuntimeDoctor } from "./doctor.mjs";
import { renderRunReport, refreshRunState, summarizeRunState } from "./run-state.mjs";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

async function fileExists(targetPath) {
  try {
    await readJson(targetPath);
    return true;
  } catch {
    return false;
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
    requestedDoctorReportPath && (await fileExists(requestedDoctorReportPath))
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
}
