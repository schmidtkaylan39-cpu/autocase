import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProject, updateRunTask } from "../src/lib/commands.mjs";
import { readJson, writeJson } from "../src/lib/fs-utils.mjs";
import { refreshRunState } from "../src/lib/run-state.mjs";
import { runAutonomousLoop } from "../src/lib/autonomous-run.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validSpecPath = path.join(projectRoot, "examples", "project-spec.valid.json");

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  await runTest("autonomous loop reopens the feature chain when a review task is blocked", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-recover-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-recover-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");

    await writeJson(doctorReportPath, { checks: [] });
    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planning completed");
    await updateRunTask(runResult.statePath, "implement-spec-intake", "completed", "implementation completed");
    await updateRunTask(runResult.statePath, "review-spec-intake", "blocked", "review requested another round");

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          throw new Error("tickProjectRun should not be reached before autonomous recovery");
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not be reached before autonomous recovery");
        }
      }
    });

    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));

    assert.equal(result.summary.rounds[0]?.recovery?.type, "feature_rework");
    assert.equal(runState.taskLedger.find((task) => task.id === "implement-spec-intake")?.status, "ready");
    assert.equal(runState.taskLedger.find((task) => task.id === "review-spec-intake")?.status, "pending");
    assert.equal(runState.taskLedger.find((task) => task.id === "verify-spec-intake")?.status, "pending");
  });

  await runTest("autonomous loop records dispatch progress and reaches completion", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-complete-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-complete-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let tickCalls = 0;
    let dispatchCalls = 0;

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-complete-run",
      readyTaskCount: 1,
      descriptors: []
    });

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 2,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          tickCalls += 1;
          return {
            handoffIndexPath,
            readyTaskCount: 1
          };
        },
        dispatchHandoffs: async () => {
          dispatchCalls += 1;
          const runState = refreshRunState(await readJson(runResult.statePath));
          const completedRunState = refreshRunState({
            ...runState,
            taskLedger: runState.taskLedger.map((task) => ({
              ...task,
              status: "completed"
            }))
          });

          await writeJson(runResult.statePath, completedRunState);

          return {
            summary: {
              executed: 1,
              completed: 1,
              continued: 0,
              incomplete: 0,
              failed: 0,
              skipped: 0
            }
          };
        }
      }
    });

    assert.equal(tickCalls, 1);
    assert.equal(dispatchCalls, 1);
    assert.equal(result.summary.finalStatus, "completed");
    assert.equal(result.summary.rounds[0]?.dispatchSummary?.completed, 1);
    assert.equal(result.summary.stopReason, "run completed");
  });

  await runTest("autonomous loop keeps the freshly generated doctor report when an override path is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-doctor-path-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-doctor-path-run");
    const generatedDoctorPath = path.join(tempDir, "reports", "runtime-doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let receivedDoctorReportPath = null;
    let receivedWorkspaceRoot = null;

    await mkdir(path.dirname(generatedDoctorPath), { recursive: true });
    await writeJson(generatedDoctorPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-doctor-path-run",
      readyTaskCount: 0,
      descriptors: []
    });

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      doctorReportPath: "missing-runtime-doctor.json",
      operations: {
        runRuntimeDoctor: async (outputDir, workspaceRoot) => {
          receivedWorkspaceRoot = workspaceRoot;
          return {
            jsonPath: generatedDoctorPath
          };
        },
        tickProjectRun: async (statePath, doctorReportPath) => {
          receivedDoctorReportPath = doctorReportPath;
          return {
            handoffIndexPath,
            readyTaskCount: 0
          };
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not be reached when there are no ready tasks");
        }
      }
    });

    const runState = await readJson(runResult.statePath);

    assert.equal(receivedWorkspaceRoot, runState.workspacePath);
    assert.equal(receivedDoctorReportPath, generatedDoctorPath);
    assert.equal(result.summary.doctorReportPath, generatedDoctorPath);
  });

  await runTest("autonomous loop stops when dispatch skips all ready tasks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-no-progress-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-no-progress-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let tickCalls = 0;
    let dispatchCalls = 0;

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-no-progress-run",
      readyTaskCount: 1,
      descriptors: []
    });

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 5,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          tickCalls += 1;
          return {
            handoffIndexPath,
            readyTaskCount: 1
          };
        },
        dispatchHandoffs: async () => {
          dispatchCalls += 1;
          return {
            summary: {
              executed: 0,
              completed: 0,
              continued: 0,
              incomplete: 0,
              failed: 0,
              skipped: 1
            }
          };
        }
      }
    });

    assert.equal(tickCalls, 1);
    assert.equal(dispatchCalls, 1);
    assert.equal(
      result.summary.stopReason,
      "dispatch skipped all ready tasks; no automatic runtime was available"
    );
  });

  console.log("Autonomous run tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
