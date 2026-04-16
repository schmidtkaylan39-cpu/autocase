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

  return artifact;
}
