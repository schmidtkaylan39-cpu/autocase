import {
  ACTIVE_TASK_STATUSES,
  ACTIVE_RUN_PHASES,
  TERMINAL_RUN_PHASES,
  createLoopPolicy,
  createTaskDefinition,
  createTaskRecord as createTaskRecordContract,
  createTransitionRecord,
  assertReviewDecision,
  assertRunRecord,
  assertTaskResult
} from "../contracts/run-model.mjs";

const runPhaseOrder = [...ACTIVE_RUN_PHASES];
const terminalTaskStatuses = new Set(["completed", "blocked", "exhausted"]);
const runnableTaskStatuses = new Set(["ready", "in_progress"]);

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function cloneRunRecord(runRecord) {
  return {
    ...runRecord,
    loopPolicy: {
      ...runRecord.loopPolicy,
      phaseRetryLimits: { ...runRecord.loopPolicy.phaseRetryLimits }
    },
    taskDefinitions: runRecord.taskDefinitions.map((taskDefinition) => ({
      ...taskDefinition,
      dependsOn: [...taskDefinition.dependsOn],
      acceptanceCriteria: [...taskDefinition.acceptanceCriteria],
      metadata: { ...taskDefinition.metadata }
    })),
    tasks: runRecord.tasks.map((task) => ({
      ...task,
      dependsOn: [...task.dependsOn],
      lastResult: task.lastResult
        ? {
            ...task.lastResult,
            changedFiles: [...task.lastResult.changedFiles],
            verification: [...task.lastResult.verification],
            notes: [...task.lastResult.notes],
            reviewDecision: task.lastResult.reviewDecision
              ? {
                  ...task.lastResult.reviewDecision,
                  findings: [...task.lastResult.reviewDecision.findings],
                  metadata: { ...task.lastResult.reviewDecision.metadata }
                }
              : null,
            metadata: { ...task.lastResult.metadata }
          }
        : null,
      lastReviewDecision: task.lastReviewDecision
        ? {
            ...task.lastReviewDecision,
            findings: [...task.lastReviewDecision.findings],
            metadata: { ...task.lastReviewDecision.metadata }
          }
        : null,
      metadata: { ...task.metadata }
    })),
    transitions: runRecord.transitions.map((transition) => ({
      ...transition,
      metadata: { ...transition.metadata }
    })),
    metadata: { ...runRecord.metadata }
  };
}

function getTaskMap(runRecord) {
  return new Map(runRecord.tasks.map((task) => [task.taskId, task]));
}

function resolveTask(runRecord, taskId) {
  const task = runRecord.tasks.find((candidate) => candidate.taskId === taskId);
  assertCondition(task, `Task ${taskId} was not found in run ${runRecord.runId}.`);
  return task;
}

function areDependenciesCompleted(runRecord, task) {
  const taskMap = getTaskMap(runRecord);
  return task.dependsOn.every((dependencyId) => taskMap.get(dependencyId)?.status === "completed");
}

function deriveRunPhase(runRecord) {
  const incompleteTasks = runRecord.tasks.filter((task) => task.status !== "completed");

  if (incompleteTasks.length === 0) {
    return "done";
  }

  if (incompleteTasks.some((task) => task.status === "exhausted")) {
    return "exhausted";
  }

  if (incompleteTasks.some((task) => task.status === "blocked")) {
    return "blocked";
  }

  if (!incompleteTasks.some((task) => runnableTaskStatuses.has(task.status))) {
    return "queued";
  }

  for (const phase of runPhaseOrder) {
    if (incompleteTasks.some((task) => task.phase === phase)) {
      return phase;
    }
  }

  return "queued";
}

function appendTransition(runRecord, transition) {
  return {
    ...runRecord,
    transitions: [...runRecord.transitions, transition]
  };
}

