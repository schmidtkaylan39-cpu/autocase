import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeJson } from "./fs-utils.mjs";

const operatorPolicy = {
  humanUiVerifiedRequiredBeforeHandoff: true,
  readyForHumanProfile: "release-ready",
  releaseReadyProfileRequiredForReadyForHuman: true,
  minimumHumanUiSmokeCommand: "npm run acceptance:panel:browser:analyze"
};

function cloneCommandSpec(spec) {
  return {
    ...spec,
    evidence: Array.isArray(spec.evidence) ? [...spec.evidence] : []
  };
}

const repoHealthCommandSpecs = [
  {
    id: "validate-workflows",
    command: "npm run validate:workflows",
    args: ["run", "validate:workflows"],
    category: "repo-health",
    evidence: []
  },
  {
    id: "build",
    command: "npm run build",
    args: ["run", "build"],
    category: "repo-health",
    evidence: []
  },
  {
    id: "pack-check",
    command: "npm run pack:check",
    args: ["run", "pack:check"],
    category: "repo-health",
    evidence: []
  },
  {
    id: "lint",
    command: "npm run lint",
    args: ["run", "lint"],
    category: "repo-health",
    evidence: []
  },
  {
    id: "typecheck",
    command: "npm run typecheck",
    args: ["run", "typecheck"],
    category: "repo-health",
    evidence: []
  },
  {
    id: "test",
    command: "npm test",
    args: ["test"],
    category: "repo-health",
    evidence: []
  },
  {
    id: "test-integration",
    command: "npm run test:integration",
    args: ["run", "test:integration"],
    category: "repo-health",
    evidence: []
  },
  {
    id: "test-e2e",
    command: "npm run test:e2e",
    args: ["run", "test:e2e"],
    category: "repo-health",
    evidence: []
  },
  {
    id: "doctor",
    command: "npm run doctor",
    args: ["run", "doctor"],
    category: "repo-health",
    evidence: ["reports/runtime-doctor.json", "reports/runtime-doctor.md"]
  }
];

const releaseReadyOnlyCommandSpecs = [
  {
    id: "acceptance-panel",
    command: "npm run acceptance:panel",
    args: ["run", "acceptance:panel"],
    category: "human-ui",
    evidence: []
  },
  {
    id: "acceptance-panel-browser-micro",
    command: "npm run acceptance:panel:browser:micro",
    args: ["run", "acceptance:panel:browser:micro"],
    category: "human-ui",
    evidence: []
  },
  {
    id: "acceptance-panel-browser-analyze",
    command: "npm run acceptance:panel:browser:analyze",
    args: ["run", "acceptance:panel:browser:analyze"],
    category: "human-ui",
    evidence: []
  },
  {
    id: "acceptance-panel-browser-full",
    command: "npm run acceptance:panel:browser:full",
    args: ["run", "acceptance:panel:browser:full"],
    category: "human-ui",
    evidence: []
  }
];

export const defaultSelfCheckCommandSpecs = repoHealthCommandSpecs.map(cloneCommandSpec);
export const releaseReadySelfCheckCommandSpecs = [
  ...repoHealthCommandSpecs.map(cloneCommandSpec),
  ...releaseReadyOnlyCommandSpecs.map(cloneCommandSpec)
];

const selfCheckProfiles = {
  repo: {
    name: "repo",
    summary: "Repo-level validation only; human UI readiness still requires the release-ready gate.",
    commandSpecs: defaultSelfCheckCommandSpecs
  },
  "release-ready": {
    name: "release-ready",
    summary: "Repo-level validation plus panel/browser live smoke required before human handoff.",
    commandSpecs: releaseReadySelfCheckCommandSpecs
  }
};

export function resolveSelfCheckProfile(profileName = "repo", options = {}) {
  const normalizedProfileName = typeof profileName === "string" ? profileName.trim() : "";
  const baseProfile = selfCheckProfiles[normalizedProfileName];

  if (!baseProfile) {
    throw new Error(`Unsupported self-check profile: ${profileName}`);
  }

  const commandSpecs = Array.isArray(options.commandSpecs)
    ? options.commandSpecs.map(cloneCommandSpec)
    : baseProfile.commandSpecs.map(cloneCommandSpec);

  return {
    name: baseProfile.name,
    summary: baseProfile.summary,
    commandSpecs
  };
}

