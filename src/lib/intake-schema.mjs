import path from "node:path";

export const clarificationStatuses = new Set([
  "intake_received",
  "clarifying",
  "awaiting_confirmation",
  "confirmed",
  "clarification_blocked",
  "clarification_abandoned"
]);

const successCriterionStatuses = new Set(["defined", "needs_confirmation", "missing"]);
const requiredItemStatuses = new Set([
  "provided",
  "required",
  "missing",
  "needs_clarification"
]);
const dependencyStatuses = new Set(["available", "required", "missing", "needs_clarification"]);
const automationLevels = new Set(["full", "mostly-automated", "partial", "limited"]);
const questionCategories = new Set([
  "goal",
  "success",
  "inputs",
  "permissions",
  "constraints",
  "risks",
  "scope",
  "human_step"
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateStructuredArray(values, label, validateItem) {
  if (!Array.isArray(values)) {
    return [`${label} must be an array.`];
  }

  const errors = [];

  values.forEach((value, index) => {
    errors.push(...validateItem(value, `${label}[${index}]`));
  });

  return errors;
}

function validateSuccessCriterion(value, label) {
  const errors = [];

  if (!isPlainObject(value)) {
    return [`${label} must be an object.`];
  }

  if (!isNonEmptyString(value.text)) {
    errors.push(`${label}.text cannot be empty.`);
  }

  if (!successCriterionStatuses.has(value.status)) {
    errors.push(`${label}.status must be one of ${Array.from(successCriterionStatuses).join(", ")}.`);
  }

  return errors;
}

function validateRequiredItem(value, label) {
  const errors = [];

  if (!isPlainObject(value)) {
    return [`${label} must be an object.`];
  }

  if (!isNonEmptyString(value.name)) {
    errors.push(`${label}.name cannot be empty.`);
  }

  if (!isNonEmptyString(value.description)) {
    errors.push(`${label}.description cannot be empty.`);
  }

  if (!requiredItemStatuses.has(value.status)) {
    errors.push(`${label}.status must be one of ${Array.from(requiredItemStatuses).join(", ")}.`);
  }

  return errors;
}

function validateRequiredAccess(value, label) {
  const errors = [];

  if (!isPlainObject(value)) {
    return [`${label} must be an object.`];
  }

  if (!isNonEmptyString(value.system)) {
    errors.push(`${label}.system cannot be empty.`);
  }

  if (!isNonEmptyString(value.accessLevel)) {
    errors.push(`${label}.accessLevel cannot be empty.`);
  }

  if (!isNonEmptyString(value.reason)) {
    errors.push(`${label}.reason cannot be empty.`);
  }

  if (!dependencyStatuses.has(value.status)) {
    errors.push(`${label}.status must be one of ${Array.from(dependencyStatuses).join(", ")}.`);
  }

  return errors;
}

function validateDependency(value, label) {
  const errors = [];

  if (!isPlainObject(value)) {
    return [`${label} must be an object.`];
  }

  if (!isNonEmptyString(value.name)) {
    errors.push(`${label}.name cannot be empty.`);
  }

  if (!isNonEmptyString(value.type)) {
    errors.push(`${label}.type cannot be empty.`);
  }

  if (!dependencyStatuses.has(value.status)) {
    errors.push(`${label}.status must be one of ${Array.from(dependencyStatuses).join(", ")}.`);
  }

  return errors;
}

function validateAutomationAssessment(value) {
  const errors = [];

  if (!isPlainObject(value)) {
    return ["automationAssessment must be an object."];
  }

  if (!automationLevels.has(value.automationLevel)) {
    errors.push(
      `automationAssessment.automationLevel must be one of ${Array.from(automationLevels).join(", ")}.`
    );
  }

  if (typeof value.canFullyAutomate !== "boolean") {
    errors.push("automationAssessment.canFullyAutomate must be a boolean.");
  }

  if (
    typeof value.estimatedAutomatablePercent !== "number" ||
    !Number.isFinite(value.estimatedAutomatablePercent) ||
    value.estimatedAutomatablePercent < 0 ||
    value.estimatedAutomatablePercent > 100
  ) {
    errors.push("automationAssessment.estimatedAutomatablePercent must be a number between 0 and 100.");
  }

  if (!isStringArray(value.humanStepsRequired)) {
    errors.push("automationAssessment.humanStepsRequired must be an array of strings.");
  }

  if (!isStringArray(value.blockers)) {
    errors.push("automationAssessment.blockers must be an array of strings.");
  }

  if (!isStringArray(value.rationale)) {
    errors.push("automationAssessment.rationale must be an array of strings.");
  }

  return errors;
}

function validateOpenQuestion(value, label) {
  const errors = [];

  if (!isPlainObject(value)) {
    return [`${label} must be an object.`];
  }

  if (!isNonEmptyString(value.id)) {
    errors.push(`${label}.id cannot be empty.`);
  }

  if (!questionCategories.has(value.category)) {
    errors.push(`${label}.category must be one of ${Array.from(questionCategories).join(", ")}.`);
  }

  if (!isNonEmptyString(value.question)) {
    errors.push(`${label}.question cannot be empty.`);
  }

  if (typeof value.blocking !== "boolean") {
    errors.push(`${label}.blocking must be a boolean.`);
  }

  return errors;
}

function normalizeArtifactPath(relativePath) {
  return String(relativePath).replace(/\\/g, "/").split(path.sep).join("/");
}

export function createClarificationArtifactPaths(workspaceRoot, config = null) {
  const artifactConfig = config?.artifacts ?? {};
  const clarificationDirectory = path.resolve(
    workspaceRoot,
    artifactConfig.clarificationDirectory ?? path.join("artifacts", "clarification")
  );
  const intakeSpecFile = artifactConfig.intakeSpecFile ?? "intake-spec.json";
  const intakeSummaryFile = artifactConfig.intakeSummaryFile ?? "intake-summary.md";

  return {
    clarificationDirectory,
    intakeSpecPath: path.join(clarificationDirectory, intakeSpecFile),
    intakeSummaryPath: path.join(clarificationDirectory, intakeSummaryFile)
  };
}

export function validateIntakeSpec(spec) {
  const errors = [];

  if (!isPlainObject(spec)) {
    return {
      valid: false,
      errors: ["Intake spec must be a JSON object."]
    };
  }

  for (const field of [
    "requestId",
    "title",
    "originalRequest",
    "clarifiedGoal",
    "clarificationStatus",
    "recommendedNextStep",
    "lastUpdatedAt"
  ]) {
    if (!isNonEmptyString(spec[field])) {
      errors.push(`${field} cannot be empty.`);
    }
  }

  if (!clarificationStatuses.has(spec.clarificationStatus)) {
    errors.push(
      `clarificationStatus must be one of ${Array.from(clarificationStatuses).join(", ")}.`
    );
  }

  if (typeof spec.approvalRequired !== "boolean") {
    errors.push("approvalRequired must be a boolean.");
  }

  if (typeof spec.confirmedByUser !== "boolean") {
    errors.push("confirmedByUser must be a boolean.");
  }

  if (!isStringArray(spec.nonGoals)) {
    errors.push("nonGoals must be an array of strings.");
  }

  if (!isStringArray(spec.inScope)) {
    errors.push("inScope must be an array of strings.");
  }

  if (!isStringArray(spec.outOfScope)) {
    errors.push("outOfScope must be an array of strings.");
  }

  if (!isStringArray(spec.constraints)) {
    errors.push("constraints must be an array of strings.");
  }

  if (!isStringArray(spec.risks)) {
    errors.push("risks must be an array of strings.");
  }

  errors.push(...validateStructuredArray(spec.successCriteria, "successCriteria", validateSuccessCriterion));
  errors.push(...validateStructuredArray(spec.requiredInputs, "requiredInputs", validateRequiredItem));
  errors.push(
    ...validateStructuredArray(
      spec.requiredAccountsAndPermissions,
      "requiredAccountsAndPermissions",
      validateRequiredAccess
    )
  );
  errors.push(
    ...validateStructuredArray(spec.externalDependencies, "externalDependencies", validateDependency)
  );
  errors.push(...validateAutomationAssessment(spec.automationAssessment));
  errors.push(...validateStructuredArray(spec.openQuestions, "openQuestions", validateOpenQuestion));

  return {
    valid: errors.length === 0,
    errors
  };
}

export function createRunStateIntakeSnapshot(spec, artifactPaths, workspaceRoot) {
  return {
    requestId: spec.requestId,
    title: spec.title,
    clarificationStatus: spec.clarificationStatus,
    confirmedByUser: spec.confirmedByUser,
    recommendedNextStep: spec.recommendedNextStep,
    approvalRequired: spec.approvalRequired,
    clarifiedGoal: spec.clarifiedGoal,
    openQuestionCount: Array.isArray(spec.openQuestions) ? spec.openQuestions.length : 0,
    automationAssessment: {
      automationLevel: spec.automationAssessment?.automationLevel ?? "limited",
      canFullyAutomate: spec.automationAssessment?.canFullyAutomate ?? false,
      estimatedAutomatablePercent: spec.automationAssessment?.estimatedAutomatablePercent ?? 0
    },
    artifactPaths: {
      intakeSpecPath: normalizeArtifactPath(path.relative(workspaceRoot, artifactPaths.intakeSpecPath)),
      intakeSummaryPath: normalizeArtifactPath(path.relative(workspaceRoot, artifactPaths.intakeSummaryPath))
    },
    lastUpdatedAt: spec.lastUpdatedAt
  };
}
