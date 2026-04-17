import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDirectory, writeJson } from "../src/lib/fs-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const reportsDirectory = path.join(repoRoot, "reports");
const validationResultsPath = path.join(reportsDirectory, "validation-results.json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmInvocation = process.env.npm_execpath
  ? {
      command: process.execPath,
      prefixArgs: [process.env.npm_execpath]
    }
  : {
      command: npmCommand,
      prefixArgs: []
    };

const commandSpecs = [
  { command: "npm run validate:workflows", args: ["run", "validate:workflows"], evidence: [] },
  { command: "npm run build", args: ["run", "build"], evidence: [] },
  { command: "npm run pack:check", args: ["run", "pack:check"], evidence: [] },
  { command: "npm run lint", args: ["run", "lint"], evidence: [] },
  { command: "npm run typecheck", args: ["run", "typecheck"], evidence: [] },
  { command: "npm test", args: ["test"], evidence: [] },
  { command: "npm run test:integration", args: ["run", "test:integration"], evidence: [] },
  { command: "npm run test:e2e", args: ["run", "test:e2e"], evidence: [] },
  {
    command: "npm run doctor",
    args: ["run", "doctor"],
    evidence: ["reports/runtime-doctor.json", "reports/runtime-doctor.md"]
  }
];

function deriveEvidenceStrength(evidence) {
  return Array.isArray(evidence) && evidence.length > 0 ? "artifact" : "record-only";
}

function createInitialArtifact() {
  return {
    generatedAt: new Date().toISOString(),
    cwd: repoRoot,
    results: []
  };
}

async function writeArtifact(artifact) {
  await ensureDirectory(reportsDirectory);
  await writeJson(validationResultsPath, artifact);
}

async function runCommand(spec) {
  const startedAt = new Date();

  return new Promise((resolve) => {
    const child = spawn(npmInvocation.command, [...npmInvocation.prefixArgs, ...spec.args], {
      cwd: repoRoot,
      stdio: "inherit",
      shell: false
    });

    child.on("error", (error) => {
      const finishedAt = new Date();
      resolve({
        command: spec.command,
        status: "failed",
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        evidence: spec.evidence,
        evidenceStrength: deriveEvidenceStrength(spec.evidence),
        error: error instanceof Error ? error.message : String(error)
      });
    });

    child.on("exit", (code, signal) => {
      const finishedAt = new Date();
      resolve({
        command: spec.command,
        status: code === 0 ? "passed" : "failed",
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        evidence: spec.evidence,
        evidenceStrength: deriveEvidenceStrength(spec.evidence),
        exitCode: code,
        signal: signal ?? null
      });
    });
  });
}

async function main() {
  const artifact = createInitialArtifact();
  await writeArtifact(artifact);

  let failureSeen = false;

  for (const spec of commandSpecs) {
    if (failureSeen) {
      artifact.results.push({
        command: spec.command,
        status: "skipped",
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        evidence: spec.evidence,
        evidenceStrength: deriveEvidenceStrength(spec.evidence)
      });
      continue;
    }

    const result = await runCommand(spec);
    artifact.results.push(result);
    artifact.generatedAt = new Date().toISOString();
    await writeArtifact(artifact);

    if (result.status !== "passed") {
      failureSeen = true;
    }
  }

  await writeArtifact(artifact);

  const failed = artifact.results.find((result) => result.status === "failed");
  if (failed) {
    console.error(`Self-check failed at: ${failed.command}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Validation results written to ${validationResultsPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