function updateRunPhase(runRecord, { actor = "system", at = new Date().toISOString(), reason = "" } = {}) {
  const nextPhase = deriveRunPhase(runRecord);

  if (nextPhase === runRecord.phase) {
    return {
      ...runRecord,
      updatedAt: at
    };
  }

  return appendTransition(
    {
      ...runRecord,
      phase: nextPhase,
      updatedAt: at
    },
    createTransitionRecord({
      type: "run_phase_changed",
      runId: runRecord.runId,
      from: runRecord.phase,
      to: nextPhase,
      reason,
      actor,
      at,
      loopCount: runRecord.loopCount
    })
  );
}

function transitionTaskStatus(
  runRecord,
  taskId,
  nextStatus,
  {
    actor = "system",
    at = new Date().toISOString(),
    reason = "",
    patch = {}
  } = {}
) {
  const task = resolveTask(runRecord, taskId);

  if (task.status === nextStatus) {
    return {
      ...runRecord,
      updatedAt: at
    };
  }

  const allowedTransitions = {
    queued: new Set(["ready", "blocked", "exhausted"]),
    ready: new Set(["in_progress", "completed", "blocked", "exhausted"]),
    in_progress: new Set(["completed", "blocked", "exhausted"]),
    blocked: new Set(["ready", "exhausted"]),
    completed: new Set([]),
    exhausted: new Set([])
  };

  assertCondition(
    allowedTransitions[task.status]?.has(nextStatus),
    `Cannot move task ${taskId} from ${task.status} to ${nextStatus}.`
  );

  const nextRunRecord = {
    ...runRecord,
    updatedAt: at,
    tasks: runRecord.tasks.map((candidate) =>
      candidate.taskId === taskId
        ? {
            ...candidate,
            ...patch,
            status: nextStatus,
            updatedAt: at
          }
        : candidate
    )
  };

  return appendTransition(
    nextRunRecord,
    createTransitionRecord({
      type: "task_status_changed",
      runId: runRecord.runId,
      taskId,
      from: task.status,
      to: nextStatus,
      reason,
      actor,
      at,
      loopCount: runRecord.loopCount,
      metadata: {
        taskPhase: task.phase
      }
    })
  );
}

function exhaustRemainingTasks(runRecord, { actor = "system", at = new Date().toISOString(), reason = "" } = {}) {
  let nextRunRecord = cloneRunRecord(runRecord);

  for (const task of nextRunRecord.tasks) {
    if (terminalTaskStatuses.has(task.status)) {
      continue;
    }

    nextRunRecord = transitionTaskStatus(nextRunRecord, task.taskId, "exhausted", {
      actor,
      at,
      reason
    });
  }

  return nextRunRecord;
}

function syncReadyTasksInternal(
  runRecord,
  { actor = "system", at = new Date().toISOString(), reason = "synchronize task availability" } = {}
) {
  let nextRunRecord = cloneRunRecord(runRecord);

  for (const task of nextRunRecord.tasks) {
    if (task.status === "queued" && areDependenciesCompleted(nextRunRecord, task)) {
      nextRunRecord = transitionTaskStatus(nextRunRecord, task.taskId, "ready", {
        actor,
        at,
        reason
      });
      continue;
    }

    if (task.status === "ready" && !areDependenciesCompleted(nextRunRecord, task)) {
      const downgradedRecord = {
        ...nextRunRecord,
        updatedAt: at,
        tasks: nextRunRecord.tasks.map((candidate) =>
          candidate.taskId === task.taskId
            ? {
                ...candidate,
                status: "queued",
                updatedAt: at
              }
            : candidate
        )
      };

      nextRunRecord = appendTransition(
        downgradedRecord,
        createTransitionRecord({
          type: "task_status_changed",
          runId: nextRunRecord.runId,
          taskId: task.taskId,
          from: "ready",
          to: "queued",
          reason,
          actor,
          at,
          loopCount: nextRunRecord.loopCount,
          metadata: {
            taskPhase: task.phase
          }
        })
      );
    }
  }

  return updateRunPhase(nextRunRecord, { actor, at, reason });
}

