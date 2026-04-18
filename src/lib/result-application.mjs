import { refreshRunState, updateTaskInRunState } from "./run-state.mjs";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function appendTaskNote(task, note, timestampIso) {
  if (!isNonEmptyString(note)) {
    return task;
  }

  return {
    ...task,
    notes: [...safeArray(task.notes), `${timestampIso} ${note}`]
  };
}

function extractFeatureTaskIds(taskId) {
  const match = /^(implement|review|verify)-(.+)$/.exec(String(taskId));

  if (!match) {
    return null;
  }

  const featureId = match[2];

  return {
    featureId,
    implementationTaskId: `implement-${featureId}`,
    reviewTaskId: `review-${featureId}`,
    verificationTaskId: `verify-${featureId}`
  };
}

function requireTask(runState, taskId) {
  const task = runState.taskLedger.find((candidate) => candidate.id === taskId);

  if (!task) {
    throw new Error(`Task not found for automation decision: ${taskId}`);
  }

  return task;
}

function finalizeRunState(runState, taskLedger, updatedTaskIds) {
  const nextRunState = refreshRunState({
    ...runState,
    updatedAt: new Date().toISOString(),
    taskLedger
  });

  return {
    runState: nextRunState,
    updatedTasks: updatedTaskIds.map((taskId) => ({
      taskId,
      nextStatus: nextRunState.taskLedger.find((task) => task.id === taskId)?.status ?? "unknown"
    }))
  };
}

function createDecisionNote(notePrefix, action, sourceTaskId, reason) {
  const parts = [`${notePrefix}:automation:${action}:${sourceTaskId}`];

  if (isNonEmptyString(reason)) {
    parts.push(reason.trim());
  }

  return parts.join(" ");
}

function applyRetryTaskDecision(runState, sourceTaskId, decision, notePrefix, timestamp) {
  const timestampIso = timestamp.toISOString();
  const targetTaskId = decision.targetTaskId ?? sourceTaskId;
  requireTask(runState, targetTaskId);
  const delayMinutes =
    typeof decision.delayMinutes === "number" && Number.isFinite(decision.delayMinutes)
      ? Math.max(0, decision.delayMinutes)
      : 3;
  const nextRetryAt =
    delayMinutes > 0
      ? new Date(timestamp.getTime() + delayMinutes * 60 * 1000).toISOString()
      : null;
  const nextStatus = delayMinutes > 0 ? "waiting_retry" : "ready";
  const note = createDecisionNote(notePrefix, "retry_task", sourceTaskId, decision.reason);
  const updatedTaskIds = new Set([targetTaskId]);

  const taskLedger = runState.taskLedger.map((task) => {
    if (task.id === targetTaskId) {
      return appendTaskNote(
        {
          ...clearTaskExecutionState(task),
          status: nextStatus,
          retryCount: (task.retryCount ?? 0) + 1,
          nextRetryAt,
          lastRetryReason: decision.reason
        },
        note,
        timestampIso
      );
    }

    if (task.id === sourceTaskId && sourceTaskId !== targetTaskId) {
      updatedTaskIds.add(task.id);
      return appendTaskNote(
        {
          ...clearTaskExecutionState(task),
          status: "pending"
        },
        `${notePrefix}:automation:await_retry:${targetTaskId} ${decision.reason}`,
        timestampIso
      );
    }

    if (task.id === "delivery-package" && task.status === "completed") {
      updatedTaskIds.add(task.id);
      return appendTaskNote(
        {
          ...clearTaskExecutionState(task),
          status: "pending"
        },
        `${notePrefix}:automation:reopened:${targetTaskId} ${decision.reason}`,
        timestampIso
      );
    }

    return task;
  });

  return {
    ...finalizeRunState(runState, taskLedger, [...updatedTaskIds]),
    appliedDecision: {
      action: "retry_task",
      sourceTaskId,
      targetTaskId
    }
  };
}

