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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allowedAutomationActionsForTask(taskId) {
  if (taskId === "planning-brief" || taskId === "delivery-package") {
    return new Set(["retry_task"]);
  }

  if (/^review-/.test(taskId) || /^verify-/.test(taskId)) {
    return new Set(["retry_task", "rework_feature", "replan_feature"]);
  }

  if (/^implement-/.test(taskId)) {
    return new Set(["retry_task", "replan_feature"]);
  }

  return new Set(["retry_task"]);
}

function extractFeatureKey(taskId) {
  const match = /^(implement|review|verify)-(.+)$/.exec(String(taskId));
  return match ? match[2] : null;
}

function validateAdvisoryCompletionDecision(decision) {
  const validActions = new Set(["continue", "dispatch"]);

  if (!isPlainObject(decision)) {
    throw new Error("automationDecision must be an object when provided.");
  }

  if (!validActions.has(decision.action)) {
    throw new Error(
      "automationDecision is only allowed on completed result artifacts for advisory continue/dispatch hints."
    );
  }

  if (!isNonEmptyString(decision.reason)) {
    throw new Error("automationDecision.reason must be a non-empty string.");
  }

  if (decision.targetTaskId !== undefined && !isNonEmptyString(decision.targetTaskId)) {
    throw new Error("automationDecision.targetTaskId must be a non-empty string when provided.");
  }

  if (decision.delayMinutes !== undefined) {
    throw new Error("automationDecision.delayMinutes is only valid for retry_task actions.");
  }

  return decision;
}

function validateAutomationDecision(decision, artifactStatus, expectedTaskId) {
  const validActions = new Set(["retry_task", "rework_feature", "replan_feature"]);

  if (!isPlainObject(decision)) {
    throw new Error("automationDecision must be an object when provided.");
  }

  if (artifactStatus === "completed") {
    return validateAdvisoryCompletionDecision(decision);
  }

  if (artifactStatus !== "blocked") {
    throw new Error("automationDecision is only allowed on blocked result artifacts.");
  }

  if (!validActions.has(decision.action)) {
    throw new Error(`Unsupported automationDecision action: ${decision.action}`);
  }

  if (!isNonEmptyString(decision.reason)) {
    throw new Error("automationDecision.reason must be a non-empty string.");
  }

  if (decision.targetTaskId !== undefined && !isNonEmptyString(decision.targetTaskId)) {
    throw new Error("automationDecision.targetTaskId must be a non-empty string when provided.");
  }

  if (isNonEmptyString(expectedTaskId)) {
    const allowedActions = allowedAutomationActionsForTask(expectedTaskId);

    if (!allowedActions.has(decision.action)) {
      throw new Error(
        `Task ${expectedTaskId} cannot emit automationDecision action ${decision.action}.`
      );
    }
  }

  if (decision.action === "retry_task") {
    if (
      decision.targetTaskId !== undefined &&
      isNonEmptyString(expectedTaskId) &&
      decision.targetTaskId !== expectedTaskId
    ) {
      throw new Error("retry_task automationDecision.targetTaskId must match the source task.");
    }

    if (
      decision.delayMinutes !== undefined &&
      (!Number.isFinite(decision.delayMinutes) || decision.delayMinutes < 0)
    ) {
      throw new Error("automationDecision.delayMinutes must be a non-negative number when provided.");
    }

    return decision;
  }

  if (decision.delayMinutes !== undefined) {
    throw new Error("automationDecision.delayMinutes is only valid for retry_task actions.");
  }

  if (isNonEmptyString(expectedTaskId) && isNonEmptyString(decision.targetTaskId)) {
    const sourceFeatureKey = extractFeatureKey(expectedTaskId);
    const targetFeatureKey = extractFeatureKey(decision.targetTaskId);

    if (!sourceFeatureKey || !targetFeatureKey || sourceFeatureKey !== targetFeatureKey) {
      throw new Error(
        `automationDecision.targetTaskId must stay within the same feature as ${expectedTaskId}.`
      );
    }
  }

  return decision;
}

export function validateResultArtifact(artifact, expected = {}) {
  const validStatuses = new Set(["completed", "failed", "blocked"]);
  const valid =
    isNonEmptyString(artifact?.runId) &&
    isNonEmptyString(artifact?.taskId) &&
    isNonEmptyString(artifact?.handoffId) &&
    isNonEmptyString(artifact?.summary) &&
    artifact.summary.trim().length >= 5 &&
    validStatuses.has(artifact?.status) &&
    isStringArray(artifact?.changedFiles, { allowEmpty: true }) &&
    isStringArray(artifact?.verification) &&
    isStringArray(artifact?.notes);

  if (!valid) {
    throw new Error("Result artifact does not match the expected schema.");
  }

  if (expected.runId && artifact.runId !== expected.runId) {
    throw new Error(
      `Result artifact runId mismatch: expected ${expected.runId}, received ${artifact.runId}.`
    );
  }

  if (expected.taskId && artifact.taskId !== expected.taskId) {
    throw new Error(
      `Result artifact taskId mismatch: expected ${expected.taskId}, received ${artifact.taskId}.`
    );
  }

  if (expected.handoffId && artifact.handoffId !== expected.handoffId) {
    throw new Error(
      `Result artifact handoffId mismatch: expected ${expected.handoffId}, received ${artifact.handoffId}.`
    );
  }

  if (artifact.automationDecision !== undefined) {
    validateAutomationDecision(artifact.automationDecision, artifact.status, expected.taskId);
  }

  return artifact;
}