function applyReviewDecisionInternal(
  runRecord,
  reviewDecision,
  { actor = reviewDecision.actor, at = reviewDecision.decidedAt, reason = reviewDecision.summary } = {}
) {
  const task = resolveTask(runRecord, reviewDecision.taskId);
  assertCondition(task.phase === "reviewing", `Task ${task.taskId} does not accept ReviewDecision records.`);
  assertReviewDecision(reviewDecision);

  const nextRunRecord = {
    ...runRecord,
    updatedAt: at,
    tasks: runRecord.tasks.map((candidate) =>
      candidate.taskId === reviewDecision.taskId
        ? {
            ...candidate,
            lastReviewDecision: {
              ...reviewDecision,
              findings: [...reviewDecision.findings],
              metadata: { ...reviewDecision.metadata }
            },
            updatedAt: at
          }
        : candidate
    )
  };

  return appendTransition(
    nextRunRecord,
    createTransitionRecord({
      type: "review_recorded",
      runId: runRecord.runId,
      taskId: reviewDecision.taskId,
      from: null,
      to: reviewDecision.decision,
      reason,
      actor,
      at,
      loopCount: runRecord.loopCount
    })
  );
}

function defaultMaxAttemptsForTask(taskDefinition, loopPolicy) {
  return taskDefinition.maxAttempts ?? loopPolicy.phaseRetryLimits[taskDefinition.phase];
}

export function createTaskRecord(taskDefinition, loopPolicy, overrides = {}) {
  const normalizedDefinition = createTaskDefinition(taskDefinition);
  const normalizedLoopPolicy = createLoopPolicy(loopPolicy);
  const createdAt = overrides.createdAt ?? new Date().toISOString();

  return createTaskRecordContract({
    taskId: normalizedDefinition.id,
    phase: normalizedDefinition.phase,
    dependsOn: normalizedDefinition.dependsOn,
    status: overrides.status ?? (normalizedDefinition.dependsOn.length === 0 ? "ready" : "queued"),
    attemptCount: overrides.attemptCount ?? 0,
    maxAttempts: overrides.maxAttempts ?? defaultMaxAttemptsForTask(normalizedDefinition, normalizedLoopPolicy),
    lastResult: overrides.lastResult ?? null,
    lastReviewDecision: overrides.lastReviewDecision ?? null,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    metadata: {
      ...normalizedDefinition.metadata,
      ...(overrides.metadata ?? {})
    }
  });
}

export function createRunRecord({
  runId,
  taskDefinitions,
  loopPolicy = {},
  maxLoops = loopPolicy.maxLoops ?? 3,
  loopCount = 0,
  metadata = {},
  createdAt = new Date().toISOString()
}) {
  const normalizedLoopPolicy = createLoopPolicy({
    ...loopPolicy,
    maxLoops
  });
  const normalizedTaskDefinitions = taskDefinitions.map((taskDefinition) => createTaskDefinition(taskDefinition));
  const tasks = normalizedTaskDefinitions.map((taskDefinition) =>
    createTaskRecord(taskDefinition, normalizedLoopPolicy)
  );
  const baseRunRecord = {
    runId,
    phase: "queued",
    loopCount,
    maxLoops: normalizedLoopPolicy.maxLoops,
    loopPolicy: normalizedLoopPolicy,
    taskDefinitions: normalizedTaskDefinitions,
    tasks,
    transitions: [],
    createdAt,
    updatedAt: createdAt,
    metadata: { ...metadata }
  };
  const initializedRunRecord = updateRunPhase(baseRunRecord, {
    actor: "system",
    at: createdAt,
    reason: "run initialized"
  });
  const runRecord = appendTransition(
    initializedRunRecord,
    createTransitionRecord({
      type: "run_initialized",
      runId,
      from: null,
      to: initializedRunRecord.phase,
      reason: "run initialized",
      actor: "system",
      at: createdAt,
      loopCount
    })
  );

  assertRunRecord(runRecord);
  return runRecord;
}

export function calculateRunPhase(runRecord) {
  assertRunRecord(runRecord);
  return deriveRunPhase(runRecord);
}

export function syncTaskAvailability(runRecord, options = {}) {
  assertRunRecord(runRecord);
  const nextRunRecord = syncReadyTasksInternal(runRecord, options);
  assertRunRecord(nextRunRecord);
  return nextRunRecord;
}