export function deriveEvidenceStrength(evidence) {
  return Array.isArray(evidence) && evidence.length > 0 ? "artifact" : "record-only";
}

export function deriveEvidenceSummary(evidence, options = {}) {
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const evidenceCount = evidenceList.length;
  const commandSpecificArtifactCount = options.commandSpecificArtifactCount ?? Math.max(0, evidenceCount - 1);
  const skipped = options.skipped === true;
  const includesCommandLog = options.includesCommandLog === true;

  if (evidenceCount === 0) {
    return skipped
      ? "No retained artifacts were generated because this command was skipped before execution."
      : "No retained artifacts were captured; use status and timing metadata only.";
  }

  if (skipped) {
    return "Includes a retained self-check skip log explaining why this command did not run.";
  }

  if (!includesCommandLog) {
    return "Includes retained artifacts referenced in evidence.";
  }

  if (commandSpecificArtifactCount > 0) {
    return "Includes a retained self-check command log plus command-specific artifacts.";
  }

  return "Includes a retained self-check command log.";
}

export function createValidationRerunGuidance(workingDirectory) {
  return {
    requiresDependencyInstall: true,
    installCommand: "npm ci",
    workingDirectory,
    note: "Install devDependencies before rerunning repo-level validation commands."
  };
}

function buildCriticalGates(profile, results) {
  const resultByCommand = new Map(
    Array.isArray(results) ? results.map((result) => [result.command, result]) : []
  );

  return profile.commandSpecs.map((spec) => ({
    id: spec.id,
    command: spec.command,
    category: spec.category ?? "repo-health",
    status: resultByCommand.get(spec.command)?.status ?? "pending"
  }));
}

function deriveBlockedBy(profile, criticalGates) {
  const failed = criticalGates
    .filter((gate) => gate.status === "failed")
    .map((gate) => `Critical gate failed: ${gate.command}`);
  const skipped = criticalGates
    .filter((gate) => gate.status === "skipped")
    .map((gate) => `Critical gate skipped: ${gate.command}`);
  const pending = criticalGates
    .filter((gate) => gate.status !== "passed" && gate.status !== "failed" && gate.status !== "skipped")
    .map((gate) => `Critical gate pending: ${gate.command}`);

  const blockedBy = [...failed, ...skipped, ...pending];

  if (profile.name !== "release-ready") {
    blockedBy.push(
      'Validation ran with the "repo" profile only. Run `npm run selfcheck:release-ready` before human handoff or "可實戰" claims.'
    );
  }

  return blockedBy;
}

export function refreshValidationArtifact(artifact, profile) {
  const criticalGates = buildCriticalGates(profile, artifact.results);
  const blockedBy = deriveBlockedBy(profile, criticalGates);

  artifact.profile = profile.name;
  artifact.profileSummary = profile.summary;
  artifact.operatorPolicy = { ...operatorPolicy };
  artifact.criticalGates = criticalGates;
  artifact.readyForHuman = profile.name === "release-ready" && blockedBy.length === 0;
  artifact.blockedBy = blockedBy;

  return artifact;
}

export function createInitialValidationArtifact(repoRoot, profile = resolveSelfCheckProfile("repo")) {
  const artifact = {
    generatedAt: new Date().toISOString(),
    cwd: repoRoot,
    rerunGuidance: createValidationRerunGuidance(repoRoot),
    results: []
  };

  return refreshValidationArtifact(artifact, profile);
}

function normalizeReportedPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function assertRelativeEvidencePath(referencePath, label) {
  if (typeof referencePath !== "string" || referencePath.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  if (path.isAbsolute(referencePath) || path.win32.isAbsolute(referencePath)) {
    throw new Error(`${label} must be repo-relative: ${referencePath}`);
  }

  const normalizedPath = normalizeReportedPath(path.normalize(referencePath));

  if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
    throw new Error(`${label} must stay inside the repo: ${referencePath}`);
  }
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function getValidationEvidencePaths(spec) {
  const logPath = normalizeReportedPath(path.join("reports", "validation-evidence", `${spec.id}.log`));
  const commandSpecificEvidence = Array.isArray(spec.evidence)
    ? spec.evidence.map((evidencePath, index) => {
        assertRelativeEvidencePath(evidencePath, `${spec.command} evidence[${index}]`);
        return normalizeReportedPath(path.normalize(evidencePath));
      })
    : [];

  return {
    logPath,
    evidence: [logPath, ...commandSpecificEvidence],
    commandSpecificEvidence,
    commandSpecificArtifactCount: commandSpecificEvidence.length
  };
}

function toUtf8Text(chunk) {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
}

async function writeValidationCommandLog(filePath, payload) {
  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, payload, "utf8");
}

