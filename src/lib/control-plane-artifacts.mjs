import path from "node:path";

import { readJson } from "./fs-utils.mjs";

const runTaskStatuses = new Set([
  "ready",
  "in_progress",
  "completed",
  "failed",
  "blocked",
  "pending",
  "waiting_retry"
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @typedef {Error & {
 *   code?: string,
 *   artifactType?: string,
 *   artifactPath?: string,
 *   reasonCode?: string
 * }} ArtifactValidationErrorLike
 */

function createArtifactValidationError(artifactType, filePath, reasonCode, detail, cause = undefined) {
  const resolvedPath = path.resolve(filePath);
  const error = /** @type {ArtifactValidationErrorLike} */ (
    cause
      ? new Error(`${artifactType} artifact is invalid at ${resolvedPath}: ${detail}`, { cause })
      : new Error(`${artifactType} artifact is invalid at ${resolvedPath}: ${detail}`)
  );

  error.name = "ArtifactValidationError";
  error.code = "AI_FACTORY_ARTIFACT_INVALID";
  error.artifactType = artifactType;
  error.artifactPath = resolvedPath;
  error.reasonCode = reasonCode;
  return error;
}

function throwSchemaError(artifactType, filePath, detail) {
  throw createArtifactValidationError(artifactType, filePath, "schema_invalid", detail);
}

function assertCondition(condition, artifactType, filePath, detail) {
  if (!condition) {
    throwSchemaError(artifactType, filePath, detail);
  }
}

function assertPlainObject(value, label, artifactType, filePath) {
  assertCondition(isPlainObject(value), artifactType, filePath, `${label} must be an object.`);
}

function assertNonEmptyString(value, label, artifactType, filePath) {
  assertCondition(isNonEmptyString(value), artifactType, filePath, `${label} must be a non-empty string.`);
}

function assertStringArray(value, label, artifactType, filePath) {
  assertCondition(Array.isArray(value), artifactType, filePath, `${label} must be an array.`);
  assertCondition(
    value.every((item) => typeof item === "string"),
    artifactType,
    filePath,
    `${label} must contain only strings.`
  );
}

function assertOptionalString(value, label, artifactType, filePath, { allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    return;
  }

  if (allowEmpty) {
    assertCondition(typeof value === "string", artifactType, filePath, `${label} must be a string when provided.`);
    return;
  }

  assertNonEmptyString(value, label, artifactType, filePath);
}

async function readValidatedArtifact(filePath, artifactType, validate) {
  try {
    const artifact = await readJson(filePath);
    validate(artifact, filePath);
    return artifact;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "AI_FACTORY_ARTIFACT_INVALID") {
      throw error;
    }

    const detail =
      error instanceof SyntaxError
        ? `malformed JSON or partial write detected (${error.message}).`
        : `could not be read as JSON (${error instanceof Error ? error.message : String(error)}).`;
    throw createArtifactValidationError(artifactType, filePath, "invalid_json", detail, error);
  }
}

export function validateRunStateArtifact(runState, filePath) {
  const artifactType = "run-state";
  assertPlainObject(runState, "run-state", artifactType, filePath);
  assertNonEmptyString(runState.runId, "run-state.runId", artifactType, filePath);
  assertStringArray(runState.stopConditions, "run-state.stopConditions", artifactType, filePath);
  assertStringArray(runState.definitionOfDone, "run-state.definitionOfDone", artifactType, filePath);
  assertStringArray(runState.mandatoryGates, "run-state.mandatoryGates", artifactType, filePath);
  assertPlainObject(runState.roles, "run-state.roles", artifactType, filePath);
  assertCondition(Array.isArray(runState.nextActions), artifactType, filePath, "run-state.nextActions must be an array.");
  assertCondition(Array.isArray(runState.taskLedger), artifactType, filePath, "run-state.taskLedger must be an array.");
  assertCondition(
    runState.taskLedger.length > 0,
    artifactType,
    filePath,
    "run-state.taskLedger must contain at least one task."
  );

  runState.taskLedger.forEach((task, index) => {
    const taskLabel = `run-state.taskLedger[${index}]`;
    assertPlainObject(task, taskLabel, artifactType, filePath);
    assertNonEmptyString(task.id, `${taskLabel}.id`, artifactType, filePath);
    assertNonEmptyString(task.role, `${taskLabel}.role`, artifactType, filePath);
    assertNonEmptyString(task.title, `${taskLabel}.title`, artifactType, filePath);
    assertNonEmptyString(task.description, `${taskLabel}.description`, artifactType, filePath);
    assertStringArray(task.dependsOn, `${taskLabel}.dependsOn`, artifactType, filePath);
    assertStringArray(task.acceptanceCriteria, `${taskLabel}.acceptanceCriteria`, artifactType, filePath);
    assertCondition(
      runTaskStatuses.has(task.status),
      artifactType,
      filePath,
      `${taskLabel}.status must be one of: ${[...runTaskStatuses].join(", ")}.`
    );
    assertOptionalString(task.activeHandoffId, `${taskLabel}.activeHandoffId`, artifactType, filePath);
    assertOptionalString(task.activeResultPath, `${taskLabel}.activeResultPath`, artifactType, filePath);
    assertOptionalString(task.activeHandoffOutputDir, `${taskLabel}.activeHandoffOutputDir`, artifactType, filePath);
  });

  return runState;
}

export function validateHandoffIndexArtifact(handoffIndex, filePath) {
  const artifactType = "handoff index";
  assertPlainObject(handoffIndex, "handoff index", artifactType, filePath);
  assertCondition(
    Array.isArray(handoffIndex.descriptors),
    artifactType,
    filePath,
    "handoff index.descriptors must be an array."
  );

  if (handoffIndex.runId !== undefined && handoffIndex.runId !== null) {
    assertNonEmptyString(handoffIndex.runId, "handoff index.runId", artifactType, filePath);
  }

  assertOptionalString(handoffIndex.runDirectory, "handoff index.runDirectory", artifactType, filePath);
  assertOptionalString(handoffIndex.runStatePath, "handoff index.runStatePath", artifactType, filePath);

  handoffIndex.descriptors.forEach((descriptor, index) => {
    const descriptorLabel = `handoff index.descriptors[${index}]`;
    assertPlainObject(descriptor, descriptorLabel, artifactType, filePath);
    assertNonEmptyString(descriptor.taskId, `${descriptorLabel}.taskId`, artifactType, filePath);
    assertNonEmptyString(descriptor.handoffId, `${descriptorLabel}.handoffId`, artifactType, filePath);
    assertNonEmptyString(descriptor.launcherPath, `${descriptorLabel}.launcherPath`, artifactType, filePath);
    assertNonEmptyString(descriptor.resultPath, `${descriptorLabel}.resultPath`, artifactType, filePath);
    assertPlainObject(descriptor.runtime, `${descriptorLabel}.runtime`, artifactType, filePath);
    assertNonEmptyString(descriptor.runtime.id, `${descriptorLabel}.runtime.id`, artifactType, filePath);

    if (descriptor.runId !== undefined && descriptor.runId !== null) {
      assertNonEmptyString(descriptor.runId, `${descriptorLabel}.runId`, artifactType, filePath);
    }
  });

  assertCondition(
    isNonEmptyString(handoffIndex.runId) ||
      handoffIndex.descriptors.every((descriptor) => isNonEmptyString(descriptor?.runId)),
    artifactType,
    filePath,
    "handoff index.runId is required unless every descriptor carries its own runId."
  );

  return handoffIndex;
}

export function validateDispatchResultsArtifact(dispatchResults, filePath) {
  const artifactType = "dispatch-results";
  assertPlainObject(dispatchResults, "dispatch-results", artifactType, filePath);
  assertPlainObject(dispatchResults.summary, "dispatch-results.summary", artifactType, filePath);
  assertCondition(
    Array.isArray(dispatchResults.results),
    artifactType,
    filePath,
    "dispatch-results.results must be an array."
  );

  dispatchResults.results.forEach((result, index) => {
    const resultLabel = `dispatch-results.results[${index}]`;
    assertPlainObject(result, resultLabel, artifactType, filePath);
    assertNonEmptyString(result.taskId, `${resultLabel}.taskId`, artifactType, filePath);
    assertNonEmptyString(result.runtime, `${resultLabel}.runtime`, artifactType, filePath);
    assertNonEmptyString(result.status, `${resultLabel}.status`, artifactType, filePath);
    assertOptionalString(result.handoffId, `${resultLabel}.handoffId`, artifactType, filePath);
    assertOptionalString(result.launcherPath, `${resultLabel}.launcherPath`, artifactType, filePath);
    assertOptionalString(result.resultPath, `${resultLabel}.resultPath`, artifactType, filePath);
    assertOptionalString(result.stdout, `${resultLabel}.stdout`, artifactType, filePath, { allowEmpty: true });
    assertOptionalString(result.stderr, `${resultLabel}.stderr`, artifactType, filePath, { allowEmpty: true });
    assertOptionalString(result.note, `${resultLabel}.note`, artifactType, filePath, { allowEmpty: true });
    assertOptionalString(result.error, `${resultLabel}.error`, artifactType, filePath, { allowEmpty: true });
  });

  return dispatchResults;
}

export async function readRunStateArtifact(filePath) {
  return readValidatedArtifact(filePath, "run-state", validateRunStateArtifact);
}

export async function readHandoffIndexArtifact(filePath) {
  return readValidatedArtifact(filePath, "handoff index", validateHandoffIndexArtifact);
}

export async function readDispatchResultsArtifact(filePath) {
  return readValidatedArtifact(filePath, "dispatch-results", validateDispatchResultsArtifact);
}
