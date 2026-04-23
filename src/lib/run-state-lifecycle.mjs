export function buildNextActions(taskLedger) {
  return taskLedger
    .filter((task) => task.status === "ready")
    .map((task) => ({
      taskId: task.id,
      role: task.role,
      title: task.title
    }));
}

export function summarizeRunState(runState) {
  return {
    runId: runState.runId,
    status: runState.status,
    totalTasks: runState.taskLedger.length,
    readyTasks: runState.taskLedger.filter((task) => task.status === "ready").length,
    pendingTasks: runState.taskLedger.filter((task) => task.status === "pending").length,
    waitingRetryTasks: runState.taskLedger.filter((task) => task.status === "waiting_retry").length,
    completedTasks: runState.taskLedger.filter((task) => task.status === "completed").length,
    blockedTasks: runState.taskLedger.filter((task) => task.status === "blocked").length,
    failedTasks: runState.taskLedger.filter((task) => task.status === "failed").length
  };
}

function areDependenciesCompleted(task, taskLedger) {
  return task.dependsOn.every((dependencyId) =>
    taskLedger.some((candidate) => candidate.id === dependencyId && candidate.status === "completed")
  );
}

function hasElapsedRetryWindow(task, now) {
  const retryAtMs = Date.parse(task.nextRetryAt ?? "");
  return Number.isFinite(retryAtMs) && retryAtMs <= now;
}

function canAutoUnlockBlockedTask(task) {
  if ((task.retryCount ?? 0) <= 0) {
    return false;
  }

  if (typeof task.lastRetryReason === "string" && task.lastRetryReason.trim().length > 0) {
    return true;
  }

  return Array.isArray(task.notes) && task.notes.some((note) => /retry-escalated:/i.test(note));
}

function validateTaskTransition(task, nextStatus, taskLedger) {
  const transitionGraph = {
    pending: new Set(["pending", "ready"]),
    ready: new Set(["ready", "pending", "in_progress", "completed", "failed", "blocked", "waiting_retry"]),
    in_progress: new Set(["in_progress", "ready", "completed", "failed", "blocked", "waiting_retry"]),
    waiting_retry: new Set(["waiting_retry", "ready", "completed", "failed", "blocked"]),
    blocked: new Set(["blocked", "ready"]),
    completed: new Set(["completed"]),
    failed: new Set(["failed"])
  };

  if (!transitionGraph[task.status]?.has(nextStatus)) {
    throw new Error(`Cannot move task ${task.id} from ${task.status} to ${nextStatus}.`);
  }

  if (nextStatus !== "pending" && !areDependenciesCompleted(task, taskLedger)) {
    throw new Error(`Cannot move task ${task.id} to ${nextStatus} before dependencies are completed.`);
  }
}

function inferRunStatus(taskLedger) {
  const failedTasks = taskLedger.filter((task) => task.status === "failed");
  const blockedTasks = taskLedger.filter((task) => task.status === "blocked");
  const inProgressTasks = taskLedger.filter((task) => task.status === "in_progress");
  const waitingRetryTasks = taskLedger.filter((task) => task.status === "waiting_retry");
  const readyTasks = taskLedger.filter((task) => task.status === "ready");
  const pendingTasks = taskLedger.filter((task) => task.status === "pending");
  const completedTasks = taskLedger.filter((task) => task.status === "completed");

  if (failedTasks.length > 0 || blockedTasks.length > 0) {
    return "attention_required";
  }

  if (taskLedger.every((task) => task.status === "completed")) {
    return "completed";
  }

  if (inProgressTasks.length > 0 || waitingRetryTasks.length > 0 || completedTasks.length > 0) {
    return "in_progress";
  }

  if (readyTasks.length > 0 || pendingTasks.length > 0) {
    return "planned";
  }

  return "planned";
}

export function refreshRunState(runState) {
  const now = Date.now();
  const taskLedger = runState.taskLedger.map((task) => {
    if (task.status === "waiting_retry") {
      if (hasElapsedRetryWindow(task, now) && areDependenciesCompleted(task, runState.taskLedger)) {
        return {
          ...task,
          status: "ready",
          nextRetryAt: null
        };
      }

      return task;
    }

    if (task.status === "blocked") {
      if (
        canAutoUnlockBlockedTask(task) &&
        hasElapsedRetryWindow(task, now) &&
        areDependenciesCompleted(task, runState.taskLedger)
      ) {
        return {
          ...task,
          status: "ready",
          nextRetryAt: null
        };
      }

      return task;
    }

    if (task.status === "ready" && !areDependenciesCompleted(task, runState.taskLedger)) {
      return {
        ...task,
        status: "pending"
      };
    }

    if (task.status !== "pending") {
      return task;
    }

    if (!areDependenciesCompleted(task, runState.taskLedger)) {
      return task;
    }

    return {
      ...task,
      status: "ready"
    };
  });

  const refreshedState = {
    ...runState,
    updatedAt: new Date().toISOString(),
    taskLedger
  };

  refreshedState.status = inferRunStatus(taskLedger);
  refreshedState.summary = summarizeRunState(refreshedState);
  refreshedState.nextActions = buildNextActions(taskLedger);

  return refreshedState;
}

export function updateTaskInRunState(runState, taskId, nextStatus, note = "") {
  const allowedStatuses = new Set([
    "ready",
    "in_progress",
    "completed",
    "failed",
    "blocked",
    "pending",
    "waiting_retry"
  ]);

  if (!allowedStatuses.has(nextStatus)) {
    throw new Error(`Unsupported task status: ${nextStatus}`);
  }

  const targetTask = runState.taskLedger.find((task) => task.id === taskId);

  if (!targetTask) {
    throw new Error(`Task not found: ${taskId}`);
  }

  validateTaskTransition(targetTask, nextStatus, runState.taskLedger);

  const taskLedger = runState.taskLedger.map((task) => {
    if (task.id !== taskId) {
      return task;
    }

    return {
      ...task,
      status: nextStatus,
      attempts: nextStatus === "failed" ? task.attempts + 1 : task.attempts,
      nextRetryAt: nextStatus === "waiting_retry" ? task.nextRetryAt ?? null : null,
      retryCount: task.retryCount ?? 0,
      lastRetryReason: task.lastRetryReason ?? null,
      notes: note
        ? [...(Array.isArray(task.notes) ? task.notes : []), `${new Date().toISOString()} ${note}`]
        : task.notes
    };
  });

  return refreshRunState({
    ...runState,
    updatedAt: new Date().toISOString(),
    taskLedger
  });
}