async function resolveCommandSpecificEvidence(repoRoot, evidencePaths) {
  const existingEvidence = [];
  const missingEvidence = [];

  for (const evidencePath of evidencePaths) {
    if (await fileExists(path.join(repoRoot, evidencePath))) {
      existingEvidence.push(evidencePath);
    } else {
      missingEvidence.push(evidencePath);
    }
  }

  return {
    existingEvidence,
    missingEvidence
  };
}

export async function writeValidationArtifact(artifact, validationResultsPath) {
  await ensureDirectory(path.dirname(validationResultsPath));
  await writeJson(validationResultsPath, artifact);
}

function formatCommandLog({
  spec,
  repoRoot,
  status,
  startedAt,
  finishedAt,
  durationMs,
  exitCode = null,
  signal = null,
  skipped = false,
  error = null,
  body = ""
}) {
  return [
    `command: ${spec.command}`,
    `cwd: ${repoRoot}`,
    `status: ${status}`,
    `startedAt: ${startedAt}`,
    `finishedAt: ${finishedAt}`,
    `durationMs: ${durationMs}`,
    `exitCode: ${exitCode === null ? "n/a" : exitCode}`,
    `signal: ${signal ?? "n/a"}`,
    `skipped: ${skipped ? "true" : "false"}`,
    ...(error ? [`error: ${error}`] : []),
    "",
    body.trimEnd()
  ]
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ""))
    .join("\n")
    .concat("\n");
}

export async function runSelfCheckCommand({
  spec,
  repoRoot,
  validationEvidenceDirectory,
  npmInvocation,
  spawnImpl = spawn,
  stdout = process.stdout,
  stderr = process.stderr
}) {
  const startedAt = new Date();
  const { logPath, commandSpecificEvidence } = getValidationEvidencePaths(spec);
  const absoluteLogPath = path.join(repoRoot, logPath);
  const outputChunks = [];

  return new Promise((resolve) => {
    let settled = false;

    const settle = async (resultPayload) => {
      if (settled) {
        return;
      }

      settled = true;
      const {
        existingEvidence: existingCommandSpecificEvidence,
        missingEvidence: missingCommandSpecificEvidence
      } = await resolveCommandSpecificEvidence(repoRoot, commandSpecificEvidence);
      const combinedError = [
        resultPayload.error,
        missingCommandSpecificEvidence.length > 0
          ? `Missing referenced validation evidence: ${missingCommandSpecificEvidence.join(", ")}`
          : null
      ]
        .filter(Boolean)
        .join("; ");
      const finalStatus =
        missingCommandSpecificEvidence.length > 0 ? "failed" : resultPayload.status;
      const finalBody = [
        outputChunks.join(""),
        missingCommandSpecificEvidence.length > 0
          ? `Missing referenced validation evidence: ${missingCommandSpecificEvidence.join(", ")}\n`
          : ""
      ].join("");
      const evidence = [logPath, ...existingCommandSpecificEvidence];

      await writeValidationCommandLog(
        absoluteLogPath,
        formatCommandLog({
          spec,
          repoRoot,
          ...resultPayload,
          status: finalStatus,
          error: combinedError || null,
          body: finalBody
        })
      );
      resolve({
        command: spec.command,
        status: finalStatus,
        startedAt: resultPayload.startedAt,
        finishedAt: resultPayload.finishedAt,
        durationMs: resultPayload.durationMs,
        evidence,
        evidenceStrength: deriveEvidenceStrength(evidence),
        evidenceSummary: deriveEvidenceSummary(evidence, {
          commandSpecificArtifactCount: existingCommandSpecificEvidence.length,
          includesCommandLog: true
        }),
        ...(resultPayload.exitCode !== undefined ? { exitCode: resultPayload.exitCode } : {}),
        ...(resultPayload.signal !== undefined ? { signal: resultPayload.signal } : {}),
        ...(combinedError ? { error: combinedError } : {})
      });
    };

    ensureDirectory(validationEvidenceDirectory)
      .then(() => {
        const child = spawnImpl(npmInvocation.command, [...npmInvocation.prefixArgs, ...spec.args], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false
        });

        child.stdout?.on("data", (chunk) => {
          outputChunks.push(toUtf8Text(chunk));
          stdout.write(chunk);
        });

        child.stderr?.on("data", (chunk) => {
          outputChunks.push(toUtf8Text(chunk));
          stderr.write(chunk);
        });

        child.once("error", async (error) => {
          const finishedAt = new Date();
          outputChunks.push(`${error instanceof Error ? error.message : String(error)}\n`);
          await settle({
            status: "failed",
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            error: error instanceof Error ? error.message : String(error)
          });
        });

        child.once("close", async (code, signal) => {
          const finishedAt = new Date();
          await settle({
            status: code === 0 ? "passed" : "failed",
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            exitCode: code,
            signal: signal ?? null
          });
        });
      })
      .catch(async (error) => {
        const finishedAt = new Date();
        outputChunks.push(`${error instanceof Error ? error.message : String(error)}\n`);
        await settle({
          status: "failed",
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: error instanceof Error ? error.message : String(error)
        });
      });
  });
}

