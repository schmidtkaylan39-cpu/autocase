import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import {
  createClarificationArtifactPaths,
  createRunStateIntakeSnapshot,
  validateIntakeSpec
} from "./intake-schema.mjs";
import { renderIntakeSummary } from "./intake-summary.mjs";

function isBlockingCriterion(item) {
  return item?.status === "missing";
}

function isBlockingRequirement(item) {
  return item?.status === "missing" || item?.status === "needs_clarification";
}

function safePathLabel(filePath) {
  return String(filePath).replace(/\\/g, "/").split(path.sep).join("/");
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function loadIntakeArtifacts(workspaceRoot, config = null) {
  const artifactPaths = createClarificationArtifactPaths(workspaceRoot, config);

  if (!(await fileExists(artifactPaths.intakeSpecPath))) {
    return {
      exists: false,
      artifactPaths,
      spec: null
    };
  }

  const spec = await readJson(artifactPaths.intakeSpecPath);
  const validation = validateIntakeSpec(spec);

  if (!validation.valid) {
    throw new Error(
      `Clarification artifact is invalid at ${artifactPaths.intakeSpecPath}: ${validation.errors.join(" ")}`
    );
  }

  return {
    exists: true,
    artifactPaths,
    spec
  };
}

export async function writeIntakeArtifacts(workspaceRoot, spec, config = null) {
  const artifactPaths = createClarificationArtifactPaths(workspaceRoot, config);
  const validation = validateIntakeSpec(spec);

  if (!validation.valid) {
    throw new Error(`Cannot write intake artifacts because the spec is invalid: ${validation.errors.join(" ")}`);
  }

  await ensureDirectory(artifactPaths.clarificationDirectory);
  await writeJson(artifactPaths.intakeSpecPath, spec);
  await writeFile(artifactPaths.intakeSummaryPath, `${renderIntakeSummary(spec)}\n`, "utf8");

  return artifactPaths;
}

export function collectIntakeBlockingReasons(spec) {
  const reasons = [];

  if (spec.clarificationStatus === "clarification_abandoned") {
    reasons.push("The clarification flow was abandoned and must be revised before planning can continue.");
  }

  if (spec.clarificationStatus === "clarification_blocked") {
    reasons.push("A previous confirmation attempt was blocked. Revise the intake or answer the missing questions first.");
  }

  if (!spec.confirmedByUser || spec.clarificationStatus !== "confirmed") {
    reasons.push("The current intake has not been confirmed by the user.");
  }

  const missingSuccessCriteria = Array.isArray(spec.successCriteria)
    ? spec.successCriteria.filter((item) => isBlockingCriterion(item))
    : [];

  if (missingSuccessCriteria.length > 0 || (Array.isArray(spec.successCriteria) && spec.successCriteria.length === 0)) {
    reasons.push("Success criteria are still undefined.");
  }

  const missingInputs = Array.isArray(spec.requiredInputs)
    ? spec.requiredInputs.filter((item) => isBlockingRequirement(item))
    : [];

  if (missingInputs.length > 0) {
    reasons.push(
      `Required inputs are still missing or unclear: ${missingInputs.map((item) => item.name).join(", ")}.`
    );
  }

  const missingAccess = Array.isArray(spec.requiredAccountsAndPermissions)
    ? spec.requiredAccountsAndPermissions.filter((item) => isBlockingRequirement(item))
    : [];

  if (missingAccess.length > 0) {
    reasons.push(
      `Required accounts or permissions are still missing or unclear: ${missingAccess.map((item) => item.system).join(", ")}.`
    );
  }

  const blockingQuestions = Array.isArray(spec.openQuestions)
    ? spec.openQuestions.filter((item) => item.blocking)
    : [];

  if (blockingQuestions.length > 0) {
    reasons.push(
      `Blocking clarification questions remain open: ${blockingQuestions.map((item) => item.question).join(" | ")}`
    );
  }

  return reasons;
}

export function assessIntakePlanningReadiness(spec) {
  const reasons = collectIntakeBlockingReasons(spec);

  return {
    allowed: reasons.length === 0,
    reasons
  };
}

export async function ensureIntakePlanningReady(workspaceRoot, config = null, surfaceLabel = "planning") {
  const intake = await loadIntakeArtifacts(workspaceRoot, config);

  if (!intake.exists || !intake.spec) {
    return null;
  }

  const assessment = assessIntakePlanningReadiness(intake.spec);

  if (assessment.allowed) {
    return {
      ...intake,
      assessment
    };
  }

  throw new Error(
    [
      `Cannot continue into ${surfaceLabel} because the clarification gate is not satisfied.`,
      `- clarificationStatus: ${intake.spec.clarificationStatus}`,
      `- confirmedByUser: ${intake.spec.confirmedByUser ? "yes" : "no"}`,
      ...assessment.reasons.map((reason) => `- ${reason}`),
      `- recommendedNextStep: ${intake.spec.recommendedNextStep}`,
      `- intakeSpecPath: ${safePathLabel(intake.artifactPaths.intakeSpecPath)}`,
      `- intakeSummaryPath: ${safePathLabel(intake.artifactPaths.intakeSummaryPath)}`
    ].join("\n")
  );
}

export async function ensureRunStateIntakePlanningReady(
  runState,
  workspaceRoot,
  config = null,
  surfaceLabel = "planning"
) {
  const relativeSpecPath = runState?.intake?.artifactPaths?.intakeSpecPath;

  if (typeof relativeSpecPath === "string" && relativeSpecPath.trim().length > 0) {
    const intakeSpecPath = path.resolve(workspaceRoot, relativeSpecPath);
    const intakeSummaryPath = path.resolve(
      workspaceRoot,
      runState?.intake?.artifactPaths?.intakeSummaryPath ?? ""
    );

    if (await fileExists(intakeSpecPath)) {
      const spec = await readJson(intakeSpecPath);
      const validation = validateIntakeSpec(spec);

      if (!validation.valid) {
        throw new Error(
          `Clarification artifact is invalid at ${intakeSpecPath}: ${validation.errors.join(" ")}`
        );
      }

      const assessment = assessIntakePlanningReadiness(spec);

      if (!assessment.allowed) {
        throw new Error(
          [
            `Cannot continue into ${surfaceLabel} because the clarification gate is not satisfied.`,
            `- clarificationStatus: ${spec.clarificationStatus}`,
            `- confirmedByUser: ${spec.confirmedByUser ? "yes" : "no"}`,
            ...assessment.reasons.map((reason) => `- ${reason}`),
            `- recommendedNextStep: ${spec.recommendedNextStep}`,
            `- intakeSpecPath: ${safePathLabel(intakeSpecPath)}`,
            `- intakeSummaryPath: ${safePathLabel(intakeSummaryPath)}`
          ].join("\n")
        );
      }

      return {
        exists: true,
        artifactPaths: {
          intakeSpecPath,
          intakeSummaryPath
        },
        spec,
        assessment
      };
    }
  }

  return ensureIntakePlanningReady(workspaceRoot, config, surfaceLabel);
}

export function createConfirmedIntakeSpec(spec, now = new Date()) {
  const nextSpec = {
    ...spec,
    successCriteria: Array.isArray(spec.successCriteria)
      ? spec.successCriteria.map((item) =>
          item.status === "needs_confirmation"
            ? {
                ...item,
                status: "defined"
              }
            : item
        )
      : [],
    confirmedByUser: true,
    clarificationStatus: "confirmed",
    recommendedNextStep: "planning-ready",
    lastUpdatedAt: now.toISOString()
  };
  const assessment = assessIntakePlanningReadiness(nextSpec);

  if (!assessment.allowed) {
    throw new Error(assessment.reasons.join(" "));
  }

  return nextSpec;
}

export function createBlockedConfirmationSpec(spec, now = new Date()) {
  return {
    ...spec,
    confirmedByUser: false,
    clarificationStatus: "clarification_blocked",
    recommendedNextStep: "Revise the intake spec, answer the blocking questions, and try confirmation again.",
    lastUpdatedAt: now.toISOString()
  };
}

export function createRunStateIntakeContext(spec, artifactPaths, workspaceRoot) {
  return createRunStateIntakeSnapshot(spec, artifactPaths, workspaceRoot);
}