export function startTask(
  runRecord,
  taskId,
  { actor = "system", at = new Date().toISOString(), reason = "task execution started" } = {}
) {
  assertRunRecord(runRecord);
  assertCondition(!TERMINAL_RUN_PHASES.includes(runRecord.phase), `Run ${runRecord.runId} is already terminal.`);

  const nextRunRecord = syncReadyTasksInternal(runRecord, { actor, at, reason: "pre-start availability sync" });
  const task = resolveTask(nextRunRecord, taskId);
  assertCondition(task.status === "ready", `Task ${taskId} must be ready before it can start.`);
  assertCondition(areDependenciesCompleted(nextRunRecord, task), `Task ${taskId} still has incomplete dependencies.`);

  if (task.attemptCount >= task.maxAttempts) {
    return exhaustTask(nextRunRecord, taskId, {
      actor,
      at,
      reason: `attempt budget exhausted before start (${task.attemptCount}/${task.maxAttempts})`
    });
  }

  const startedRunRecord = transitionTaskStatus(nextRunRecord, taskId, "in_progress", {
    actor,
    at,
    reason,
    patch: {
      attemptCount: task.attemptCount + 1
    }
  });
  const finalizedRunRecord = updateRunPhase(startedRunRecord, { actor, at, reason });

  assertRunRecord(finalizedRunRecord);
  return finalizedRunRecord;
}

export function recordReviewDecision(runRecord, reviewDecision, options = {}) {
  assertRunRecord(runRecord);
  const nextRunRecord = applyReviewDecisionInternal(runRecord, reviewDecision, options);
  assertRunRecord(nextRunRecord);
  return nextRunRecord;
}

export function applyTaskResult(runRecord, taskResult, options = {}) {
  assertRunRecord(runRecord);
  assertTaskResult(taskResult);

  const actor = options.actor ?? taskResult.actor;
  const at = options.at ?? taskResult.producedAt;
  const task = resolveTask(runRecord, taskResult.taskId);
  assertCondition(
    ["ready", "in_progress"].includes(task.status),
    `Task ${task.taskId} must be ready or in progress before applying a result.`
  );

  if (task.phase !== "reviewing" && taskResult.reviewDecision !== null) {
    throw new Error(`Task ${task.taskId} is not a review task and cannot accept a ReviewDecision.`);
  }

  if (
    taskResult.reviewDecision &&
    taskResult.outcome === "success" &&
    taskResult.reviewDecision.decision !== "approved"
  ) {
    throw new Error("A successful review result must carry an approved ReviewDecision.");
  }

  let nextRunRecord = cloneRunRecord(runRecord);

  if (taskResult.reviewDecision) {
    nextRunRecord = applyReviewDecisionInternal(nextRunRecord, taskResult.reviewDecision, {
      actor,
      at,
      reason: taskResult.reviewDecision.summary
    });
  }

  const nextStatus = {
    success: "completed",
    blocked: "blocked",
    exhausted: "exhausted"
  }[taskResult.outcome];

  nextRunRecord = transitionTaskStatus(nextRunRecord, task.taskId, nextStatus, {
    actor,
    at,
    reason: taskResult.summary,
    patch: {
      lastResult: {
        ...taskResult,
        changedFiles: [...taskResult.changedFiles],
        verification: [...taskResult.verification],
        notes: [...taskResult.notes],
        reviewDecision: taskResult.reviewDecision
          ? {
              ...taskResult.reviewDecision,
              findings: [...taskResult.reviewDecision.findings],
              metadata: { ...taskResult.reviewDecision.metadata }
            }
          : null,
        metadata: { ...taskResult.metadata }
      },
      lastReviewDecision: taskResult.reviewDecision
        ? {
            ...taskResult.reviewDecision,
            findings: [...taskResult.reviewDecision.findings],
            metadata: { ...taskResult.reviewDecision.metadata }
          }
        : task.lastReviewDecision
    }
  });

  if (nextStatus === "completed") {
    nextRunRecord = syncReadyTasksInternal(nextRunRecord, {
      actor,
      at,
      reason: `dependencies unlocked after ${task.taskId} completed`
    });
  } else {
    nextRunRecord = updateRunPhase(nextRunRecord, {
      actor,
      at,
      reason: taskResult.summary
    });
  }

  assertRunRecord(nextRunRecord);
  return nextRunRecord;
}

