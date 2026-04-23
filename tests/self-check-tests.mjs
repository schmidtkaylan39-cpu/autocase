import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createInitialValidationArtifact,
  createValidationRerunGuidance,
  deriveEvidenceStrength,
  deriveEvidenceSummary,
  runSelfCheckSuite
} from "../src/lib/self-check.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function createFakeSpawn(outcomes) {
  /** @type {any} */
  const fakeSpawn = () => {
    const outcome = outcomes.shift();
    /** @type {any} */
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    queueMicrotask(() => {
      if (!outcome) {
        child.emit("error", new Error("No fake spawn outcome provided."));
        return;
      }

      if (typeof outcome.stdout === "string") {
        child.stdout.emit("data", Buffer.from(outcome.stdout, "utf8"));
      }

      if (typeof outcome.stderr === "string") {
        child.stderr.emit("data", Buffer.from(outcome.stderr, "utf8"));
      }

      if (typeof outcome.error === "string") {
        child.emit("error", new Error(outcome.error));
        return;
      }

      child.emit("close", outcome.code ?? 0, outcome.signal ?? null);
    });

    return child;
  };

  return fakeSpawn;
}

async function main() {
  await runTest("self-check suite retains command logs for executed and skipped commands", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-self-check-"));
    const reportsDirectory = path.join(repoRoot, "reports");
    const validationResultsPath = path.join(reportsDirectory, "validation-results.json");

    await mkdir(reportsDirectory, { recursive: true });
    await writeFile(path.join(reportsDirectory, "runtime-doctor.json"), "{}\n", "utf8");
    await writeFile(path.join(reportsDirectory, "runtime-doctor.md"), "# doctor\n", "utf8");
    await mkdir(path.join(reportsDirectory, "validation-evidence"), { recursive: true });
    await writeFile(path.join(reportsDirectory, "validation-evidence", "stale.log"), "stale\n", "utf8");

    const artifact = await runSelfCheckSuite({
      repoRoot,
      reportsDirectory,
      validationResultsPath,
      npmInvocation: {
        command: "fake-npm",
        prefixArgs: []
      },
      commandSpecs: [
        {
          id: "build",
          command: "npm run build",
          args: ["run", "build"],
          evidence: []
        },
        {
          id: "doctor",
          command: "npm run doctor",
          args: ["run", "doctor"],
          evidence: ["reports/runtime-doctor.json", "reports/runtime-doctor.md"]
        },
        {
          id: "test",
          command: "npm test",
          args: ["test"],
          evidence: []
        }
      ],
      spawnImpl: createFakeSpawn([
        {
          stdout: "build ok\n",
          code: 0
        },
        {
          stderr: "doctor failed\n",
          code: 1
        }
      ]),
      stdout: /** @type {any} */ ({
        write() {
          return true;
        }
      }),
      stderr: /** @type {any} */ ({
        write() {
          return true;
        }
      })
    });

    assert.equal(artifact.results.length, 3);
    assert.equal(artifact.profile, "repo");
    assert.equal(artifact.readyForHuman, false);
    assert.ok(
      artifact.blockedBy.some((reason) => reason.includes('Validation ran with the "repo" profile only'))
    );
    assert.deepEqual(artifact.rerunGuidance, createValidationRerunGuidance(repoRoot));
    assert.deepEqual(
      artifact.criticalGates.map((gate) => ({ id: gate.id, status: gate.status })),
      [
        { id: "build", status: "passed" },
        { id: "doctor", status: "failed" },
        { id: "test", status: "skipped" }
      ]
    );
    assert.equal(artifact.results[0].evidenceStrength, "artifact");
    assert.equal(artifact.results[0].evidenceSummary, "Includes a retained self-check command log.");
    assert.deepEqual(artifact.results[0].evidence, ["reports/validation-evidence/build.log"]);

    assert.equal(artifact.results[1].status, "failed");
    assert.equal(
      artifact.results[1].evidenceSummary,
      "Includes a retained self-check command log plus command-specific artifacts."
    );
    assert.deepEqual(artifact.results[1].evidence, [
      "reports/validation-evidence/doctor.log",
      "reports/runtime-doctor.json",
      "reports/runtime-doctor.md"
    ]);

    assert.equal(artifact.results[2].status, "skipped");
    assert.equal(
      artifact.results[2].evidenceSummary,
      "Includes a retained self-check skip log explaining why this command did not run."
    );
    assert.deepEqual(artifact.results[2].evidence, ["reports/validation-evidence/test.log"]);

    await stat(path.join(reportsDirectory, "validation-evidence", "build.log"));
    await stat(path.join(reportsDirectory, "validation-evidence", "doctor.log"));
    await stat(path.join(reportsDirectory, "validation-evidence", "test.log"));

    const buildLog = await readFile(path.join(reportsDirectory, "validation-evidence", "build.log"), "utf8");
    const doctorLog = await readFile(path.join(reportsDirectory, "validation-evidence", "doctor.log"), "utf8");
    const skippedLog = await readFile(path.join(reportsDirectory, "validation-evidence", "test.log"), "utf8");
    const writtenArtifact = JSON.parse(await readFile(validationResultsPath, "utf8"));

    assert.match(buildLog, /command: npm run build/);
    assert.match(buildLog, /status: passed/);
    assert.match(buildLog, /build ok/);
    assert.match(doctorLog, /doctor failed/);
    assert.match(skippedLog, /Skipped by self-check/);
    assert.equal(writtenArtifact.results[2].status, "skipped");
    assert.equal(writtenArtifact.profile, "repo");
    assert.equal(writtenArtifact.readyForHuman, false);
    assert.deepEqual(writtenArtifact.rerunGuidance, createValidationRerunGuidance(repoRoot));
    await assert.rejects(() => stat(path.join(reportsDirectory, "validation-evidence", "stale.log")));
  });

  await runTest("self-check fails closed when referenced evidence artifacts are missing", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-self-check-missing-evidence-"));
    const reportsDirectory = path.join(repoRoot, "reports");
    const validationResultsPath = path.join(reportsDirectory, "validation-results.json");

    await mkdir(reportsDirectory, { recursive: true });

    const artifact = await runSelfCheckSuite({
      repoRoot,
      reportsDirectory,
      validationResultsPath,
      npmInvocation: {
        command: "fake-npm",
        prefixArgs: []
      },
      commandSpecs: [
        {
          id: "doctor",
          command: "npm run doctor",
          args: ["run", "doctor"],
          evidence: ["reports/runtime-doctor.json"]
        },
        {
          id: "test",
          command: "npm test",
          args: ["test"],
          evidence: ["reports/test-output.log"]
        }
      ],
      spawnImpl: createFakeSpawn([
        {
          stdout: "doctor ok\n",
          code: 0
        }
      ]),
      stdout: /** @type {any} */ ({
        write() {
          return true;
        }
      }),
      stderr: /** @type {any} */ ({
        write() {
          return true;
        }
      })
    });

    assert.equal(artifact.results[0].status, "failed");
    assert.equal(artifact.readyForHuman, false);
    assert.match(
      artifact.results[0].error ?? "",
      /Missing referenced validation evidence: reports\/runtime-doctor\.json/
    );
    assert.deepEqual(artifact.results[0].evidence, ["reports/validation-evidence/doctor.log"]);
    assert.equal(artifact.results[1].status, "skipped");
    assert.deepEqual(artifact.results[1].evidence, ["reports/validation-evidence/test.log"]);

    const doctorLog = await readFile(path.join(reportsDirectory, "validation-evidence", "doctor.log"), "utf8");
    const skippedLog = await readFile(path.join(reportsDirectory, "validation-evidence", "test.log"), "utf8");
    const writtenArtifact = JSON.parse(await readFile(validationResultsPath, "utf8"));

    assert.match(doctorLog, /status: failed/);
    assert.match(doctorLog, /Missing referenced validation evidence: reports\/runtime-doctor\.json/);
    assert.match(skippedLog, /Skipped by self-check/);
    assert.deepEqual(writtenArtifact.results[0].evidence, ["reports/validation-evidence/doctor.log"]);
    assert.deepEqual(writtenArtifact.results[1].evidence, ["reports/validation-evidence/test.log"]);
    assert.equal(writtenArtifact.results[0].status, "failed");
    assert.equal(writtenArtifact.results[1].status, "skipped");
    assert.equal(writtenArtifact.readyForHuman, false);
  });

  await runTest("validation artifact helpers describe evidence clearly", async () => {
    const artifact = createInitialValidationArtifact("C:/workspace/demo");

    assert.equal(artifact.cwd, "C:/workspace/demo");
    assert.equal(artifact.profile, "repo");
    assert.equal(artifact.readyForHuman, false);
    assert.ok(
      artifact.blockedBy.some((reason) => reason.includes("selfcheck:release-ready"))
    );
    assert.deepEqual(artifact.rerunGuidance, createValidationRerunGuidance("C:/workspace/demo"));
    assert.deepEqual(artifact.results, []);
    assert.equal(deriveEvidenceStrength([]), "record-only");
    assert.equal(deriveEvidenceStrength(["reports/validation-evidence/test.log"]), "artifact");
    assert.equal(
      deriveEvidenceSummary(["reports/validation-evidence/test.log"], {
        includesCommandLog: true
      }),
      "Includes a retained self-check command log."
    );
    assert.equal(
      deriveEvidenceSummary(["reports/validation-evidence/test.log", "reports/runtime-doctor.json"], {
        commandSpecificArtifactCount: 1,
        includesCommandLog: true
      }),
      "Includes a retained self-check command log plus command-specific artifacts."
    );
    assert.equal(
      deriveEvidenceSummary(["reports/validation-evidence/test.log"], {
        skipped: true,
        includesCommandLog: true
      }),
      "Includes a retained self-check skip log explaining why this command did not run."
    );
  });

  await runTest("release-ready profile marks human readiness only after all critical gates pass", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-self-check-release-ready-"));
    const reportsDirectory = path.join(repoRoot, "reports");
    const validationResultsPath = path.join(reportsDirectory, "validation-results.json");

    await mkdir(reportsDirectory, { recursive: true });
    await writeFile(path.join(reportsDirectory, "runtime-doctor.json"), "{}\n", "utf8");
    await writeFile(path.join(reportsDirectory, "runtime-doctor.md"), "# doctor\n", "utf8");

    const artifact = await runSelfCheckSuite({
      repoRoot,
      reportsDirectory,
      validationResultsPath,
      profileName: "release-ready",
      npmInvocation: {
        command: "fake-npm",
        prefixArgs: []
      },
      commandSpecs: [
        {
          id: "doctor",
          command: "npm run doctor",
          args: ["run", "doctor"],
          category: "repo-health",
          evidence: ["reports/runtime-doctor.json", "reports/runtime-doctor.md"]
        },
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
        }
      ],
      spawnImpl: createFakeSpawn([
        { stdout: "doctor ok\n", code: 0 },
        { stdout: "panel ok\n", code: 0 },
        { stdout: "browser micro ok\n", code: 0 },
        { stdout: "browser ok\n", code: 0 }
      ]),
      stdout: /** @type {any} */ ({
        write() {
          return true;
        }
      }),
      stderr: /** @type {any} */ ({
        write() {
          return true;
        }
      })
    });

    assert.equal(artifact.profile, "release-ready");
    assert.equal(artifact.readyForHuman, true);
    assert.deepEqual(artifact.blockedBy, []);
    assert.deepEqual(
      artifact.criticalGates.map((gate) => ({ id: gate.id, status: gate.status })),
      [
        { id: "doctor", status: "passed" },
        { id: "acceptance-panel", status: "passed" },
        { id: "acceptance-panel-browser-micro", status: "passed" },
        { id: "acceptance-panel-browser-analyze", status: "passed" }
      ]
    );
  });

  console.log("Self-check tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
