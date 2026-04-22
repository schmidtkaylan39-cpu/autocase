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

  await runTest("autonomous loop fails closed on truncated run-state artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-corrupt-run-state-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-corrupt-run-state");

    await writeFile(runResult.statePath, '{"runId":"autonomous-corrupt-run-state"', "utf8");

    await assert.rejects(
      () => runAutonomousLoop(runResult.statePath, { maxRounds: 1 }),
      /run-state artifact is invalid|malformed JSON|partial write/i
    );
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

  await runTest("autonomous loop stops when the planner autonomous retry budget is exhausted", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-planner-budget-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-planner-budget-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let dispatchCalls = 0;
    const initialRunState = await readJson(runResult.statePath);

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-planner-budget-run",
      readyTaskCount: 1,
      descriptors: []
    });
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...initialRunState,
        retryPolicy: {
          ...initialRunState.retryPolicy,
          replanning: 1
        }
      })
    );

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
          const nextRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) =>
              task.id === "planning-brief" ? { ...task, status: "blocked" } : task
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
            },
            results: [
              {
                taskId: "planning-brief",
                status: "incomplete"
              }
            ]
          };
        }
      }
    });

    const nextRunState = await readJson(runResult.statePath);
    const planningTask = nextRunState.taskLedger.find((task) => task.id === "planning-brief");

    assert.equal(dispatchCalls, 2);
    assert.equal(result.summary.finalStatus, "attention_required");
    assert.equal(result.summary.terminalState, "blocked");
    assert.equal(result.summary.failureTaxonomy.stopCategory, "logic_bug");
    assert.match(result.summary.stopReason ?? "", /planner retry budget exhausted/i);
    assert.equal(planningTask?.status, "blocked");
    assert.ok(
      (planningTask?.notes ?? []).some((note) => /autonomous-planner-retry:budget-exhausted/i.test(note)),
      "planner task should record autonomous retry budget exhaustion"
    );
  });

  await runTest("autonomous loop stops when the delivery autonomous retry budget is exhausted", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-delivery-budget-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-delivery-budget-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let dispatchCalls = 0;
    const initialRunState = await readJson(runResult.statePath);

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-delivery-budget-run",
      readyTaskCount: 1,
      descriptors: []
    });
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...initialRunState,
        retryPolicy: {
          ...initialRunState.retryPolicy,
          replanning: 1
        },
        taskLedger: initialRunState.taskLedger.map((task) => ({
          ...task,
          status: task.id === "delivery-package" ? "ready" : "completed"
        }))
      })
    );

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
          const nextRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) =>
              task.id === "delivery-package" ? { ...task, status: "blocked" } : task
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
            },
            results: [
              {
                taskId: "delivery-package",
                status: "incomplete"
              }
            ]
          };
        }
      }
    });

    const nextRunState = await readJson(runResult.statePath);
    const deliveryTask = nextRunState.taskLedger.find((task) => task.id === "delivery-package");

    assert.equal(dispatchCalls, 2);
    assert.equal(result.summary.finalStatus, "attention_required");
    assert.equal(result.summary.terminalState, "blocked");
    assert.equal(result.summary.failureTaxonomy.stopCategory, "logic_bug");
    assert.match(result.summary.stopReason ?? "", /task retry budget exhausted/i);
    assert.equal(deliveryTask?.status, "blocked");
    assert.ok(
      (deliveryTask?.notes ?? []).some((note) => /autonomous-task-retry:budget-exhausted/i.test(note)),
      "delivery task should record autonomous retry budget exhaustion"
    );
  });

  await runTest("autonomous loop preserves retry-budget exhaustion across reruns", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-planner-budget-rerun-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-planner-budget-rerun");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let dispatchCalls = 0;
    const initialRunState = await readJson(runResult.statePath);

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-planner-budget-rerun",
      readyTaskCount: 1,
      descriptors: []
    });
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...initialRunState,
        retryPolicy: {
          ...initialRunState.retryPolicy,
          replanning: 1
        }
      })
    );

    const firstResult = await runAutonomousLoop(runResult.statePath, {
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
          const nextRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) =>
              task.id === "planning-brief" ? { ...task, status: "blocked" } : task
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
            },
            results: [
              {
                taskId: "planning-brief",
                status: "incomplete"
              }
            ]
          };
        }
      }
    });

    const secondResult = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          throw new Error("tickProjectRun should not run after retry budget exhaustion is recorded");
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not run after retry budget exhaustion is recorded");
        }
      }
    });

    assert.equal(dispatchCalls, 2);
    assert.match(firstResult.summary.stopReason ?? "", /planner retry budget exhausted/i);
    assert.match(secondResult.summary.stopReason ?? "", /planner retry budget exhausted/i);
    assert.equal(secondResult.summary.terminalState, "blocked");
    assert.equal(secondResult.summary.failureTaxonomy.stopCategory, "logic_bug");
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
    assert.equal(result.summary.terminalState, "blocked");
    assert.equal(result.summary.rounds.length, 1);
    assert.equal(result.summary.runSummary.blockedTasks, 1);
    assert.equal(result.summary.failureTaxonomy.stopCategory, "environment_mismatch");
    assert.equal(result.summary.watchdog.triggered, false);
    assert.match(result.summary.watchdog.heartbeatAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      result.summary.stopReason,
      "dispatch skipped all ready tasks; no automatic runtime was available"
    );
  });

  await runTest("autonomous loop classifies exhausted terminal state when the round budget is consumed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-exhausted-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-exhausted-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");

    await writeJson(doctorReportPath, { checks: [] });

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 0,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          throw new Error("tickProjectRun should not run when maxRounds is 0");
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not run when maxRounds is 0");
        }
      }
    });

    assert.equal(result.summary.finalStatus, "planned");
    assert.equal(result.summary.terminalState, "exhausted");
    assert.equal(result.summary.stopReason, "maximum rounds reached");
    assert.equal(result.summary.failureTaxonomy.stopCategory, "unknown");
    assert.equal(result.summary.watchdog.triggered, false);
    assert.match(result.summary.watchdog.heartbeatAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
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
      assert.equal(result.summary.terminalState, "blocked");
      assert.match(result.summary.stopReason, /no-progress circuit/i);
      assert.equal(result.summary.failureTaxonomy.stopCategory, "timeout");
      assert.equal(result.summary.progressDiagnostics.degradedRuntimeActive, true);
      assert.equal(result.summary.progressDiagnostics.lastProgressTaskId, "planning-brief");
      assert.equal(result.summary.progressDiagnostics.lastProgressEvent, "task_completed");
      assert.equal(result.summary.progressDiagnostics.consecutiveNoProgressCycles, 2);
      assert.equal(result.summary.watchdog.triggered, true);
      assert.equal(result.summary.watchdog.lastEvent, "no_progress_circuit_opened");
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

  await runTest("autonomous loop treats recycled ready work as no-progress", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-recycled-ready-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-recycled-ready-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    let dispatchCalls = 0;
    const previousNoProgressCycles = process.env.AI_FACTORY_AUTONOMOUS_NO_PROGRESS_CYCLES;
    const initialRunState = await readJson(runResult.statePath);

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-recycled-ready-run",
      readyTaskCount: 1,
      descriptors: []
    });
    await writeJson(
      runResult.statePath,
      refreshRunState({
        ...initialRunState,
        retryPolicy: {
          ...initialRunState.retryPolicy,
          replanning: 10
        }
      })
    );
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
            const nextRunState = refreshRunState({
              ...currentRunState,
              taskLedger: currentRunState.taskLedger.map((task) =>
                task.id === "planning-brief" ? { ...task, status: "blocked" } : task
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
              },
              results: [
                {
                  taskId: "planning-brief",
                  status: "incomplete"
                }
              ]
            };
          }
        }
      });

      const nextRunState = await readJson(runResult.statePath);

      assert.equal(dispatchCalls, 2);
      assert.equal(result.summary.finalStatus, "attention_required");
      assert.equal(result.summary.terminalState, "blocked");
      assert.equal(result.summary.failureTaxonomy.stopCategory, "timeout");
      assert.match(result.summary.stopReason ?? "", /no-progress circuit/i);
      assert.equal(result.summary.progressDiagnostics.consecutiveNoProgressCycles, 2);
      assert.equal(result.summary.watchdog.triggered, true);
      assert.equal(result.summary.watchdog.lastEvent, "no_progress_circuit_opened");
      assert.equal(nextRunState.taskLedger.find((task) => task.id === "planning-brief")?.status, "blocked");
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

  await runTest("autonomous loop records continued transient GPT-runner retries as retryable environment feedback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-continued-feedback-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-continued-feedback-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const dispatchResultsPath = path.join(tempDir, "handoffs", "dispatch-results.json");
    const dispatchResultsMarkdownPath = path.join(tempDir, "handoffs", "dispatch-results.md");

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-continued-feedback-run",
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
        dispatchHandoffs: async () => ({
          summary: {
            executed: 1,
            completed: 0,
            continued: 1,
            incomplete: 0,
            failed: 0,
            skipped: 0
          },
          resultJsonPath: dispatchResultsPath,
          resultMarkdownPath: dispatchResultsMarkdownPath,
          results: [
            {
              taskId: "planning-brief",
              runtime: "gpt-runner",
              status: "continued",
              note: "Converted exhausted transient GPT Runner failure into an automatic retry. Runtime reported a blocked task with an automatic continuation decision.",
              launcherPath: path.join(tempDir, "handoffs", "planning-brief.launch.ps1"),
              resultPath: path.join(tempDir, "handoffs", "results", "planning-brief.result.json"),
              artifact: {
                status: "blocked",
                summary:
                  "Transient GPT Runner upstream failure; automatically retrying the same task. Observed transient provider or transport symptoms in launcher output.",
                verification: [
                  "Observed transient GPT Runner provider failure and scheduled an automatic retry."
                ],
                notes: [
                  "Transient GPT Runner upstream failure; automatically retrying the same task. Observed transient provider or transport symptoms in launcher output."
                ],
                automationDecision: {
                  action: "retry_task",
                  reason:
                    "Transient GPT Runner upstream failure; automatically retrying the same task. Observed transient provider or transport symptoms in launcher output.",
                  delayMinutes: 0
                }
              }
            }
          ]
        })
      }
    });

    const feedbackDirectory = path.join(path.dirname(runResult.statePath), "artifacts", "failure-feedback");
    const feedbackIndex = await readJson(path.join(feedbackDirectory, "failure-feedback-index.json"));
    const generatedCases = await readJson(path.join(feedbackDirectory, "generated-test-cases.json"));

    assert.equal(result.summary.failureFeedback.count, 1);
    assert.equal(feedbackIndex.count, 1);
    assert.equal(feedbackIndex.entries[0].status, "continued");
    assert.equal(feedbackIndex.entries[0].category, "environment_mismatch");
    assert.equal(feedbackIndex.entries[0].retryable, true);
    assert.match(feedbackIndex.entries[0].summary, /transient gpt runner/i);
    assert.equal(generatedCases.cases.length, 1);
    assert.equal(generatedCases.cases[0].retryable, true);
  });

  await runTest("autonomous loop records launcher permission retry decisions as environment feedback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-launcher-permission-feedback-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-launcher-permission-feedback-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const dispatchResultsPath = path.join(tempDir, "handoffs", "dispatch-results.json");
    const dispatchResultsMarkdownPath = path.join(tempDir, "handoffs", "dispatch-results.md");

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-launcher-permission-feedback-run",
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
        dispatchHandoffs: async () => ({
          summary: {
            executed: 1,
            completed: 0,
            continued: 1,
            incomplete: 0,
            failed: 0,
            skipped: 0
          },
          resultJsonPath: dispatchResultsPath,
          resultMarkdownPath: dispatchResultsMarkdownPath,
          results: [
            {
              taskId: "planning-brief",
              runtime: "codex",
              status: "continued",
              note: "Converted launcher process permission denial into an automatic retry. Runtime reported a blocked task with an automatic continuation decision.",
              launcherPath: path.join(tempDir, "handoffs", "planning-brief.launch.ps1"),
              resultPath: path.join(tempDir, "handoffs", "results", "planning-brief.result.json"),
              artifact: {
                status: "blocked",
                summary:
                  "Launcher process creation was denied for runtime codex; automatically retrying the same task after a short cooldown. The host environment reported a permission or policy restriction while starting the launcher. spawn EPERM",
                verification: [
                  "Observed launcher process creation denial while starting runtime codex."
                ],
                notes: [
                  "Launcher process creation was denied for runtime codex; automatically retrying the same task after a short cooldown. The host environment reported a permission or policy restriction while starting the launcher. spawn EPERM"
                ],
                automationDecision: {
                  action: "retry_task",
                  reason:
                    "Launcher process creation was denied for runtime codex; automatically retrying the same task after a short cooldown. The host environment reported a permission or policy restriction while starting the launcher. spawn EPERM",
                  delayMinutes: 1
                }
              }
            }
          ]
        })
      }
    });

    const feedbackDirectory = path.join(path.dirname(runResult.statePath), "artifacts", "failure-feedback");
    const feedbackIndex = await readJson(path.join(feedbackDirectory, "failure-feedback-index.json"));
    const generatedCases = await readJson(path.join(feedbackDirectory, "generated-test-cases.json"));

    assert.equal(result.summary.failureFeedback.count, 1);
    assert.equal(feedbackIndex.count, 1);
    assert.equal(feedbackIndex.entries[0].status, "continued");
    assert.equal(feedbackIndex.entries[0].category, "environment_mismatch");
    assert.equal(feedbackIndex.entries[0].retryable, true);
    assert.match(feedbackIndex.entries[0].summary, /launcher process creation was denied/i);
    assert.equal(generatedCases.cases.length, 1);
    assert.equal(generatedCases.cases[0].retryable, true);
  });

  await runTest("autonomous loop records doctor-to-runtime model denial as non-retryable environment feedback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-model-denial-feedback-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-model-denial-feedback-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const dispatchResultsPath = path.join(tempDir, "handoffs", "dispatch-results.json");
    const dispatchResultsMarkdownPath = path.join(tempDir, "handoffs", "dispatch-results.md");

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-model-denial-feedback-run",
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
          const currentRunState = refreshRunState(await readJson(runResult.statePath));
          const blockedRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) =>
              task.id === "planning-brief" ? { ...task, status: "blocked" } : task
            )
          });

          await writeJson(runResult.statePath, blockedRunState);

          return {
            summary: {
              executed: 1,
              completed: 0,
              continued: 0,
              incomplete: 1,
              failed: 0,
              skipped: 0
            },
            resultJsonPath: dispatchResultsPath,
            resultMarkdownPath: dispatchResultsMarkdownPath,
            results: [
              {
                taskId: "planning-brief",
                runtime: "gpt-runner",
                status: "incomplete",
                note: "Converted doctor-to-runtime drift into a fail-closed blocked result. Runtime reported a blocked task in the result artifact.",
                launcherPath: path.join(tempDir, "handoffs", "planning-brief.launch.ps1"),
                resultPath: path.join(tempDir, "handoffs", "results", "planning-brief.result.json"),
                artifact: {
                  status: "blocked",
                  summary:
                    "Doctor reported gpt-runner ready, but the first real task hit model denial or unavailable model access and cannot continue automatically. launcherSignal=model access denied for gpt-5.4-pro",
                  verification: [
                    "Observed post-doctor model denial during first real GPT Runner execution; blocking for manual model access follow-up."
                  ],
                  notes: [
                    "Doctor reported gpt-runner ready, but the first real task hit model denial or unavailable model access and cannot continue automatically. launcherSignal=model access denied for gpt-5.4-pro"
                  ]
                }
              }
            ]
          };
        }
      }
    });

    const feedbackDirectory = path.join(path.dirname(runResult.statePath), "artifacts", "failure-feedback");
    const feedbackIndex = await readJson(path.join(feedbackDirectory, "failure-feedback-index.json"));

    assert.equal(result.summary.failureFeedback.count, 1);
    assert.equal(feedbackIndex.entries[0].status, "incomplete");
    assert.equal(feedbackIndex.entries[0].category, "environment_mismatch");
    assert.equal(feedbackIndex.entries[0].retryable, false);
    assert.match(feedbackIndex.entries[0].summary, /model denial/i);
  });

  await runTest("autonomous loop records 429 retry-after drift as retryable rate-limit feedback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-rate-limit-feedback-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-rate-limit-feedback-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const dispatchResultsPath = path.join(tempDir, "handoffs", "dispatch-results.json");
    const dispatchResultsMarkdownPath = path.join(tempDir, "handoffs", "dispatch-results.md");
    const nextRetryAt = new Date(Date.now() + 120_000).toISOString();

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-rate-limit-feedback-run",
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
          const currentRunState = refreshRunState(await readJson(runResult.statePath));
          const waitingRetryRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) =>
              task.id === "planning-brief"
                ? {
                    ...task,
                    status: "waiting_retry",
                    retryCount: (task.retryCount ?? 0) + 1,
                    nextRetryAt,
                    lastRetryReason: "429 Too Many Requests / Retry-After"
                  }
                : task
            )
          });

          await writeJson(runResult.statePath, waitingRetryRunState);

          return {
            summary: {
              executed: 1,
              completed: 0,
              continued: 1,
              incomplete: 0,
              failed: 0,
              skipped: 0
            },
            resultJsonPath: dispatchResultsPath,
            resultMarkdownPath: dispatchResultsMarkdownPath,
            results: [
              {
                taskId: "planning-brief",
                runtime: "gpt-runner",
                status: "continued",
                note: "Converted doctor-to-runtime drift into a fail-closed blocked result. Runtime reported a blocked task with an automatic continuation decision.",
                launcherPath: path.join(tempDir, "handoffs", "planning-brief.launch.ps1"),
                resultPath: path.join(tempDir, "handoffs", "results", "planning-brief.result.json"),
                artifact: {
                  status: "blocked",
                  summary:
                    "Doctor reported gpt-runner ready, but the first real task hit upstream rate limiting (429 / Retry-After). Failing closed with an automatic retry window. launcherSignal=429 Too Many Requests Retry-After: 120",
                  verification: [
                    "Observed upstream rate limiting after doctor readiness and scheduled an automatic retry."
                  ],
                  notes: [
                    "Doctor reported gpt-runner ready, but the first real task hit upstream rate limiting (429 / Retry-After). Failing closed with an automatic retry window. launcherSignal=429 Too Many Requests Retry-After: 120"
                  ],
                  automationDecision: {
                    action: "retry_task",
                    reason:
                      "Doctor reported gpt-runner ready, but the first real task hit upstream rate limiting (429 / Retry-After). Failing closed with an automatic retry window. launcherSignal=429 Too Many Requests Retry-After: 120",
                    delayMinutes: 2
                  }
                }
              }
            ]
          };
        }
      }
    });

    const feedbackDirectory = path.join(path.dirname(runResult.statePath), "artifacts", "failure-feedback");
    const feedbackIndex = await readJson(path.join(feedbackDirectory, "failure-feedback-index.json"));

    assert.equal(result.summary.failureFeedback.count, 1);
    assert.equal(feedbackIndex.entries[0].status, "continued");
    assert.equal(feedbackIndex.entries[0].category, "rate_limit");
    assert.equal(feedbackIndex.entries[0].retryable, true);
    assert.match(feedbackIndex.entries[0].summary, /retry-after/i);
  });

  await runTest("autonomous loop records provider timeout drift as retryable timeout feedback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-provider-timeout-feedback-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-provider-timeout-feedback-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const dispatchResultsPath = path.join(tempDir, "handoffs", "dispatch-results.json");
    const dispatchResultsMarkdownPath = path.join(tempDir, "handoffs", "dispatch-results.md");
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString();

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-provider-timeout-feedback-run",
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
          const currentRunState = refreshRunState(await readJson(runResult.statePath));
          const waitingRetryRunState = refreshRunState({
            ...currentRunState,
            taskLedger: currentRunState.taskLedger.map((task) =>
              task.id === "planning-brief"
                ? {
                    ...task,
                    status: "waiting_retry",
                    retryCount: (task.retryCount ?? 0) + 1,
                    nextRetryAt,
                    lastRetryReason: "provider timeout"
                  }
                : task
            )
          });

          await writeJson(runResult.statePath, waitingRetryRunState);

          return {
            summary: {
              executed: 1,
              completed: 0,
              continued: 1,
              incomplete: 0,
              failed: 0,
              skipped: 0
            },
            resultJsonPath: dispatchResultsPath,
            resultMarkdownPath: dispatchResultsMarkdownPath,
            results: [
              {
                taskId: "planning-brief",
                runtime: "gpt-runner",
                status: "continued",
                note: "Converted doctor-to-runtime drift into a fail-closed blocked result. Runtime reported a blocked task with an automatic continuation decision.",
                launcherPath: path.join(tempDir, "handoffs", "planning-brief.launch.ps1"),
                resultPath: path.join(tempDir, "handoffs", "results", "planning-brief.result.json"),
                artifact: {
                  status: "blocked",
                  summary:
                    "Doctor reported gpt-runner ready, but the first real task hit a provider timeout. Failing closed with an automatic retry. launcherSignal=provider timeout while waiting on /responses endpoint deadline exceeded",
                  verification: [
                    "Observed provider timeout symptoms after doctor readiness and scheduled an automatic retry."
                  ],
                  notes: [
                    "Doctor reported gpt-runner ready, but the first real task hit a provider timeout. Failing closed with an automatic retry. launcherSignal=provider timeout while waiting on /responses endpoint deadline exceeded"
                  ],
                  automationDecision: {
                    action: "retry_task",
                    reason:
                      "Doctor reported gpt-runner ready, but the first real task hit a provider timeout. Failing closed with an automatic retry. launcherSignal=provider timeout while waiting on /responses endpoint deadline exceeded",
                    delayMinutes: 1
                  }
                }
              }
            ]
          };
        }
      }
    });

    const feedbackDirectory = path.join(path.dirname(runResult.statePath), "artifacts", "failure-feedback");
    const feedbackIndex = await readJson(path.join(feedbackDirectory, "failure-feedback-index.json"));

    assert.equal(result.summary.failureFeedback.count, 1);
    assert.equal(feedbackIndex.entries[0].status, "continued");
    assert.equal(feedbackIndex.entries[0].category, "timeout");
    assert.equal(feedbackIndex.entries[0].retryable, true);
    assert.match(feedbackIndex.entries[0].summary, /provider timeout/i);
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

  await runTest("autonomous loop records active checkpoint phase details before tick starts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-active-checkpoint-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-active-checkpoint-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const checkpointPath = path.join(
      path.dirname(runResult.statePath),
      "artifacts",
      "autonomous-debug",
      "checkpoint.json"
    );
    /** @type {{ checkpointStatus?: string, activity?: { phase?: string, round?: number, detail?: string } } | null} */
    let checkpointDuringTick = null;

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-active-checkpoint-run",
      readyTaskCount: 0,
      descriptors: []
    });

    await runAutonomousLoop(runResult.statePath, {
      maxRounds: 1,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          checkpointDuringTick = await readJson(checkpointPath);
          return {
            handoffIndexPath,
            readyTaskCount: 0
          };
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not run when readyTaskCount is 0");
        }
      }
    });

    assert.ok(checkpointDuringTick, "active checkpoint should exist during tick");
    assert.equal(checkpointDuringTick.checkpointStatus, "active");
    assert.equal(checkpointDuringTick.activity?.phase, "tick");
    assert.equal(checkpointDuringTick.activity?.round, 1);
    assert.equal(checkpointDuringTick.activity?.detail, "generate-handoffs");
  });

  await runTest("autonomous loop records resume context from a prior checkpoint without changing control flow", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-resume-context-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-resume-context-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const checkpointPath = path.join(
      path.dirname(runResult.statePath),
      "artifacts",
      "autonomous-debug",
      "checkpoint.json"
    );

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await writeJson(checkpointPath, {
      schemaVersion: 1,
      sessionId: "previous-session",
      checkpointStatus: "active",
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      activity: {
        phase: "dispatch",
        round: 1,
        detail: "resume-pending",
        enteredAt: new Date(Date.now() - 120_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 60_000).toISOString()
      }
    });

    const result = await runAutonomousLoop(runResult.statePath, {
      maxRounds: 0,
      operations: {
        runRuntimeDoctor: async () => ({ jsonPath: doctorReportPath }),
        tickProjectRun: async () => {
          throw new Error("tickProjectRun should not run when maxRounds is 0");
        },
        dispatchHandoffs: async () => {
          throw new Error("dispatchHandoffs should not run when maxRounds is 0");
        }
      }
    });

    const finalCheckpoint = await readJson(checkpointPath);

    assert.equal(result.summary.terminalState, "exhausted");
    assert.equal(finalCheckpoint.resumeContext?.resumed, true);
    assert.equal(finalCheckpoint.resumeContext?.previousSessionId, "previous-session");
    assert.equal(finalCheckpoint.resumeContext?.interruptedActiveSession, true);
    assert.equal(finalCheckpoint.resumeContext?.previousCheckpointStatus, "active");
    assert.equal(finalCheckpoint.resumeContext?.previousActivity?.phase, "dispatch");
    assert.equal(finalCheckpoint.resumeContext?.previousActivity?.round, 1);
    assert.equal(finalCheckpoint.resumeContext?.previousActivity?.detail, "resume-pending");
  });

  await runTest("autonomous loop writes debug bundle, terminal summary, checkpoint, and hypothesis ledger for blocked runs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-debug-blocked-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-debug-blocked-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-debug-blocked-run",
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
        dispatchHandoffs: async () => ({
          summary: {
            executed: 0,
            completed: 0,
            continued: 0,
            incomplete: 0,
            failed: 0,
            skipped: 1
          },
          resultJsonPath: path.join(tempDir, "handoffs", "dispatch-results.json"),
          resultMarkdownPath: path.join(tempDir, "handoffs", "dispatch-results.md"),
          results: [
            {
              taskId: "planning-brief",
              status: "skipped",
              runtime: "manual",
              launcherPath: path.join(tempDir, "handoffs", "planning-brief.launch.ps1"),
              resultPath: path.join(tempDir, "handoffs", "results", "planning-brief.result.json"),
              note: "No automatic runtime was available."
            }
          ]
        })
      }
    });

    const debugDirectory = path.join(path.dirname(runResult.statePath), "artifacts", "autonomous-debug");
    const terminalSummary = await readJson(path.join(debugDirectory, "terminal-summary.json"));
    const checkpoint = await readJson(path.join(debugDirectory, "checkpoint.json"));
    const hypothesisLedger = await readJson(path.join(debugDirectory, "hypothesis-ledger.json"));
    const debugBundle = await readJson(path.join(debugDirectory, "debug-bundle.json"));

    assert.equal(result.summary.terminalSummary.state, "blocked");
    assert.equal(terminalSummary.state, "blocked");
    assert.equal(terminalSummary.reasonCode, "runtime_unavailable");
    assert.equal(checkpoint.checkpointStatus, "halted");
    assert.equal(checkpoint.resume.mode, "manual");
    assert.ok(hypothesisLedger.entries.some((entry) => entry.id === "runtime_unavailable"));
    assert.equal(debugBundle.terminalState, "blocked");
    assert.equal(debugBundle.terminalSummaryPath, path.join(debugDirectory, "terminal-summary.json"));
  });

  await runTest("autonomous loop records exhausted terminal summaries with immediate resume guidance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-debug-exhausted-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-debug-exhausted-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");

    await writeJson(doctorReportPath, { checks: [] });
    await mkdir(path.dirname(handoffIndexPath), { recursive: true });
    await writeJson(handoffIndexPath, {
      generatedAt: new Date().toISOString(),
      runId: "autonomous-debug-exhausted-run",
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
        dispatchHandoffs: async () => ({
          summary: {
            executed: 1,
            completed: 0,
            continued: 0,
            incomplete: 1,
            failed: 0,
            skipped: 0
          },
          resultJsonPath: path.join(tempDir, "handoffs", "dispatch-results.json"),
          resultMarkdownPath: path.join(tempDir, "handoffs", "dispatch-results.md"),
          results: []
        })
      }
    });

    const debugDirectory = path.join(path.dirname(runResult.statePath), "artifacts", "autonomous-debug");
    const terminalSummary = await readJson(path.join(debugDirectory, "terminal-summary.json"));
    const checkpoint = await readJson(path.join(debugDirectory, "checkpoint.json"));

    assert.equal(result.summary.terminalSummary.state, "exhausted");
    assert.equal(result.summary.stopReason, "maximum rounds reached");
    assert.equal(terminalSummary.state, "exhausted");
    assert.equal(terminalSummary.reasonCode, "max_rounds_reached");
    assert.equal(checkpoint.resume.canResume, true);
    assert.equal(checkpoint.resume.mode, "immediate");
  });

  await runTest("autonomous loop persists failed checkpoints and debug evidence when the loop throws", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-debug-error-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-debug-error-run");

    await assert.rejects(
      () =>
        runAutonomousLoop(runResult.statePath, {
          maxRounds: 1,
          operations: {
            runRuntimeDoctor: async () => {
              throw new Error("Injected doctor failure");
            }
          }
        }),
      /Injected doctor failure/
    );

    const debugDirectory = path.join(path.dirname(runResult.statePath), "artifacts", "autonomous-debug");
    const terminalSummary = await readJson(path.join(debugDirectory, "terminal-summary.json"));
    const checkpoint = await readJson(path.join(debugDirectory, "checkpoint.json"));
    const debugBundle = await readJson(path.join(debugDirectory, "debug-bundle.json"));

    assert.equal(terminalSummary.reasonCode, "autonomous_error");
    assert.equal(checkpoint.checkpointStatus, "failed");
    assert.match(checkpoint.errorMessage ?? "", /Injected doctor failure/);
    assert.equal(debugBundle.terminalState, terminalSummary.state);
  });

  await runTest("autonomous loop stops safely when the session watchdog expires", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-watchdog-timeout-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-watchdog-timeout-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const previousWatchdogTimeout = process.env.AI_FACTORY_AUTONOMOUS_WATCHDOG_TIMEOUT_MS;
    let tickCalls = 0;

    process.env.AI_FACTORY_AUTONOMOUS_WATCHDOG_TIMEOUT_MS = "10";

    try {
      const result = await runAutonomousLoop(runResult.statePath, {
        maxRounds: 5,
        operations: {
          runRuntimeDoctor: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            await writeJson(doctorReportPath, { checks: [] });
            return { jsonPath: doctorReportPath };
          },
          tickProjectRun: async () => {
            tickCalls += 1;
            return {
              handoffIndexPath: path.join(tempDir, "handoffs", "index.json"),
              readyTaskCount: 1
            };
          },
          dispatchHandoffs: async () => {
            throw new Error("dispatchHandoffs should not run after the watchdog expires");
          }
        }
      });

      const nextRunState = await readJson(runResult.statePath);
      const planningTask = nextRunState.taskLedger.find((task) => task.id === "planning-brief");

      assert.equal(tickCalls, 0);
      assert.equal(result.summary.finalStatus, "attention_required");
      assert.equal(result.summary.terminalState, "blocked");
      assert.equal(result.summary.failureTaxonomy.stopCategory, "timeout");
      assert.match(result.summary.stopReason ?? "", /watchdog timeout/i);
      assert.equal(result.summary.watchdog.triggered, true);
      assert.equal(result.summary.watchdog.lastEvent, "watchdog_timeout");
      assert.equal(result.summary.watchdog.expired, true);
      assert.equal(planningTask?.status, "blocked");
      assert.ok(
        (planningTask?.notes ?? []).some((note) => /autonomous-watchdog-timeout:/i.test(note)),
        "planning task should record the watchdog timeout"
      );
    } finally {
      if (previousWatchdogTimeout === undefined) {
        delete process.env.AI_FACTORY_AUTONOMOUS_WATCHDOG_TIMEOUT_MS;
      } else {
        process.env.AI_FACTORY_AUTONOMOUS_WATCHDOG_TIMEOUT_MS = previousWatchdogTimeout;
      }
    }
  });

  await runTest("autonomous watchdog does not override a run that completed during tick", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-watchdog-complete-"));
    const runResult = await runProject(validSpecPath, tempDir, "autonomous-watchdog-complete-run");
    const doctorReportPath = path.join(tempDir, "doctor.json");
    const handoffIndexPath = path.join(tempDir, "handoffs", "index.json");
    const previousWatchdogTimeout = process.env.AI_FACTORY_AUTONOMOUS_WATCHDOG_TIMEOUT_MS;
    let tickCalls = 0;

    process.env.AI_FACTORY_AUTONOMOUS_WATCHDOG_TIMEOUT_MS = "10";

    try {
      const result = await runAutonomousLoop(runResult.statePath, {
        maxRounds: 5,
        operations: {
          runRuntimeDoctor: async () => {
            await writeJson(doctorReportPath, { checks: [] });
            return { jsonPath: doctorReportPath };
          },
          tickProjectRun: async () => {
            tickCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
            const currentRunState = refreshRunState(await readJson(runResult.statePath));
            const completedRunState = refreshRunState({
              ...currentRunState,
              taskLedger: currentRunState.taskLedger.map((task) => ({
                ...task,
                status: "completed"
              }))
            });

            await writeJson(runResult.statePath, completedRunState);

            return {
              handoffIndexPath,
              readyTaskCount: 0
            };
          },
          dispatchHandoffs: async () => {
            throw new Error("dispatchHandoffs should not run after tick completes the run");
          }
        }
      });

      assert.equal(tickCalls, 1);
      assert.equal(result.summary.finalStatus, "completed");
      assert.equal(result.summary.terminalState, "done");
      assert.equal(result.summary.stopReason, "run completed");
      assert.equal(result.summary.terminalSummary.reasonCode, "completed");
      assert.equal(result.summary.watchdog.lastEvent, null);
    } finally {
      if (previousWatchdogTimeout === undefined) {
        delete process.env.AI_FACTORY_AUTONOMOUS_WATCHDOG_TIMEOUT_MS;
      } else {
        process.env.AI_FACTORY_AUTONOMOUS_WATCHDOG_TIMEOUT_MS = previousWatchdogTimeout;
      }
    }
  });

  console.log("Autonomous run tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
