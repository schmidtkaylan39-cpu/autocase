import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeJson } from "./fs-utils.mjs";

export const defaultSelfCheckCommandSpecs = [
  {
    id: "validate-workflows",
    command: "npm run validate:workflows",
    args: ["run", "validate:workflows"],
    evidence: []
  },
  {
    id: "build",
    command: "npm run build",
    args: ["run", "build"],
    evidence: []
  },
  {
    id: "pack-check",
    command: "npm run pack:check",
    args: ["run", "pack:check"],
    evidence: []
  },
  {
    id: "lint",
    command: "npm run lint",
    args: ["run", "lint"],
    evidence: []
  },
  {
    id: "typecheck",
    command: "npm run typecheck",
    args: ["run", "typecheck"],
    evidence: []
  },
  {
    id: "test",
    command: "npm test",
    args: ["test"],
    evidence: []
  },
  {
    id: "test-integration",
    command: "npm run test:integration",
    args: ["run", "test:integration"],
    evidence: []
  },
  {
    id: "test-e2e",
    command: "npm run test:e2e",
    args: ["run", "test:e2e"],
    evidence: []
  },
  {
    id: "doctor",
    command: "npm run doctor",
    args: ["run", "doctor"],
    evidence: ["reports/runtime-doctor.json", "reports/runtime-doctor.md"]
  }
];

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

export function createInitialValidationArtifact(repoRoot) {
  return {
    generatedAt: new Date().toISOString(),
    cwd: repoRoot,
    rerunGuidance: createValidationRerunGuidance(repoRoot),
    results: []
  };
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
  commandSpecs = defaultSelfCheckCommandSpecs,
  spawnImpl = spawn,
  stdout = process.stdout,
  stderr = process.stderr
}) {
  const validationEvidenceDirectory = path.join(reportsDirectory, "validation-evidence");
  const artifact = createInitialValidationArtifact(repoRoot);
  await removePreviousValidationEvidence(validationEvidenceDirectory);
  await writeValidationArtifact(artifact, validationResultsPath);

  let failureSeen = false;

  for (const spec of commandSpecs) {
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
