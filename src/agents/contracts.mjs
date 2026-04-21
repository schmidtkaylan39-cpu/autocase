const AGENT_SCHEMA_VERSION = "1.0";

export const AGENT_ROLES = Object.freeze([
  "planner",
  "executor",
  "reviewer",
  "verifier"
]);

export const TASK_MODES = Object.freeze([
  "generic",
  "repo"
]);

export const TASK_TEMPLATE_IDS = Object.freeze([
  "ebook",
  "website",
  "research",
  "autofix"
]);

export const PLANNER_STATUSES = Object.freeze([
  "ready",
  "blocked"
]);

export const EXECUTOR_STATUSES = Object.freeze([
  "completed",
  "retry",
  "blocked",
  "failed"
]);

export const REVIEWER_VERDICTS = Object.freeze([
  "approve",
  "retry",
  "comment_only",
  "reject"
]);

export const VERIFIER_STATUSES = Object.freeze([
  "pass",
  "fail",
  "blocked"
]);

export const FINDING_SEVERITIES = Object.freeze([
  "info",
  "low",
  "medium",
  "high",
  "critical"
]);

export const FAILURE_CATEGORIES = Object.freeze([
  "rate_limit",
  "timeout",
  "missing_dependency",
  "environment_mismatch",
  "artifact_invalid",
  "verification_failed",
  "logic_bug",
  "unknown"
]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function nonEmptyString(value, fieldName) {
  invariant(typeof value === "string" && value.trim().length > 0, `${fieldName} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

function enumValue(value, allowedValues, fieldName) {
  invariant(allowedValues.includes(value), `${fieldName} must be one of: ${allowedValues.join(", ")}.`);
  return value;
}

function normalizeDeliverable(deliverable, index) {
  const name = nonEmptyString(deliverable?.name ?? deliverable?.id ?? `deliverable-${index + 1}`, `deliverables[${index}].name`);
  return {
    id: optionalString(deliverable?.id) ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
    name,
    description: nonEmptyString(deliverable?.description ?? name, `deliverables[${index}].description`),
    required: deliverable?.required !== false
  };
}

function normalizeArtifact(artifact, index) {
  return {
    name: nonEmptyString(artifact?.name ?? `artifact-${index + 1}`, `artifacts[${index}].name`),
    kind: nonEmptyString(artifact?.kind ?? "artifact", `artifacts[${index}].kind`),
    path: optionalString(artifact?.path),
    description: optionalString(artifact?.description)
  };
}

function normalizeRepoContext(repoContext = {}) {
  return {
    rootPath: optionalString(repoContext.rootPath),
    targetPaths: stringList(repoContext.targetPaths),
    entryPoints: stringList(repoContext.entryPoints),
    changedFiles: stringList(repoContext.changedFiles),
    commands: stringList(repoContext.commands),
    issueReference: optionalString(repoContext.issueReference),
    baseBranch: optionalString(repoContext.baseBranch)
  };
}

function normalizeTaskDescriptor(task = {}) {
  const taskMode = enumValue(task.taskMode ?? "generic", TASK_MODES, "task.taskMode");
  const templateId = task.templateId == null
    ? null
    : enumValue(task.templateId, TASK_TEMPLATE_IDS, "task.templateId");

  return {
    taskId: nonEmptyString(task.taskId ?? "task", "task.taskId"),
    title: nonEmptyString(task.title ?? task.goal ?? "Untitled task", "task.title"),
    goal: nonEmptyString(task.goal ?? task.title ?? "Goal missing", "task.goal"),
    taskMode,
    templateId,
    deliverables: (Array.isArray(task.deliverables) ? task.deliverables : [])
      .map((deliverable, index) => normalizeDeliverable(deliverable, index)),
    acceptanceCriteria: stringList(task.acceptanceCriteria),
    constraints: stringList(task.constraints),
    sourceArtifacts: (Array.isArray(task.sourceArtifacts) ? task.sourceArtifacts : [])
      .map((artifact, index) => normalizeArtifact(artifact, index)),
    repoContext: taskMode === "repo" ? normalizeRepoContext(task.repoContext) : null
  };
}

function normalizeCheck(check, index) {
  return {
    id: nonEmptyString(check?.id ?? `check-${index + 1}`, `checks[${index}].id`),
    name: nonEmptyString(check?.name ?? check?.id ?? `check-${index + 1}`, `checks[${index}].name`),
    status: enumValue(check?.status ?? "not_run", ["passed", "failed", "not_run", "blocked"], `checks[${index}].status`),
    command: optionalString(check?.command),
    evidence: optionalString(check?.evidence),
    required: check?.required !== false
  };
}

function normalizeFinding(finding, index) {
  return {
    id: nonEmptyString(finding?.id ?? `finding-${index + 1}`, `findings[${index}].id`),
    severity: enumValue(finding?.severity ?? "medium", FINDING_SEVERITIES, `findings[${index}].severity`),
    title: nonEmptyString(finding?.title ?? `Finding ${index + 1}`, `findings[${index}].title`),
    description: nonEmptyString(finding?.description ?? finding?.title ?? `Finding ${index + 1}`, `findings[${index}].description`),
    path: optionalString(finding?.path),
    suggestedAction: optionalString(finding?.suggestedAction)
  };
}

function normalizeRisk(risk, index) {
  return {
    id: nonEmptyString(risk?.id ?? `risk-${index + 1}`, `risks[${index}].id`),
    severity: enumValue(risk?.severity ?? "medium", ["low", "medium", "high", "critical"], `risks[${index}].severity`),
    description: nonEmptyString(risk?.description ?? `Risk ${index + 1}`, `risks[${index}].description`),
    mitigation: nonEmptyString(risk?.mitigation ?? "Mitigation not provided.", `risks[${index}].mitigation`)
  };
}

function normalizeWorkItem(item, index) {
  return {
    id: nonEmptyString(item?.id ?? `step-${index + 1}`, `workPlan[${index}].id`),
    title: nonEmptyString(item?.title ?? `Step ${index + 1}`, `workPlan[${index}].title`),
    description: nonEmptyString(item?.description ?? item?.title ?? `Step ${index + 1}`, `workPlan[${index}].description`),
    dependsOn: stringList(item?.dependsOn),
    owner: optionalString(item?.owner)
  };
}

function baseEnvelope(role, payload = {}) {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: role,
    ...payload
  };
}

export function createPlannerRequest({
  task,
  assumptions = [],
  knownRisks = [],
  requiredArtifacts = [],
  requestedOutputs = []
}) {
  return baseEnvelope("planner", {
    task: normalizeTaskDescriptor(task),
    assumptions: stringList(assumptions),
    knownRisks: stringList(knownRisks),
    requiredArtifacts: stringList(requiredArtifacts),
    requestedOutputs: stringList(requestedOutputs)
  });
}

export function createExecutorRequest({
  task,
  implementationPlan = [],
  allowedWritePaths = [],
  verificationCommands = [],
  existingArtifacts = []
}) {
  return baseEnvelope("executor", {
    task: normalizeTaskDescriptor(task),
    implementationPlan: stringList(implementationPlan),
    allowedWritePaths: stringList(allowedWritePaths),
    verificationCommands: stringList(verificationCommands),
    existingArtifacts: (Array.isArray(existingArtifacts) ? existingArtifacts : [])
      .map((artifact, index) => normalizeArtifact(artifact, index))
  });
}

export function createReviewerRequest({
  task,
  reviewTargets = [],
  acceptanceChecks = [],
  failClosed = true,
  requiredVerdicts = REVIEWER_VERDICTS
}) {
  return baseEnvelope("reviewer", {
    task: normalizeTaskDescriptor(task),
    reviewTargets: stringList(reviewTargets),
    acceptanceChecks: stringList(acceptanceChecks),
    failClosed: failClosed !== false,
    requiredVerdicts: requiredVerdicts.map((verdict) => enumValue(verdict, REVIEWER_VERDICTS, "requiredVerdicts"))
  });
}

export function createVerifierRequest({
  task,
  requiredChecks = [],
  optionalChecks = [],
  requiredArtifacts = []
}) {
  return baseEnvelope("verifier", {
    task: normalizeTaskDescriptor(task),
    requiredChecks: stringList(requiredChecks),
    optionalChecks: stringList(optionalChecks),
    requiredArtifacts: stringList(requiredArtifacts)
  });
}

export function createPlannerOutput({
  status = "ready",
  summary,
  assumptions = [],
  workPlan = [],
  acceptanceChecks = [],
  risks = [],
  nextActions = [],
  notes = []
}) {
  return baseEnvelope("planner", {
    status: enumValue(status, PLANNER_STATUSES, "status"),
    summary: nonEmptyString(summary, "summary"),
    assumptions: stringList(assumptions),
    workPlan: (Array.isArray(workPlan) ? workPlan : []).map((item, index) => normalizeWorkItem(item, index)),
    acceptanceChecks: stringList(acceptanceChecks),
    risks: (Array.isArray(risks) ? risks : []).map((risk, index) => normalizeRisk(risk, index)),
    nextActions: stringList(nextActions),
    notes: stringList(notes)
  });
}

export function createExecutorOutput({
  status = "completed",
  summary,
  changedFiles = [],
  patchSummary = [],
  verification = [],
  artifacts = [],
  notes = [],
  blocker = null
}) {
  return baseEnvelope("executor", {
    status: enumValue(status, EXECUTOR_STATUSES, "status"),
    summary: nonEmptyString(summary, "summary"),
    changedFiles: stringList(changedFiles),
    patchSummary: stringList(patchSummary),
    verification: (Array.isArray(verification) ? verification : []).map((check, index) => normalizeCheck(check, index)),
    artifacts: (Array.isArray(artifacts) ? artifacts : []).map((artifact, index) => normalizeArtifact(artifact, index)),
    notes: stringList(notes),
    blocker: blocker
      ? {
          category: enumValue(blocker.category ?? "unknown", FAILURE_CATEGORIES, "blocker.category"),
          message: nonEmptyString(blocker.message ?? "Execution blocked.", "blocker.message"),
          evidence: optionalString(blocker.evidence)
        }
      : null
  });
}

export function createReviewerOutput({
  verdict = "comment_only",
  summary,
  findings = [],
  requiredChanges = [],
  notes = [],
  failClosed = true
}) {
  const normalizedVerdict = enumValue(verdict, REVIEWER_VERDICTS, "verdict");
  return baseEnvelope("reviewer", {
    verdict: normalizedVerdict,
    summary: nonEmptyString(summary, "summary"),
    failClosed: failClosed !== false,
    findings: (Array.isArray(findings) ? findings : []).map((finding, index) => normalizeFinding(finding, index)),
    requiredChanges: stringList(requiredChanges),
    notes: stringList(notes),
    releaseDecision: {
      canProceed: normalizedVerdict === "approve",
      reason:
        normalizedVerdict === "approve"
          ? "Reviewer explicitly approved the change."
          : "Reviewer did not approve the change; fail-closed gate remains closed."
    }
  });
}

export function createVerifierOutput({
  status = "pass",
  summary,
  checks = [],
  notes = [],
  failure = null
}) {
  return baseEnvelope("verifier", {
    status: enumValue(status, VERIFIER_STATUSES, "status"),
    summary: nonEmptyString(summary, "summary"),
    checks: (Array.isArray(checks) ? checks : []).map((check, index) => normalizeCheck(check, index)),
    notes: stringList(notes),
    failure: failure
      ? {
          category: enumValue(failure.category ?? "unknown", FAILURE_CATEGORIES, "failure.category"),
          message: nonEmptyString(failure.message ?? "Verification failed.", "failure.message"),
          evidence: optionalString(failure.evidence)
        }
      : null
  });
}

export const plannerInterface = Object.freeze({
  role: "planner",
  schemaVersion: AGENT_SCHEMA_VERSION,
  supportsTaskModes: TASK_MODES,
  inputFields: Object.freeze([
    "task",
    "assumptions",
    "knownRisks",
    "requiredArtifacts",
    "requestedOutputs"
  ]),
  outputFields: Object.freeze([
    "schemaVersion",
    "agent",
    "status",
    "summary",
    "assumptions",
    "workPlan",
    "acceptanceChecks",
    "risks",
    "nextActions",
    "notes"
  ]),
  structuredOnly: true
});

export const executorInterface = Object.freeze({
  role: "executor",
  schemaVersion: AGENT_SCHEMA_VERSION,
  supportsTaskModes: TASK_MODES,
  inputFields: Object.freeze([
    "task",
    "implementationPlan",
    "allowedWritePaths",
    "verificationCommands",
    "existingArtifacts"
  ]),
  outputFields: Object.freeze([
    "schemaVersion",
    "agent",
    "status",
    "summary",
    "changedFiles",
    "patchSummary",
    "verification",
    "artifacts",
    "notes",
    "blocker"
  ]),
  structuredOnly: true
});

export const reviewerInterface = Object.freeze({
  role: "reviewer",
  schemaVersion: AGENT_SCHEMA_VERSION,
  supportsTaskModes: TASK_MODES,
  inputFields: Object.freeze([
    "task",
    "reviewTargets",
    "acceptanceChecks",
    "failClosed",
    "requiredVerdicts"
  ]),
  outputFields: Object.freeze([
    "schemaVersion",
    "agent",
    "verdict",
    "summary",
    "failClosed",
    "findings",
    "requiredChanges",
    "notes",
    "releaseDecision"
  ]),
  verdicts: REVIEWER_VERDICTS,
  structuredOnly: true,
  failClosed: true
});

export const verifierInterface = Object.freeze({
  role: "verifier",
  schemaVersion: AGENT_SCHEMA_VERSION,
  supportsTaskModes: TASK_MODES,
  inputFields: Object.freeze([
    "task",
    "requiredChecks",
    "optionalChecks",
    "requiredArtifacts"
  ]),
  outputFields: Object.freeze([
    "schemaVersion",
    "agent",
    "status",
    "summary",
    "checks",
    "notes",
    "failure"
  ]),
  structuredOnly: true
});

export const agentInterfaces = Object.freeze({
  planner: plannerInterface,
  executor: executorInterface,
  reviewer: reviewerInterface,
  verifier: verifierInterface
});