export async function createSkippedSelfCheckResult({
  spec,
  repoRoot,
  validationEvidenceDirectory,
  reason
}) {
  const { logPath } = getValidationEvidencePaths(spec);
  const absoluteLogPath = path.join(repoRoot, logPath);
  const startedAt = null;
  const finishedAt = null;
  const evidence = [logPath];

  await ensureDirectory(validationEvidenceDirectory);
  await writeValidationCommandLog(
    absoluteLogPath,
    formatCommandLog({
      spec,
      repoRoot,
      status: "skipped",
      startedAt: "n/a",
      finishedAt: "n/a",
      durationMs: "n/a",
      skipped: true,
      body: `Skipped by self-check.\nReason: ${reason}\n`
    })
  );

  return {
    command: spec.command,
    status: "skipped",
    startedAt,
    finishedAt,
    durationMs: null,
    evidence,
    evidenceStrength: deriveEvidenceStrength(evidence),
    evidenceSummary: deriveEvidenceSummary(evidence, {
      skipped: true,
      includesCommandLog: true
    })
  };
}

export async function runSelfCheckSuite({
  repoRoot,
  reportsDirectory,
  validationResultsPath,
  npmInvocation,
  profileName = "repo",
  commandSpecs = null,
  spawnImpl = spawn,
  stdout = process.stdout,
  stderr = process.stderr
}) {
  const profile = resolveSelfCheckProfile(profileName, { commandSpecs });
  const validationEvidenceDirectory = path.join(reportsDirectory, "validation-evidence");
  const artifact = createInitialValidationArtifact(repoRoot, profile);
  await removePreviousValidationEvidence(validationEvidenceDirectory);
  await writeValidationArtifact(artifact, validationResultsPath);

  let failureSeen = false;

  for (const spec of profile.commandSpecs) {
    const result = failureSeen
      ? await createSkippedSelfCheckResult({
          spec,
          repoRoot,
          validationEvidenceDirectory,
          reason: "A previous self-check command failed."
        })
      : await runSelfCheckCommand({
          spec,
          repoRoot,
          validationEvidenceDirectory,
          npmInvocation,
          spawnImpl,
          stdout,
          stderr
        });

    artifact.results.push(result);
    artifact.generatedAt = new Date().toISOString();
    refreshValidationArtifact(artifact, profile);
    await writeValidationArtifact(artifact, validationResultsPath);

    if (result.status === "failed") {
      failureSeen = true;
    }
  }

  return artifact;
}

async function removePreviousValidationEvidence(validationEvidenceDirectory) {
  await rm(validationEvidenceDirectory, { recursive: true, force: true });
}
