import { randomUUID } from "node:crypto";

export const RUN_PHASES = Object.freeze([
  "queued",
  "planning",
  "executing",
  "reviewing",
  "verifying",
  "publishing",
  "done",
  "blocked",
  "exhausted"
]);

export const ACTIVE_RUN_PHASES = Object.freeze([
  "planning",
  "executing",
  "reviewing",
  "verifying",
  "publishing"
]);

export const TERMINAL_RUN_PHASES = Object.freeze(["done", "blocked", "exhausted"]);

export const TASK_PHASES = Object.freeze([...ACTIVE_RUN_PHASES]);

export const TASK_STATUSES = Object.freeze([
  "queued",
  "ready",
  "in_progress",
  "completed",
  "blocked",
  "exhausted"
]);

export const ACTIVE_TASK_STATUSES = Object.freeze(["queued", "ready", "in_progress"]);
export const TERMINAL_TASK_STATUSES = Object.freeze(["completed", "blocked", "exhausted"]);

export const REVIEW_DECISIONS = Object.freeze(["approved", "changes_requested", "rejected"]);
export const TASK_RESULT_OUTCOMES = Object.freeze(["success", "blocked", "exhausted"]);
export const TRANSITION_TYPES = Object.freeze([
  "run_initialized",
  "run_phase_changed",
  "task_status_changed",
  "loop_advanced",
  "review_recorded"
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new TypeError(message);
  }
}

function assertPositiveInteger(value, label) {
  assertCondition(Number.isInteger(value) && value > 0, `${label} must be a positive integer.`);
}

