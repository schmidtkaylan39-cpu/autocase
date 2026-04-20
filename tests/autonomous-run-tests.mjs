import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  await runTest("autonomous loop retries blocked planning tasks before ticking dispatch", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-planner-retry-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-planner-retry-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");

    await writeJson(doctorReportPath, { checks: [] });
    await updateRunTask(runResult.statePath, "planning-brief", "blocked", "planning needs another pass");

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          throw new Error("tickProjectRun should not be reached before planner recovery");
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not be reached before planner recovery");
        }
      }
    });

    const runState = await readJson(runResult.statePath);
    const planningTask = runState.taskLedger.find((task) => task.id === "planning-brief");

    assert.equal(result.summary.rounds[0]?.recovery?.type, "planner_retry");
    assert.equal(result.summary.rounds[0]?.recovery?.sourceTaskId, "planning-brief");
    assert.equal(planningTask?.status, "ready");
    assert.ok(
      (planningTask?.notes ?? []).some((note) => /autonomous-planner-retry:/i.test(note)),
      "planning task should record an autonomous planner retry note"
    );
  });

  await runTest("autonomous loop reclaims dead planner execution locks and retries planning", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-dead-lock-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-dead-lock-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const activeResultPath = path.join(tempDir, "planning-brief.result.json");
    const executionLockPath = `${activeResultPath}.execute.lock`;
    const deadPid = 999999;
    const currentRunState = await readJson(runResult.statePath);

    await writeJson(doctorReportPath, { checks: [] });
    await writeFile(executionLockPath, `${deadPid} ${new Date().toISOString()}\n`, "utf8");
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...currentRunState,
        taskLedger: currentRunState.taskLedger.map((task) =>
          task.id === "planning-brief"
            ? {
                ...task,
                status: "in_progress",
                activeHandoffId: "dead-lock-handoff",
                activeResultPath,
                activeHandoffOutputDir: path.join(tempDir, "handoffs"),
                notes: [
                  ...(Array.isArray(task.notes) ? task.notes : []),
                  `${new Date().toISOString()} dispatch:claimed dead-lock-handoff`
                ]
              }
            : task
        )
      })
    );

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          throw new Error("tickProjectRun should not be reached before dead-lock recovery");
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not be reached before dead-lock recovery");
        }
      }
    });

    const nextRunState = await readJson(runResult.statePath);
    const planningTask = nextRunState.taskLedger.find((task) => task.id === "planning-brief");

    assert.equal(result.summary.rounds[0]?.recovery?.type, "planner_retry");
    assert.match(result.summary.rounds[0]?.recovery?.reason ?? "", /orphaned execution lock/i);
    assert.equal(planningTask?.status, "ready");
    assert.ok(
      (planningTask?.notes ?? []).some((note) => /autonomous-planner-retry:.*orphaned execution lock/i.test(note)),
      "planning task should record dead-lock recovery details"
    );
  });

  await runTest("autonomous loop retries blocked delivery packaging tasks before ticking dispatch", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-delivery-retry-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-delivery-retry-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const runState = await readJson(runResult.statePath);

    await writeJson(doctorReportPath, { checks: [] });
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...runState,
        taskLedger: runState.taskLedger.map((task) => ({
          ...task,
          status: task.id === "delivery-package" ? "blocked" : "completed"
        }))
      })
    );

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          throw new Error("tickProjectRun should not be reached before delivery recovery");
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not be reached before delivery recovery");
        }
      }
    });

    const nextRunState = await readJson(runResult.statePath);
    const deliveryTask = nextRunState.taskLedger.find((task) => task.id === "delivery-package");

    assert.equal(result.summary.rounds[0]?.recovery?.type, "task_retry");
    assert.equal(result.summary.rounds[0]?.recovery?.sourceTaskId, "delivery-package");
    assert.deepEqual(result.summary.rounds[0]?.recovery?.targetTaskIds, ["delivery-package"]);
    assert.equal(deliveryTask?.status, "ready");
    assert.ok(
      (deliveryTask?.notes ?? []).some((note) => /autonomous-task-retry:/i.test(note)),
      "delivery task should record an autonomous task retry note"
    );
  });

  await runTest("autonomous loop uses the reviewer replan budget instead of the implementation budget", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-replan-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-replan-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let tickCalls = 0;
    let dispatchCalls = 0;

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-replan-run",
      readyTaskCount: 1,
      descriptors: []
    });

    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planning completed");
    await updateRunTask(runResult.statePath, "implement-spec-intake", "completed", "implementation completed");
    const reviewBudgetRunState = await readJson(runResult.statePath);
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...reviewBudgetRunState,
        retryPolicy: {
          implementation: 6,
          review: 3,
          verification: 3,
          replanning: 1
        },
        taskLedger: reviewBudgetRunState.taskLedger.map((task) =>
          task.id === "implement-spec-intake"
            ? {
                ...task,
                retriesBeforeReplan: 6
              }
            : task
        )
      })
    );

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 4,
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
          const currentRunState = await readJson(runResult.statePath);
          const nextRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) =>
              task.id === "review-spec-intake" ? { ...task, status: "blocked" } : task
            )
          });

          await writeJson(runResult.statePath, nextRunState);

          return {
            summary: {
              executed: 1,
              completed: 0,
              continued: 1,
              incomplete: 1,
              failed: 0,
              skipped: 0
            }
          };
        }
      }
    });

    const runState = await readJson(runResult.statePath);
    const implementationTask = runState.taskLedger.find((task) => task.id === "implement-spec-intake");
    const recoveryTypes = result.summary.rounds.map((round) => round.recovery?.type).filter(Boolean);
    const reviewerRequeues = (implementationTask?.notes ?? []).filter((note) =>
      /autonomous-requeue:review-spec-intake/i.test(note)
    );

    assert.equal(tickCalls, 4);
    assert.equal(dispatchCalls, 4);
    assert.deepEqual(recoveryTypes, [
      "feature_rework",
      "feature_rework",
      "feature_rework",
      "feature_replan"
    ]);
    assert.equal(result.summary.stopReason, "maximum rounds reached");
    assert.equal(reviewerRequeues.length, 3);
    assert.equal(runState.taskLedger.find((task) => task.id === "planning-brief")?.status, "ready");
    assert.equal(runState.taskLedger.find((task) => task.id === "implement-spec-intake")?.status, "pending");
    assert.equal(runState.taskLedger.find((task) => task.id === "review-spec-intake")?.status, "pending");
    assert.equal(runState.taskLedger.find((task) => task.id === "verify-spec-intake")?.status, "pending");
  });

  await runTest("autonomous loop uses the verifier replan budget instead of the implementation budget", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-verify-replan-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-verify-replan-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let tickCalls = 0;
    let dispatchCalls = 0;

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-verify-replan-run",
      readyTaskCount: 1,
      descriptors: []
    });

    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planning completed");
    await updateRunTask(runResult.statePath, "implement-spec-intake", "completed", "implementation completed");
    const verificationBudgetRunState = await readJson(runResult.statePath);
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...verificationBudgetRunState,
        retryPolicy: {
          implementation: 6,
          review: 3,
          verification: 3,
          replanning: 1
        },
        taskLedger: verificationBudgetRunState.taskLedger.map((task) =>
          task.id === "implement-spec-intake"
            ? {
                ...task,
                retriesBeforeReplan: 6
              }
            : task
        )
      })
    );

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 4,
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
          const currentRunState = await readJson(runResult.statePath);
          const nextRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) =>
              task.id === "verify-spec-intake" ? { ...task, status: "failed" } : task
            )
          });

          await writeJson(runResult.statePath, nextRunState);

          return {
            summary: {
              executed: 1,
              completed: 0,
              continued: 1,
              incomplete: 1,
              failed: 0,
              skipped: 0
            }
          };
        }
      }
    });

    const runState = await readJson(runResult.statePath);
    const implementationTask = runState.taskLedger.find((task) => task.id === "implement-spec-intake");
    const recoveryTypes = result.summary.rounds.map((round) => round.recovery?.type).filter(Boolean);
    const verifierRequeues = (implementationTask?.notes ?? []).filter((note) =>
      /autonomous-requeue:verify-spec-intake/i.test(note)
    );

    assert.equal(tickCalls, 4);
    assert.equal(dispatchCalls, 4);
    assert.deepEqual(recoveryTypes, [
      "feature_rework",
      "feature_rework",
      "feature_rework",
      "feature_replan"
    ]);
    assert.equal(result.summary.stopReason, "maximum rounds reached");
    assert.equal(verifierRequeues.length, 3);
    assert.equal(runState.taskLedger.find((task) => task.id === "planning-brief")?.status, "ready");
    assert.equal(runState.taskLedger.find((task) => task.id === "implement-spec-intake")?.status, "pending");
    assert.equal(runState.taskLedger.find((task) => task.id === "review-spec-intake")?.status, "pending");
    assert.equal(runState.taskLedger.find((task) => task.id === "verify-spec-intake")?.status, "pending");
  });

  await runTest("autonomous loop keeps delivery interruptions recoverable before the replan boundary", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-delivery-recover-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-delivery-recover-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const failureSequence = [
      { taskId: "review-spec-intake", status: "blocked", interruptDelivery: false },
      { taskId: "verify-spec-intake", status: "failed", interruptDelivery: true },
      { taskId: "review-spec-intake", status: "blocked", interruptDelivery: false },
      { taskId: "verify-spec-intake", status: "failed", interruptDelivery: true }
    ];
    let tickCalls = 0;
    let dispatchCalls = 0;
    const deliveryStatusBeforeDispatch = [];

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-delivery-recover-run",
      readyTaskCount: 1,
      descriptors: []
    });

    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planning completed");
    await updateRunTask(runResult.statePath, "implement-spec-intake", "completed", "implementation completed");

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: failureSequence.length,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          tickCalls += 1;
          const currentRunState = await readJson(runResult.statePath);
          deliveryStatusBeforeDispatch.push(
            currentRunState.taskLedger.find((task) => task.id === "delivery-package")?.status ?? "unknown"
          );

          return {
            handoffIndexPath,
            readyTaskCount: 1
          };
        },
        dispatchHandoffs: async () => {
          dispatchCalls += 1;
          const currentRunState = await readJson(runResult.statePath);
          const step = failureSequence[dispatchCalls - 1];

          if (!step) {
            throw new Error(`Unexpected dispatch call count: ${dispatchCalls}`);
          }

          const nextRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) => {
              if (task.id === step.taskId) {
                return {
                  ...task,
                  status: step.status
                };
              }

              if (step.interruptDelivery && task.id === "delivery-package") {
                return {
                  ...task,
                  status: "blocked"
                };
              }

              return task;
            })
          });

          await writeJson(runResult.statePath, nextRunState);

          return {
            summary: {
              executed: 1,
              completed: 0,
              continued: 1,
              incomplete: 1,
              failed: 0,
              skipped: 0
            }
          };
        }
      }
    });

    const runState = await readJson(runResult.statePath);
    const implementationTask = runState.taskLedger.find((task) => task.id === "implement-spec-intake");
    const recoveryTypes = result.summary.rounds.map((round) => round.recovery?.type).filter(Boolean);

    assert.equal(tickCalls, 4);
    assert.equal(dispatchCalls, 4);
    assert.deepEqual(recoveryTypes, [
      "feature_rework",
      "feature_rework",
      "feature_rework",
      "feature_rework"
    ]);
    assert.ok(
      deliveryStatusBeforeDispatch.every((status) => status === "pending"),
      `Expected delivery-package to stay recoverable, received: ${deliveryStatusBeforeDispatch.join(", ")}`
    );
    assert.equal(
      (implementationTask?.notes ?? []).filter((note) => /autonomous-requeue:/i.test(note)).length,
      4
    );
    assert.equal(runState.taskLedger.find((task) => task.id === "planning-brief")?.status, "completed");
    assert.equal(runState.taskLedger.find((task) => task.id === "implement-spec-intake")?.status, "ready");
    assert.equal(runState.taskLedger.find((task) => task.id === "review-spec-intake")?.status, "pending");
    assert.equal(runState.taskLedger.find((task) => task.id === "verify-spec-intake")?.status, "pending");
    assert.equal(runState.taskLedger.find((task) => task.id === "delivery-package")?.status, "pending");
    assert.equal(result.summary.stopReason, "maximum rounds reached");
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
    assert.equal(result.summary.finalStatus, "attention_required");
    assert.equal(result.summary.rounds.length, 1);
    assert.equal(result.summary.runSummary.blockedTasks, 1);
    assert.equal(
      result.summary.stopReason,
      "dispatch skipped all ready tasks; no automatic runtime was available"
    );
  });

  await runTest("autonomous loop terminates degraded no-progress cycles promptly", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-degraded-no-progress-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-degraded-no-progress-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let dispatchCalls = 0;
    const previousNoProgressCycles = process.env.AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES;
    const existingRunState = await readJson(runResult.statePath);
    const seededRunState = refreshRunState({
      ...existingRunState,
      taskLedger: existingRunState.taskLedger.map((task) =>
        task.id === "planning-brief"
          ? {
              ...task,
              notes: [...(Array.isArray(task.notes) ? task.notes : []), `${new Date().toISOString()} acceptance-model-degrade: switched to gpt-5.4`]
            }
          : ["implement-workflow-plan", "review-workflow-plan", "verify-workflow-plan"].includes(task.id)
            ? {
                ...task,
                status: "completed"
              }
            : task
      )
    });

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-degraded-no-progress-run",
      readyTaskCount: 1,
      descriptors: []
    });
    await writeJson(runResult.statePath, seededRunState);
    process.env.AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES = "2";

    try {
      const result = await runAutonomousLoop(runResult.statePath, {
        maxRounds: 5,
        operations: {
          runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
          tickProjectRun: async () => ({
            handoffIndexPath,
            readyTaskCount: 1
          }),
          dispatchHandoffs: async () => {
            dispatchCalls += 1;
            const currentRunState = refreshRunState(await readJson(runResult.statePath));
            const nextRunState =
              dispatchCalls === 1
                ? refreshRunState({
                    ...currentRunState,
                    taskLedger: currentRunState.taskLedger.map((task) =>
                      task.id === "planning-brief"
                        ? { ...task, status: "completed" }
                        : task.id === "implement-spec-intake"
                          ? { ...task, status: "ready" }
                          : task
                    )
                  })
                : refreshRunState({
                    ...currentRunState,
                    taskLedger: currentRunState.taskLedger.map((task) =>
                      task.id === "implement-spec-intake" ? { ...task, status: "in_progress" } : task
                    )
                  });

            await writeJson(runResult.statePath, nextRunState);

            return {
              summary: {
                executed: 1,
                completed: dispatchCalls === 1 ? 1 : 0,
                continued: dispatchCalls === 1 ? 0 : 1,
                incomplete: dispatchCalls === 1 ? 0 : 1,
                failed: 0,
                skipped: 0
              },
              results: [
                {
                  taskId: dispatchCalls === 1 ? "planning-brief" : "implement-spec-intake",
                  status: dispatchCalls === 1 ? "completed" : "continued"
                }
              ]
            };
          }
        }
      });

      const nextRunState = await readJson(runResult.statePath);

      assert.equal(dispatchCalls, 3);
      assert.equal(result.summary.finalStatus, "attention_required");
      assert.match(result.summary.stopReason, /no-progress circuit/i);
      assert.equal(result.summary.progressDiagnostics.degradedRuntimeActive, true);
      assert.equal(result.summary.progressDiagnostics.lastProgressTaskId, "planning-brief");
      assert.equal(result.summary.progressDiagnostics.lastProgressEvent, "task_completed");
      assert.equal(result.summary.progressDiagnostics.consecutiveNoProgressCycles, 2);
      assert.ok(result.summary.progressDiagnostics.blockedTaskIds.includes("implement-spec-intake"));
      assert.equal(nextRunState.taskLedger.find((task) => task.id === "implement-spec-intake")?.status, "blocked");
    } finally {
      if (previousNoProgressCycles === undefined) {
        delete process.env.AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES;
      } else {
        process.env.AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES = previousNoProgressCycles;
      }
    }
  });

  await runTest("real progress does not trip the no-progress breaker", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-progress-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-progress-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const completionOrder = [
      "planning-brief",
      "implement-spec-intake",
      "review-spec-intake",
      "verify-spec-intake",
      "delivery-package"
    ];
    let dispatchCalls = 0;
    const previousNoProgressCycles = process.env.AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES;
    const initialRunState = await readJson(runResult.statePath);

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-progress-run",
      readyTaskCount: 1,
      descriptors: []
    });
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...initialRunState,
        taskLedger: initialRunState.taskLedger.map((task) =>
          task.id === "planning-brief"
            ? {
                ...task,
                notes: [...(Array.isArray(task.notes) ? task.notes : []), `${new Date().toISOString()} acceptance-model-degrade: switched to gpt-5.4`]
              }
            : ["implement-workflow-plan", "review-workflow-plan", "verify-workflow-plan"].includes(task.id)
              ? {
                  ...task,
                  status: "completed"
                }
            : task
        )
      })
    );
    process.env.AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES = "2";

    try {
      const result = await runAutonomousLoop(runResult.statePath, {
        maxRounds: completionOrder.length + 1,
        operations: {
          runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
          tickProjectRun: async () => ({
            handoffIndexPath,
            readyTaskCount: 1
          }),
          dispatchHandoffs: async () => {
            const taskId = completionOrder[dispatchCalls];
            dispatchCalls += 1;
            const currentRunState = refreshRunState(await readJson(runResult.statePath));
            const nextRunState = refreshRunState({
              ...currentRunState,
              taskLedger: currentRunState.taskLedger.map((task) =>
                task.id === taskId ? { ...task, status: "completed" } : task
              )
            });

            await writeJson(runResult.statePath, nextRunState);

            return {
              summary: {
                executed: 1,
                completed: 1,
                continued: 0,
                incomplete: 0,
                failed: 0,
                skipped: 0
              },
              results: [
                {
                  taskId,
                  status: "completed"
                }
              ]
            };
          }
        }
      });

      assert.equal(dispatchCalls, completionOrder.length);
      assert.equal(result.summary.finalStatus, "completed");
      assert.equal(result.summary.stopReason, "run completed");
      assert.equal(result.summary.progressDiagnostics.consecutiveNoProgressCycles, 0);
      assert.equal(result.summary.progressDiagnostics.lastProgressTaskId, "delivery-package");
      assert.equal(result.summary.progressDiagnostics.lastProgressEvent, "task_completed");
    } finally {
      if (previousNoProgressCycles === undefined) {
        delete process.env.AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES;
      } else {
        process.env.AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES = previousNoProgressCycles;
      }
    }
  });

  await runTest("autonomous loop emits failure-feedback artifacts and generated test cases for dispatch failures", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-failure-feedback-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-failure-feedback-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const dispatchResultsPath = path.join(tempDir, "handoffs", "dispatch-results.json");
    const dispatchResultsMarkdownPath = path.join(tempDir, "handoffs", "dispatch-results.md");
    let dispatchCalls = 0;

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-failure-feedback-run",
      readyTaskCount: 1,
      descriptors: []
    });

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => ({
          handoffIndexPath,
          readyTaskCount: 1
        }),
        dispatchHandoffs: async () => {
          dispatchCalls += 1;
          const currentRunState = refreshRunState(await readJson(runResult.statePath));
          const failedRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) =>
              task.id === "planning-brief" ? { ...task, status: "failed" } : task
            )
          });

          await writeJson(runResult.statePath, failedRunState);

          return {
            summary: {
              executed: 1,
              completed: 0,
              continued: 0,
              incomplete: 0,
              failed: 1,
              skipped: 0
            },
            resultJsonPath: dispatchResultsPath,
            resultMarkdownPath: dispatchResultsMarkdownPath,
            results: [
              {
                taskId: "planning-brief",
                runtime: "gpt-runner",
                status: "failed",
                error: "Injected 502 Bad Gateway during autonomous drill",
                launcherPath: path.join(tempDir, "handoffs", "planning-brief.launch.ps1"),
                resultPath: path.join(tempDir, "handoffs", "results", "planning-brief.result.json")
              }
            ]
          };
        }
      }
    });

    const feedbackDirectory = path.join(path.dirname(runResult.statePath), "artifacts", "failure-feedback");
    const feedbackIndex = await readJson(path.join(feedbackDirectory, "failure-feedback-index.json"));
    const generatedCases = await readJson(path.join(feedbackDirectory, "generated-test-cases.json"));

    assert.equal(dispatchCalls, 1);
    assert.equal(result.summary.failureFeedback.count, 1);
    assert.equal(feedbackIndex.count, 1);
    assert.equal(feedbackIndex.entries[0].category, "environment_mismatch");
    assert.match(feedbackIndex.entries[0].summary, /502 Bad Gateway/i);
    assert.equal(generatedCases.cases.length, 1);
    assert.equal(generatedCases.cases[0].retryable, true);
  });

  await runTest("autonomous loop rejects concurrent execution for the same run-state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-lock-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-lock-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    /** @type {(value?: unknown) => void} */
    let releaseDoctor = () => {};
    const doctorGate = new Promise((resolve) => {
      releaseDoctor = resolve;
    });

    await writeJson(doctorReportPath, { checks: [] });

    const firstRunPromise = runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => {
          await doctorGate;
          return { jsonPath: doctorReportPath };
        },
        tickProjectRun: async () => ({
          handoffIndexPath: path.join(tempDir, "handoffs", "index.json"),
          readyTaskCount: 0
        }),
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not run when readyTaskCount is 0");
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    await assert.rejects(
      () =>
        runAutonomousLoop(runResult.statePath, {
          maxRounds: 1,
          operations: {
            runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
            tickProjectRun: async () => ({
              handoffIndexPath: path.join(tempDir, "handoffs", "index.json"),
              readyTaskCount: 0
            }),
            dispatchHandoffs: async () => ({ summary: { executed: 0, skipped: 0 } })
          }
        }),
      /another autonomous loop is already running/i
    );

    releaseDoctor();
    await firstRunPromise;
  });

  await runTest("autonomous loop reclaims orphaned run locks from dead processes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-dead-lock-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-dead-lock-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const lockPath = `${runResult.statePath}.autonomous.lock`;

    await writeJson(doctorReportPath, { checks: [] });
    await writeFile(lockPath, `999999 ${new Date().toISOString()} stale-lock\n`, "utf8");

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => ({
          handoffIndexPath: path.join(tempDir, "handoffs", "index.json"),
          readyTaskCount: 0
        }),
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not run when readyTaskCount is 0");
        }
      }
    });

    await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
    assert.equal(result.summary.stopReason, "no ready tasks were available for autonomous dispatch");
  });

  await runTest("autonomous loop recovers stale in-progress planner claims before tick", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-stale-inprogress-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-stale-inprogress-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const staleClaimTimestamp = new Date(Date.now() - 60_000).toISOString();
    const existingRunState = await readJson(runResult.statePath);
    const staleResultPath = path.join(tempDir, "stale.result.json");
    const staleExecuteLockPath = `${staleResultPath}.execute.lock`;

    await writeJson(doctorReportPath, { checks: [] });
    await writeFile(staleExecuteLockPath, `999999 ${new Date().toISOString()}\n`, "utf8");
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...existingRunState,
        taskLedger: existingRunState.taskLedger.map((task) =>
          task.id === "planning-brief"
            ? {
                ...task,
                status: "in_progress",
                activeHandoffId: "stale-claimed-handoff",
                activeResultPath: staleResultPath,
                notes: [...(Array.isArray(task.notes) ? task.notes : []), `${staleClaimTimestamp} dispatch:claimed stale-claimed-handoff`]
              }
            : task
        )
      })
    );

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          throw new Error("tickProjectRun should not be reached before stale in-progress recovery");
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not be reached before stale in-progress recovery");
        }
      }
    });

    const nextRunState = await readJson(runResult.statePath);
    const planningTask = nextRunState.taskLedger.find((task) => task.id === "planning-brief");

    assert.equal(result.summary.rounds[0]?.recovery?.type, "planner_retry");
    assert.equal(planningTask?.status, "ready");
    await assert.rejects(() => readFile(staleExecuteLockPath, "utf8"), /ENOENT/);
    assert.ok(
      (planningTask?.notes ?? []).some((note) => /autonomous-planner-retry:/i.test(note)),
      "planning task should record autonomous stale in-progress recovery note"
    );
  });

  console.log("Autonomous run tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