export function advanceLoop(
  runRecord,
  { actor = "system", at = new Date().toISOString(), reason = "bounded loop advanced" } = {}
) {
  assertRunRecord(runRecord);

  if (runRecord.loopCount >= runRecord.maxLoops) {
    const exhaustedRunRecord = exhaustRemainingTasks(runRecord, {
      actor,
      at,
      reason: `loop budget exhausted (${runRecord.loopCount}/${runRecord.maxLoops})`
    });
    const finalizedRunRecord = updateRunPhase(exhaustedRunRecord, {
      actor,
      at,
      reason: `loop budget exhausted (${runRecord.loopCount}/${runRecord.maxLoops})`
    });
    assertRunRecord(finalizedRunRecord);
    return finalizedRunRecord;
  }

  const nextRunRecord = appendTransition(
    {
      ...cloneRunRecord(runRecord),
      loopCount: runRecord.loopCount + 1,
      updatedAt: at
    },
    createTransitionRecord({
      type: "loop_advanced",
      runId: runRecord.runId,
      from: runRecord.loopCount,
      to: runRecord.loopCount + 1,
      reason,
      actor,
      at,
      loopCount: runRecord.loopCount + 1
    })
  );

  const finalizedRunRecord = updateRunPhase(nextRunRecord, { actor, at, reason });
  assertRunRecord(finalizedRunRecord);
  return finalizedRunRecord;
}

export function retryTask(
  runRecord,
  taskId,
  {
    actor = "system",
    at = new Date().toISOString(),
    reason = "task retry requested",
    consumeLoop = true
  } = {}
) {
  assertRunRecord(runRecord);
  let nextRunRecord = cloneRunRecord(runRecord);
  const currentTask = resolveTask(nextRunRecord, taskId);
  assertCondition(currentTask.status === "blocked", `Task ${taskId} must be blocked before it can retry.`);

  if (consumeLoop) {
    nextRunRecord = advanceLoop(nextRunRecord, {
      actor,
      at,
      reason: `retry loop for ${taskId}`
    });

    if (nextRunRecord.phase === "exhausted") {
      assertRunRecord(nextRunRecord);
      return nextRunRecord;
    }
  }

  const refreshedTask = resolveTask(nextRunRecord, taskId);

  if (refreshedTask.attemptCount >= refreshedTask.maxAttempts) {
    return exhaustTask(nextRunRecord, taskId, {
      actor,
      at,
      reason: `task retry budget exhausted (${refreshedTask.attemptCount}/${refreshedTask.maxAttempts})`
    });
  }

  nextRunRecord = transitionTaskStatus(nextRunRecord, taskId, "ready", {
    actor,
    at,
    reason
  });
  nextRunRecord = updateRunPhase(nextRunRecord, { actor, at, reason });

  assertRunRecord(nextRunRecord);
  return nextRunRecord;
}

export function exhaustTask(
  runRecord,
  taskId,
  { actor = "system", at = new Date().toISOString(), reason = "task exhausted" } = {}
) {
  assertRunRecord(runRecord);
  const task = resolveTask(runRecord, taskId);

  if (task.status === "exhausted") {
    return updateRunPhase(runRecord, { actor, at, reason });
  }

  assertCondition(
    ACTIVE_TASK_STATUSES.includes(task.status) || task.status === "blocked",
    `Task ${taskId} cannot be exhausted from status ${task.status}.`
  );

  const nextRunRecord = updateRunPhase(
    transitionTaskStatus(runRecord, taskId, "exhausted", {
      actor,
      at,
      reason
    }),
    {
      actor,
      at,
      reason
    }
  );

  assertRunRecord(nextRunRecord);
  return nextRunRecord;
}