function assertNonNegativeInteger(value, label) {
  assertCondition(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer.`);
}

function assertNonEmptyString(value, label) {
  assertCondition(typeof value === "string" && value.trim().length > 0, `${label} must be a non-empty string.`);
}

function assertStringArray(value, label) {
  assertCondition(Array.isArray(value), `${label} must be an array.`);

  for (const item of value) {
    assertCondition(typeof item === "string", `${label} must contain only strings.`);
  }
}

function assertEnumMember(value, allowedValues, label) {
  assertCondition(allowedValues.includes(value), `${label} must be one of: ${allowedValues.join(", ")}.`);
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
}

function normalizeMetadata(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function isTransitionEndpointValue(value) {
  return value === null || typeof value === "string" || typeof value === "number";
}

export function createLoopPolicy({
  maxLoops = 3,
  defaultTaskMaxAttempts = 2,
  phaseRetryLimits = {}
} = {}) {
  const normalizedPhaseRetryLimits = {};

  for (const phase of TASK_PHASES) {
    const explicitValue = phaseRetryLimits?.[phase];
    normalizedPhaseRetryLimits[phase] = Number.isInteger(explicitValue) && explicitValue > 0
      ? explicitValue
      : defaultTaskMaxAttempts;
  }

  const policy = {
    maxLoops,
    defaultTaskMaxAttempts,
    phaseRetryLimits: normalizedPhaseRetryLimits
  };

  assertLoopPolicy(policy);
  return policy;
}

export function assertLoopPolicy(loopPolicy) {
  assertCondition(isPlainObject(loopPolicy), "loopPolicy must be an object.");
  assertPositiveInteger(loopPolicy.maxLoops, "loopPolicy.maxLoops");
  assertPositiveInteger(loopPolicy.defaultTaskMaxAttempts, "loopPolicy.defaultTaskMaxAttempts");
  assertCondition(isPlainObject(loopPolicy.phaseRetryLimits), "loopPolicy.phaseRetryLimits must be an object.");

  for (const phase of Object.keys(loopPolicy.phaseRetryLimits)) {
    assertEnumMember(phase, TASK_PHASES, "loopPolicy.phaseRetryLimits phase key");
    assertPositiveInteger(
      loopPolicy.phaseRetryLimits[phase],
      `loopPolicy.phaseRetryLimits.${phase}`
    );
  }
}

export function createTaskDefinition({
  id,
  title,
  phase,
  dependsOn = [],
  acceptanceCriteria = [],
  maxAttempts = null,
  metadata = {}
}) {
  const taskDefinition = {
    id,
    title,
    phase,
    dependsOn: normalizeStringArray(dependsOn),
    acceptanceCriteria: normalizeStringArray(acceptanceCriteria),
    maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : null,
    metadata: normalizeMetadata(metadata)
  };

  assertTaskDefinition(taskDefinition);
  return taskDefinition;
}

export function assertTaskDefinition(taskDefinition) {
  assertCondition(isPlainObject(taskDefinition), "TaskDefinition must be an object.");
  assertNonEmptyString(taskDefinition.id, "TaskDefinition.id");
  assertNonEmptyString(taskDefinition.title, "TaskDefinition.title");
  assertEnumMember(taskDefinition.phase, TASK_PHASES, "TaskDefinition.phase");
  assertStringArray(taskDefinition.dependsOn, "TaskDefinition.dependsOn");
  assertStringArray(taskDefinition.acceptanceCriteria, "TaskDefinition.acceptanceCriteria");

  if (taskDefinition.maxAttempts !== null) {
    assertPositiveInteger(taskDefinition.maxAttempts, "TaskDefinition.maxAttempts");
  }

  assertCondition(isPlainObject(taskDefinition.metadata), "TaskDefinition.metadata must be an object.");
}

export function createReviewDecision({
  taskId,
  decision,
  summary,
  findings = [],
  actor = "system",
  decidedAt = new Date().toISOString(),
  metadata = {}
}) {
  const reviewDecision = {
    taskId,
    decision,
    summary,
    findings: normalizeStringArray(findings),
    actor,
    decidedAt,
    metadata: normalizeMetadata(metadata)
  };

  assertReviewDecision(reviewDecision);
  return reviewDecision;
}

export function assertReviewDecision(reviewDecision) {
  assertCondition(isPlainObject(reviewDecision), "ReviewDecision must be an object.");
  assertNonEmptyString(reviewDecision.taskId, "ReviewDecision.taskId");
  assertEnumMember(reviewDecision.decision, REVIEW_DECISIONS, "ReviewDecision.decision");
  assertNonEmptyString(reviewDecision.summary, "ReviewDecision.summary");
  assertStringArray(reviewDecision.findings, "ReviewDecision.findings");
  assertNonEmptyString(reviewDecision.actor, "ReviewDecision.actor");
  assertNonEmptyString(reviewDecision.decidedAt, "ReviewDecision.decidedAt");
  assertCondition(isPlainObject(reviewDecision.metadata), "ReviewDecision.metadata must be an object.");
}

export function createTaskResult({
  taskId,
  outcome,
  summary,
  changedFiles = [],
  verification = [],
  notes = [],
  reviewDecision = null,
  actor = "system",
  producedAt = new Date().toISOString(),
  metadata = {}
}) {
  const taskResult = {
    taskId,
    outcome,
    summary,
    changedFiles: normalizeStringArray(changedFiles),
    verification: normalizeStringArray(verification),
    notes: normalizeStringArray(notes),
    reviewDecision,
    actor,
    producedAt,
    metadata: normalizeMetadata(metadata)
  };

  assertTaskResult(taskResult);
  return taskResult;
}

export function assertTaskResult(taskResult) {
  assertCondition(isPlainObject(taskResult), "TaskResult must be an object.");
  assertNonEmptyString(taskResult.taskId, "TaskResult.taskId");
  assertEnumMember(taskResult.outcome, TASK_RESULT_OUTCOMES, "TaskResult.outcome");
  assertNonEmptyString(taskResult.summary, "TaskResult.summary");
  assertStringArray(taskResult.changedFiles, "TaskResult.changedFiles");
  assertStringArray(taskResult.verification, "TaskResult.verification");
  assertStringArray(taskResult.notes, "TaskResult.notes");
  assertNonEmptyString(taskResult.actor, "TaskResult.actor");
  assertNonEmptyString(taskResult.producedAt, "TaskResult.producedAt");
  assertCondition(isPlainObject(taskResult.metadata), "TaskResult.metadata must be an object.");

  if (taskResult.reviewDecision !== null) {
    assertReviewDecision(taskResult.reviewDecision);
  }
}

export function createTaskRecord({
  taskId,
  phase,
  dependsOn = [],
  status = "queued",
  attemptCount = 0,
  maxAttempts,
  lastResult = null,
  lastReviewDecision = null,
  createdAt = new Date().toISOString(),
  updatedAt = createdAt,
  metadata = {}
}) {
  const taskRecord = {
    taskId,
    phase,
    dependsOn: normalizeStringArray(dependsOn),
    status,
    attemptCount,
    maxAttempts,
    lastResult,
    lastReviewDecision,
    createdAt,
    updatedAt,
    metadata: normalizeMetadata(metadata)
  };

  assertTaskRecord(taskRecord);
  return taskRecord;
}

export function assertTaskRecord(taskRecord) {
  assertCondition(isPlainObject(taskRecord), "TaskRecord must be an object.");
  assertNonEmptyString(taskRecord.taskId, "TaskRecord.taskId");
  assertEnumMember(taskRecord.phase, TASK_PHASES, "TaskRecord.phase");
  assertStringArray(taskRecord.dependsOn, "TaskRecord.dependsOn");
  assertEnumMember(taskRecord.status, TASK_STATUSES, "TaskRecord.status");
  assertNonNegativeInteger(taskRecord.attemptCount, "TaskRecord.attemptCount");
  assertPositiveInteger(taskRecord.maxAttempts, "TaskRecord.maxAttempts");
  assertNonEmptyString(taskRecord.createdAt, "TaskRecord.createdAt");
  assertNonEmptyString(taskRecord.updatedAt, "TaskRecord.updatedAt");
  assertCondition(isPlainObject(taskRecord.metadata), "TaskRecord.metadata must be an object.");

  if (taskRecord.lastResult !== null) {
    assertTaskResult(taskRecord.lastResult);
  }

  if (taskRecord.lastReviewDecision !== null) {
    assertReviewDecision(taskRecord.lastReviewDecision);
  }
}

export function createTransitionRecord({
  id = randomUUID(),
  type,
  runId,
  taskId = null,
  from = null,
  to = null,
  reason = "",
  actor = "system",
  at = new Date().toISOString(),
  loopCount = 0,
  metadata = {}
}) {
  const transitionRecord = {
    id,
    type,
    runId,
    taskId,
    from,
    to,
    reason,
    actor,
    at,
    loopCount,
    metadata: normalizeMetadata(metadata)
  };

  assertTransitionRecord(transitionRecord);
  return transitionRecord;
}

export function assertTransitionRecord(transitionRecord) {
  assertCondition(isPlainObject(transitionRecord), "TransitionRecord must be an object.");
  assertNonEmptyString(transitionRecord.id, "TransitionRecord.id");
  assertEnumMember(transitionRecord.type, TRANSITION_TYPES, "TransitionRecord.type");
  assertNonEmptyString(transitionRecord.runId, "TransitionRecord.runId");

  if (transitionRecord.taskId !== null) {
    assertNonEmptyString(transitionRecord.taskId, "TransitionRecord.taskId");
  }

  assertCondition(
    isTransitionEndpointValue(transitionRecord.from),
    "TransitionRecord.from must be a string, number, or null."
  );
  assertCondition(
    isTransitionEndpointValue(transitionRecord.to),
    "TransitionRecord.to must be a string, number, or null."
  );
  assertCondition(typeof transitionRecord.reason === "string", "TransitionRecord.reason must be a string.");
  assertNonEmptyString(transitionRecord.actor, "TransitionRecord.actor");
  assertNonEmptyString(transitionRecord.at, "TransitionRecord.at");
  assertNonNegativeInteger(transitionRecord.loopCount, "TransitionRecord.loopCount");
  assertCondition(isPlainObject(transitionRecord.metadata), "TransitionRecord.metadata must be an object.");
}

export function assertRunRecord(runRecord) {
  assertCondition(isPlainObject(runRecord), "RunRecord must be an object.");
  assertNonEmptyString(runRecord.runId, "RunRecord.runId");
  assertEnumMember(runRecord.phase, RUN_PHASES, "RunRecord.phase");
  assertNonNegativeInteger(runRecord.loopCount, "RunRecord.loopCount");
  assertPositiveInteger(runRecord.maxLoops, "RunRecord.maxLoops");
  assertLoopPolicy(runRecord.loopPolicy);
  assertCondition(Array.isArray(runRecord.taskDefinitions), "RunRecord.taskDefinitions must be an array.");
  assertCondition(Array.isArray(runRecord.tasks), "RunRecord.tasks must be an array.");
  assertCondition(Array.isArray(runRecord.transitions), "RunRecord.transitions must be an array.");
  assertNonEmptyString(runRecord.createdAt, "RunRecord.createdAt");
  assertNonEmptyString(runRecord.updatedAt, "RunRecord.updatedAt");
  assertCondition(isPlainObject(runRecord.metadata), "RunRecord.metadata must be an object.");

  const seenDefinitionIds = new Set();

  for (const definition of runRecord.taskDefinitions) {
    assertTaskDefinition(definition);
    assertCondition(!seenDefinitionIds.has(definition.id), `Duplicate TaskDefinition id: ${definition.id}`);
    seenDefinitionIds.add(definition.id);
  }

  const seenTaskIds = new Set();

  for (const task of runRecord.tasks) {
    assertTaskRecord(task);
    assertCondition(!seenTaskIds.has(task.taskId), `Duplicate TaskRecord taskId: ${task.taskId}`);
    assertCondition(
      seenDefinitionIds.has(task.taskId),
      `TaskRecord.taskId ${task.taskId} must match a TaskDefinition id.`
    );
    seenTaskIds.add(task.taskId);
  }

  assertCondition(
    seenTaskIds.size === seenDefinitionIds.size,
    "RunRecord.tasks must contain exactly one TaskRecord for every TaskDefinition."
  );

  for (const transition of runRecord.transitions) {
    assertTransitionRecord(transition);
  }
}