function applyReworkFeatureDecision(runState, sourceTaskId, decision, notePrefix, timestamp) {
  const ids = extractFeatureTaskIds(decision.targetTaskId ?? sourceTaskId);

  if (!ids) {
    throw new Error(
      `Automation decision rework_feature requires a feature task id. Received: ${decision.targetTaskId ?? sourceTaskId}`
    );
  }

  requireTask(runState, ids.implementationTaskId);
  requireTask(runState, ids.reviewTaskId);
  requireTask(runState, ids.verificationTaskId);
  const timestampIso = timestamp.toISOString();
  const note = createDecisionNote(notePrefix, "rework_feature", sourceTaskId, decision.reason);
  const updatedTaskIds = [ids.implementationTaskId, ids.reviewTaskId, ids.verificationTaskId, "delivery-package"];

  const taskLedger = runState.taskLedger.map((task) => {
    if (task.id === ids.implementationTaskId) {
      return appendTaskNote(
        {
          ...clearTaskExecutionState(task),
          status: "ready"
        },
        note,
        timestampIso
      );
    }

    if (task.id === ids.reviewTaskId || task.id === ids.verificationTaskId) {
      return appendTaskNote(
        {
          ...clearTaskExecutionState(task),
          status: "pending"
        },
        note,
        timestampIso
      );
    }

    if (task.id === "delivery-package") {
      return appendTaskNote(
        {
          ...clearTaskExecutionState(task),
          status: "pending"
        },
        note,
        timestampIso
      );
    }

    return task;
  });

  return {
    ...finalizeRunState(runState, taskLedger, updatedTaskIds),
    appliedDecision: {
      action: "rework_feature",
      sourceTaskId,
      targetTaskId: ids.implementationTaskId
    }
  };
}

function applyReplanFeatureDecision(runState, sourceTaskId, decision, notePrefix, timestamp) {
  const ids = extractFeatureTaskIds(decision.targetTaskId ?? sourceTaskId);

  if (!ids) {
    throw new Error(
      `Automation decision replan_feature requires a feature task id. Received: ${decision.targetTaskId ?? sourceTaskId}`
    );
  }

  requireTask(runState, "planning-brief");
  requireTask(runState, ids.implementationTaskId);
  requireTask(runState, ids.reviewTaskId);
  requireTask(runState, ids.verificationTaskId);
  const timestampIso = timestamp.toISOString();
  const note = createDecisionNote(notePrefix, "replan_feature", sourceTaskId, decision.reason);
  const updatedTaskIds = ["planning-brief", ids.implementationTaskId, ids.reviewTaskId, ids.verificationTaskId, "delivery-package"];

  const taskLedger = runState.taskLedger.map((task) => {
    if (task.id === "planning-brief") {
      return appendTaskNote(
        {
          ...clearTaskExecutionState(task),
          status: "ready"
        },
        note,
        timestampIso
      );
    }

    if ([ids.implementationTaskId, ids.reviewTaskId, ids.verificationTaskId].includes(task.id)) {
      return appendTaskNote(
        {
          ...clearTaskExecutionState(task),
          status: "pending"
        },
        note,
        timestampIso
      );
    }

    if (task.id === "delivery-package") {
      return appendTaskNote(
        {
          ...clearTaskExecutionState(task),
          status: "pending"
        },
        note,
        timestampIso
      );
    }

    return task;
  });

  return {
    ...finalizeRunState(runState, taskLedger, updatedTaskIds),
    appliedDecision: {
      action: "replan_feature",
      sourceTaskId,
      targetTaskId: ids.implementationTaskId
    }
  };
}

export function mapArtifactStatusToTaskStatus(status) {
  if (status === "completed") {
    return "completed";
  }

  if (status === "failed") {
    return "failed";
  }

  return "blocked";
}

export function applyTaskArtifactToRunState(
  runState,
  taskId,
  artifact,
  {
    notePrefix = "result",
    timestamp = new Date()
  } = {}
) {
  const preparedRunState = {
    ...runState,
    taskLedger: runState.taskLedger.map((task) =>
      task.id === taskId ? clearTaskExecutionState(task) : task
    )
  };

  if (!artifact?.automationDecision) {
    const nextStatus = mapArtifactStatusToTaskStatus(artifact.status);
    const nextRunState = updateTaskInRunState(
      preparedRunState,
      taskId,
      nextStatus,
      `${notePrefix}:${artifact.status}`
    );

    return {
      runState: nextRunState,
      updatedTasks: [
        {
          taskId,
          nextStatus
        }
      ],
      task: nextRunState.taskLedger.find((task) => task.id === taskId),
      appliedDecision: null
    };
  }

  let decisionResult;

  switch (artifact.automationDecision.action) {
    case "retry_task":
      decisionResult = applyRetryTaskDecision(
        preparedRunState,
        taskId,
        artifact.automationDecision,
        notePrefix,
        timestamp
      );
      break;
    case "rework_feature":
      decisionResult = applyReworkFeatureDecision(
        preparedRunState,
        taskId,
        artifact.automationDecision,
        notePrefix,
        timestamp
      );
      break;
    case "replan_feature":
      decisionResult = applyReplanFeatureDecision(
        preparedRunState,
        taskId,
        artifact.automationDecision,
        notePrefix,
        timestamp
      );
      break;
    default:
      throw new Error(`Unsupported automation decision action: ${artifact.automationDecision.action}`);
  }

  return {
    ...decisionResult,
    task: decisionResult.runState.taskLedger.find((task) => task.id === taskId)
  };
}
