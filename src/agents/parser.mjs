import {
  AGENT_ROLES,
  EXECUTOR_STATUSES,
  FAILURE_CATEGORIES,
  FINDING_SEVERITIES,
  PLANNER_STATUSES,
  REVIEWER_VERDICTS,
  VERIFIER_STATUSES
} from "./contracts.mjs";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, fieldName) {
  invariant(isObject(value), `${fieldName} must be an object.`);
  return value;
}

function requireNonEmptyString(value, fieldName) {
  invariant(typeof value === "string" && value.trim().length > 0, `${fieldName} must be a non-empty string.`);
  return value.trim();
}

function requireBoolean(value, fieldName) {
  invariant(typeof value === "boolean", `${fieldName} must be a boolean.`);
  return value;
}

function requireStringArray(value, fieldName) {
  invariant(Array.isArray(value), `${fieldName} must be an array.`);
  return value.map((item, index) => requireNonEmptyString(item, `${fieldName}[${index}]`));
}

function optionalString(value, fieldName) {
  if (value == null) {
    return null;
  }

  return requireNonEmptyString(value, fieldName);
}

function requireEnum(value, allowedValues, fieldName) {
  invariant(allowedValues.includes(value), `${fieldName} must be one of: ${allowedValues.join(", ")}.`);
  return value;
}

function parseRawJsonEnvelope(rawText) {
  const trimmed = String(rawText ?? "").trim();
  invariant(trimmed.length > 0, "Structured output is empty.");

  if (trimmed.startsWith("```")) {
    const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    invariant(match?.[1], "Structured output must contain exactly one fenced JSON block.");
    return JSON.parse(match[1]);
  }

  return JSON.parse(trimmed);
}

function validateBaseEnvelope(value, expectedRole) {
  const output = requireObject(value, "output");
  requireNonEmptyString(output.schemaVersion, "schemaVersion");
  requireEnum(output.agent, AGENT_ROLES, "agent");
  invariant(output.agent === expectedRole, `Expected agent "${expectedRole}" but received "${output.agent}".`);
  requireNonEmptyString(output.summary, "summary");
  return output;
}

function validateCheckArray(value, fieldName) {
  invariant(Array.isArray(value), `${fieldName} must be an array.`);
  return value.map((check, index) => {
    const item = requireObject(check, `${fieldName}[${index}]`);
    return {
      id: requireNonEmptyString(item.id, `${fieldName}[${index}].id`),
      name: requireNonEmptyString(item.name, `${fieldName}[${index}].name`),
      status: requireEnum(item.status, ["passed", "failed", "not_run", "blocked"], `${fieldName}[${index}].status`),
      command: optionalString(item.command, `${fieldName}[${index}].command`),
      evidence: optionalString(item.evidence, `${fieldName}[${index}].evidence`),
      required: item.required == null ? true : requireBoolean(item.required, `${fieldName}[${index}].required`)
    };
  });
}

function validateArtifactArray(value, fieldName) {
  invariant(Array.isArray(value), `${fieldName} must be an array.`);
  return value.map((artifact, index) => {
    const item = requireObject(artifact, `${fieldName}[${index}]`);
    return {
      name: requireNonEmptyString(item.name, `${fieldName}[${index}].name`),
      kind: requireNonEmptyString(item.kind, `${fieldName}[${index}].kind`),
      path: optionalString(item.path, `${fieldName}[${index}].path`),
      description: optionalString(item.description, `${fieldName}[${index}].description`)
    };
  });
}

function validateFindingArray(value, fieldName) {
  invariant(Array.isArray(value), `${fieldName} must be an array.`);
  return value.map((finding, index) => {
    const item = requireObject(finding, `${fieldName}[${index}]`);
    return {
      id: requireNonEmptyString(item.id, `${fieldName}[${index}].id`),
      severity: requireEnum(item.severity, FINDING_SEVERITIES, `${fieldName}[${index}].severity`),
      title: requireNonEmptyString(item.title, `${fieldName}[${index}].title`),
      description: requireNonEmptyString(item.description, `${fieldName}[${index}].description`),
      path: optionalString(item.path, `${fieldName}[${index}].path`),
      suggestedAction: optionalString(item.suggestedAction, `${fieldName}[${index}].suggestedAction`)
    };
  });
}

function validatePlannerOutput(output) {
  return {
    ...output,
    status: requireEnum(output.status, PLANNER_STATUSES, "status"),
    assumptions: requireStringArray(output.assumptions ?? [], "assumptions"),
    workPlan: (output.workPlan ?? []).map((step, index) => {
      const item = requireObject(step, `workPlan[${index}]`);
      return {
        id: requireNonEmptyString(item.id, `workPlan[${index}].id`),
        title: requireNonEmptyString(item.title, `workPlan[${index}].title`),
        description: requireNonEmptyString(item.description, `workPlan[${index}].description`),
        dependsOn: requireStringArray(item.dependsOn ?? [], `workPlan[${index}].dependsOn`),
        owner: optionalString(item.owner, `workPlan[${index}].owner`)
      };
    }),
    acceptanceChecks: requireStringArray(output.acceptanceChecks ?? [], "acceptanceChecks"),
    risks: (output.risks ?? []).map((risk, index) => {
      const item = requireObject(risk, `risks[${index}]`);
      return {
        id: requireNonEmptyString(item.id, `risks[${index}].id`),
        severity: requireEnum(item.severity, ["low", "medium", "high", "critical"], `risks[${index}].severity`),
        description: requireNonEmptyString(item.description, `risks[${index}].description`),
        mitigation: requireNonEmptyString(item.mitigation, `risks[${index}].mitigation`)
      };
    }),
    nextActions: requireStringArray(output.nextActions ?? [], "nextActions"),
    notes: requireStringArray(output.notes ?? [], "notes")
  };
}

function validateExecutorOutput(output) {
  return {
    ...output,
    status: requireEnum(output.status, EXECUTOR_STATUSES, "status"),
    changedFiles: requireStringArray(output.changedFiles ?? [], "changedFiles"),
    patchSummary: requireStringArray(output.patchSummary ?? [], "patchSummary"),
    verification: validateCheckArray(output.verification ?? [], "verification"),
    artifacts: validateArtifactArray(output.artifacts ?? [], "artifacts"),
    notes: requireStringArray(output.notes ?? [], "notes"),
    blocker: output.blocker == null
      ? null
      : {
          category: requireEnum(requireObject(output.blocker, "blocker").category, FAILURE_CATEGORIES, "blocker.category"),
          message: requireNonEmptyString(output.blocker.message, "blocker.message"),
          evidence: optionalString(output.blocker.evidence, "blocker.evidence")
        }
  };
}

function validateReviewerOutput(output) {
  const releaseDecision = requireObject(output.releaseDecision, "releaseDecision");
  return {
    ...output,
    verdict: requireEnum(output.verdict, REVIEWER_VERDICTS, "verdict"),
    failClosed: requireBoolean(output.failClosed, "failClosed"),
    findings: validateFindingArray(output.findings ?? [], "findings"),
    requiredChanges: requireStringArray(output.requiredChanges ?? [], "requiredChanges"),
    notes: requireStringArray(output.notes ?? [], "notes"),
    releaseDecision: {
      canProceed: requireBoolean(releaseDecision.canProceed, "releaseDecision.canProceed"),
      reason: requireNonEmptyString(releaseDecision.reason, "releaseDecision.reason")
    }
  };
}

function validateVerifierOutput(output) {
  return {
    ...output,
    status: requireEnum(output.status, VERIFIER_STATUSES, "status"),
    checks: validateCheckArray(output.checks ?? [], "checks"),
    notes: requireStringArray(output.notes ?? [], "notes"),
    failure: output.failure == null
      ? null
      : {
          category: requireEnum(requireObject(output.failure, "failure").category, FAILURE_CATEGORIES, "failure.category"),
          message: requireNonEmptyString(output.failure.message, "failure.message"),
          evidence: optionalString(output.failure.evidence, "failure.evidence")
        }
  };
}

export function parseStructuredAgentOutput(rawText, expectedRole) {
  const parsed = parseRawJsonEnvelope(rawText);
  const output = validateBaseEnvelope(parsed, expectedRole);

  switch (expectedRole) {
    case "planner":
      return validatePlannerOutput(output);
    case "executor":
      return validateExecutorOutput(output);
    case "reviewer":
      return validateReviewerOutput(output);
    case "verifier":
      return validateVerifierOutput(output);
    default:
      throw new Error(`Unsupported agent role: ${expectedRole}`);
  }
}

export function parsePlannerOutput(rawText) {
  return parseStructuredAgentOutput(rawText, "planner");
}

export function parseExecutorOutput(rawText) {
  return parseStructuredAgentOutput(rawText, "executor");
}

export function parseReviewerOutput(rawText) {
  return parseStructuredAgentOutput(rawText, "reviewer");
}

export function parseVerifierOutput(rawText) {
  return parseStructuredAgentOutput(rawText, "verifier");
}

