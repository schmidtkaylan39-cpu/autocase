import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyEscalatedModelDegradeToRunState,
  configureAttemptWorkspace,
  classifyFailureCategory,
  computeRetryBackoffMs,
  extractDegradedNoProgressDiagnostics,
  extractExternalOutageDiagnostics,
  extractOrphanedExecutionLockDiagnostics,
  inspectAutonomousOrphanedExecutionLock,
  parseArgs,
  runPlannerRuntimePreflight,
  runNodeStep
} from "../scripts/live-roundtrip-acceptance.mjs";

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
  await runTest("parseArgs keeps maxAttempts at least required successes", async () => {
    const parsed = parseArgs(["--successes", "4", "--max-attempts", "2"]);
    assert.equal(parsed.successes, 4);
    assert.equal(parsed.maxAttempts, 4);
  });

  await runTest("parseArgs accepts guardrail settings", async () => {
    const parsed = parseArgs([
      "--step-timeout-ms",
      "1111",
      "--step-stall-timeout-ms",
      "2222",
      "--attempt-timeout-ms",
      "3333",
      "--overall-timeout-ms",
      "4444",
      "--heartbeat-ms",
      "5555",
      "--retry-backoff-base-ms",
      "6666",
      "--retry-backoff-max-ms",
      "7777",
      "--retry-circuit-failures",
      "8"
    ]);

    assert.equal(parsed.stepTimeoutMs, 1111);
    assert.equal(parsed.stepStallTimeoutMs, 2222);
    assert.equal(parsed.attemptTimeoutMs, 3333);
    assert.equal(parsed.overallTimeoutMs, 4444);
    assert.equal(parsed.heartbeatMs, 5555);
    assert.equal(parsed.retryBackoffBaseMs, 6666);
    assert.equal(parsed.retryBackoffMaxMs, 7777);
    assert.equal(parsed.retryCircuitFailures, 8);
  });

  await runTest("configureAttemptWorkspace keeps verifier injection and conservative acceptance guardrails", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-acceptance-workspace-"));
    const configRoot = path.join(workspaceRoot, "config");
    const originalEscalation = {
      minimumRetryCount: 4,
      minimumAttempts: 5,
      escalateOnAttentionRequired: true,
      escalateOnBlockedHistory: false,
      escalateOnDispatchFailure: true,
      forceProTaskIds: ["delivery-package"],
      forceProTaskPatterns: ["risk", "artifact"]
    };

    await mkdir(configRoot, { recursive: true });
    await writeFile(
      path.join(configRoot, "factory.config.json"),
      `${JSON.stringify(
        {
          retryPolicy: {
            implementation: 9,
            review: 7,
            verification: 5,
            replanning: 4,
            hybridSurface: {
              maxAttempts: 3,
              retryDelayMinutes: 3,
              unlockAfterMinutes: 30
            }
          },
          modelPolicy: {
            escalation: originalEscalation
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await configureAttemptWorkspace(workspaceRoot, 1);

    const packageJson = JSON.parse(await readFile(path.join(workspaceRoot, "package.json"), "utf8"));
    const verifierScript = await readFile(path.join(workspaceRoot, "scripts", "verify-summary.mjs"), "utf8");
    const factoryConfig = JSON.parse(
      await readFile(path.join(workspaceRoot, "config", "factory.config.json"), "utf8")
    );

    assert.equal(packageJson.scripts.test, "node scripts/verify-summary.mjs");
    assert.equal(packageJson.scripts["test:integration"], "node scripts/verify-summary.mjs");
    assert.equal(packageJson.scripts["test:e2e"], "node scripts/verify-summary.mjs");
    assert.match(verifierScript, /"artifacts", "generated", "summary\.md"/);
    assert.match(verifierScript, /"data", "brief\.txt"/);
    assert.match(verifierScript, /"data", "details\.txt"/);
    assert.match(verifierScript, /# Combined Notes/);
    assert.match(verifierScript, /\\p\{Script=Han\}/);
    assert.deepEqual(factoryConfig.retryPolicy, {
      implementation: 3,
      review: 2,
      verification: 2,
      replanning: 2,
      hybridSurface: {
        maxAttempts: 3,
        retryDelayMinutes: 3,
        unlockAfterMinutes: 30
      }
    });
    assert.deepEqual(factoryConfig.modelPolicy?.escalation, originalEscalation);
  });

  await runTest("planner preflight fails fast when planner routing is non-automated", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-preflight-manual-"));
    const runStatePath = path.join(workspaceRoot, "run-state.json");
    const doctorReportPath = path.join(workspaceRoot, "runtime-doctor.json");

    await writeFile(
      runStatePath,
      `${JSON.stringify(
        {
          runtimeRouting: {
            roleOverrides: {
              planner: ["manual"]
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      doctorReportPath,
      `${JSON.stringify(
        {
          checks: [
            { id: "gpt-runner", installed: true, ok: true }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await assert.rejects(
      () =>
        runPlannerRuntimePreflight({
          workspaceRoot,
          runStatePath,
          doctorReportPath,
          factoryConfig: {}
        }),
      /selected runtime "manual".*runtime was not available/i
    );
  });

  await runTest("planner preflight probes gpt-runner default and escalated planner models when autoSwitch is enabled", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-preflight-gpt-runner-"));
    const runStatePath = path.join(workspaceRoot, "run-state.json");
    const doctorReportPath = path.join(workspaceRoot, "runtime-doctor.json");
    const probeCalls = [];

    await writeFile(runStatePath, `${JSON.stringify({}, null, 2)}\n`, "utf8");
    await writeFile(
      doctorReportPath,
      `${JSON.stringify(
        {
          checks: [
            { id: "gpt-runner", installed: true, ok: true }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const preflight = await runPlannerRuntimePreflight({
      workspaceRoot,
      runStatePath,
      doctorReportPath,
      factoryConfig: {
        modelPolicy: {
          planner: {
            defaultModel: "gpt-5.4",
            escalatedModel: "gpt-5.4-pro",
            autoSwitch: true
          }
        }
      },
      probeGptRunner: async (probeOptions) => {
        probeCalls.push(probeOptions);
      }
    });

    assert.equal(preflight.runtimeId, "gpt-runner");
    assert.equal(probeCalls.length, 2);
    assert.equal(probeCalls[0].modelId, "gpt-5.4");
    assert.equal(probeCalls[1].modelId, "gpt-5.4-pro");
    assert.equal(probeCalls[0].workspaceRoot, workspaceRoot);
    assert.equal(probeCalls[1].workspaceRoot, workspaceRoot);
  });

  await runTest("planner preflight degrades to default model when escalated model probe fails", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-preflight-degrade-"));
    const runStatePath = path.join(workspaceRoot, "run-state.json");
    const doctorReportPath = path.join(workspaceRoot, "runtime-doctor.json");
    const probeCalls = [];

    await writeFile(runStatePath, `${JSON.stringify({}, null, 2)}\n`, "utf8");
    await writeFile(
      doctorReportPath,
      `${JSON.stringify(
        {
          checks: [
            { id: "gpt-runner", installed: true, ok: true }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const preflight = await runPlannerRuntimePreflight({
      workspaceRoot,
      runStatePath,
      doctorReportPath,
      factoryConfig: {
        modelPolicy: {
          planner: {
            defaultModel: "gpt-5.4",
            escalatedModel: "gpt-5.4-pro",
            autoSwitch: true
          }
        }
      },
      probeGptRunner: async ({ modelId }) => {
        probeCalls.push(modelId);

        if (modelId === "gpt-5.4-pro") {
          throw new Error("simulated 503 Service Unavailable for escalated model");
        }
      },
      allowEscalatedModelDegrade: true
    });

    assert.deepEqual(probeCalls, ["gpt-5.4", "gpt-5.4-pro"]);
    assert.equal(preflight.degraded, true);
    assert.equal(preflight.fallbackModelId, "gpt-5.4");
    assert.deepEqual(preflight.degradedModels, ["gpt-5.4-pro"]);
    assert.deepEqual(preflight.degradedRoles, ["planner", "reviewer", "orchestrator"]);
    assert.match(preflight.degradeReason ?? "", /503/i);
  });

  await runTest("planner preflight still fails when the default model probe fails", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-preflight-default-fail-"));
    const runStatePath = path.join(workspaceRoot, "run-state.json");
    const doctorReportPath = path.join(workspaceRoot, "runtime-doctor.json");

    await writeFile(runStatePath, `${JSON.stringify({}, null, 2)}\n`, "utf8");
    await writeFile(
      doctorReportPath,
      `${JSON.stringify(
        {
          checks: [
            { id: "gpt-runner", installed: true, ok: true }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await assert.rejects(
      () =>
        runPlannerRuntimePreflight({
          workspaceRoot,
          runStatePath,
          doctorReportPath,
          factoryConfig: {
            modelPolicy: {
              planner: {
                defaultModel: "gpt-5.4",
                escalatedModel: "gpt-5.4-pro",
                autoSwitch: true
              }
            }
          },
          probeGptRunner: async () => {
            throw new Error("simulated default-model outage");
          },
          allowEscalatedModelDegrade: true
        }),
      /default-model outage/i
    );
  });

  await runTest("run-state model policy is downgraded when escalated model preflight degrades", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-preflight-runstate-degrade-"));
    const runStatePath = path.join(workspaceRoot, "run-state.json");
    const initialState = {
      runId: "degrade-run",
      updatedAt: new Date().toISOString(),
      modelPolicy: {
        planner: {
          defaultModel: "gpt-5.4",
          escalatedModel: "gpt-5.4-pro",
          autoSwitch: true
        },
        reviewer: {
          defaultModel: "gpt-5.4",
          escalatedModel: "gpt-5.4-pro",
          autoSwitch: true
        },
        orchestrator: {
          defaultModel: "gpt-5.4",
          escalatedModel: "gpt-5.4-pro",
          autoSwitch: true
        }
      },
      taskLedger: [
        { id: "planning-brief", role: "planner", status: "ready", notes: [] },
        { id: "review-spec-intake", role: "reviewer", status: "pending", notes: [] },
        { id: "delivery-package", role: "orchestrator", status: "pending", notes: [] }
      ]
    };

    await writeFile(runStatePath, `${JSON.stringify(initialState, null, 2)}\n`, "utf8");

    const result = await applyEscalatedModelDegradeToRunState({
      runStatePath,
      fallbackModelId: "gpt-5.4",
      reason: "simulated gpt-5.4-pro outage",
      roles: ["planner", "reviewer", "orchestrator"]
    });
    const nextState = JSON.parse(await readFile(runStatePath, "utf8"));

    assert.equal(result.changed, true);
    assert.equal(nextState.modelPolicy.planner.autoSwitch, false);
    assert.equal(nextState.modelPolicy.planner.escalatedModel, "gpt-5.4");
    assert.equal(nextState.modelPolicy.reviewer.autoSwitch, false);
    assert.equal(nextState.modelPolicy.reviewer.escalatedModel, "gpt-5.4");
    assert.equal(nextState.modelPolicy.orchestrator.autoSwitch, false);
    assert.equal(nextState.modelPolicy.orchestrator.escalatedModel, "gpt-5.4");
    assert.ok(
      nextState.taskLedger.every((task) =>
        Array.isArray(task.notes) && task.notes.some((note) => /acceptance-model-degrade:/i.test(note))
      )
    );
  });

  await runTest("computeRetryBackoffMs uses cap for larger failure counts", async () => {
    const delayMs = computeRetryBackoffMs({
      failureCount: 3,
      baseMs: 1000,
      maxMs: 2500
    });

    assert.equal(delayMs, 2500);
  });

  await runTest("classifyFailureCategory recognizes timeout and upstream outages", async () => {
    assert.equal(
      classifyFailureCategory("step stalled after 180s without activity"),
      "timeout"
    );
    assert.equal(
      classifyFailureCategory("Planner probe failed: unexpected status 502 Bad Gateway"),
      "external_upstream_outage"
    );
    assert.equal(
      classifyFailureCategory("stream disconnected while calling /responses endpoint"),
      "external_upstream_outage"
    );
  });

  await runTest("extractExternalOutageDiagnostics parses upstream status, host, and request id", async () => {
    const diagnostics = extractExternalOutageDiagnostics(
      "Planner runtime preflight probe failed: unexpected status 503 Service Unavailable. " +
        "url: https://api.tokenrouter.shop/responses request id: req_abc123 stream disconnected",
      "gpt-runner"
    );

    assert.ok(diagnostics);
    assert.equal(diagnostics.category, "external_upstream_outage");
    assert.equal(diagnostics.runtimeId, "gpt-runner");
    assert.equal(diagnostics.httpStatus, 503);
    assert.equal(diagnostics.upstreamUrl, "https://api.tokenrouter.shop/responses");
    assert.equal(diagnostics.upstreamHost, "api.tokenrouter.shop");
    assert.equal(diagnostics.requestId, "req_abc123");
  });

  await runTest("extractDegradedNoProgressDiagnostics classifies degraded autonomous terminal state from artifacts", async () => {
    const diagnostics = extractDegradedNoProgressDiagnostics({
      reason: "run did not complete before artifact verification",
      runState: {
        taskLedger: [
          {
            id: "planning-brief",
            notes: ["2026-04-20T00:00:00.000Z acceptance-model-degrade: switched to gpt-5.4"]
          }
        ]
      },
      autonomousSummary: {
        stopReason:
          "autonomous no-progress circuit opened after 2 consecutive cycles; lastProgressTaskId=planning-brief",
        progressDiagnostics: {
          lastProgressAt: "2026-04-20T00:00:00.000Z",
          lastProgressTaskId: "planning-brief",
          lastProgressEvent: "task_completed",
          consecutiveNoProgressCycles: 2,
          blockedTaskIds: ["implement-local-file-summary"],
          waitingRetryTaskIds: [],
          skippedAutomaticTaskIds: [],
          degradedRuntimeActive: true
        }
      }
    });

    assert.ok(diagnostics);
    assert.equal(diagnostics.category, "degraded_no_progress");
    assert.equal(diagnostics.degradedRuntimeActive, true);
    assert.equal(diagnostics.lastProgressTaskId, "planning-brief");
    assert.deepEqual(diagnostics.blockedTaskIds, ["implement-local-file-summary"]);
    assert.equal(
      classifyFailureCategory(`autonomous no-progress circuit opened: ${diagnostics.stopReason}`),
      "degraded_no_progress"
    );
  });

  await runTest("extractOrphanedExecutionLockDiagnostics classifies dead execution locks as logic bugs", async () => {
    const diagnostics = extractOrphanedExecutionLockDiagnostics({
      reason:
        'Step failed: 05-autonomous\nreason=orphaned_execution_lock: in-progress task planning-brief ' +
        'is pinned by dead execution lock pid=17156 ' +
        'path="C:\\temp\\planning-brief.result.json.execute.lock" while autonomous recorded no progress ' +
        '(rounds=0 lastProgressTaskId=unknown lastProgressEvent=unknown).'
    });

    assert.ok(diagnostics);
    assert.equal(diagnostics.category, "logic_bug");
    assert.equal(diagnostics.failureKind, "orphaned_execution_lock");
    assert.equal(diagnostics.taskId, "planning-brief");
    assert.equal(diagnostics.lockPid, 17156);
    assert.equal(
      diagnostics.lockPath,
      "C:\\temp\\planning-brief.result.json.execute.lock"
    );
    assert.equal(classifyFailureCategory("orphaned_execution_lock: planner handoff is stuck"), "logic_bug");
  });

  await runTest("runNodeStep enforces hard step timeout", async () => {
    const logDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-step-timeout-"));

    await assert.rejects(
      () =>
        runNodeStep("timeout-step", ["-e", "setInterval(() => {}, 1000);"], {
          env: { ...process.env },
          logDirectory,
          stepTimeoutMs: 300,
          stallTimeoutMs: 60_000,
          heartbeatMs: 100
        }),
      /timed out/i
    );
  });

  await runTest("runNodeStep terminates promptly when autonomous is pinned by an orphaned execution lock", async () => {
    const logDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-step-orphaned-lock-"));
    const attemptRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-attempt-orphaned-lock-"));
    const runRoot = path.join(attemptRoot, "runs", "live-roundtrip-01");
    const runStatePath = path.join(runRoot, "run-state.json");
    const autonomousSummaryPath = path.join(runRoot, "autonomous-summary.json");
    const resultPath = path.join(runRoot, "handoffs-autonomous", "results", "planning-brief.result.json");
    const executionLockPath = `${resultPath}.execute.lock`;

    await mkdir(path.dirname(executionLockPath), { recursive: true });
    await writeFile(
      runStatePath,
      `${JSON.stringify(
        {
          status: "in_progress",
          taskLedger: [
            {
              id: "planning-brief",
              status: "in_progress",
              activeResultPath: resultPath
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      autonomousSummaryPath,
      `${JSON.stringify(
        {
          finalStatus: "planned",
          rounds: [],
          progressDiagnostics: {
            lastProgressAt: null,
            lastProgressTaskId: null,
            lastProgressEvent: null
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(executionLockPath, `999999 ${new Date().toISOString()}\n`, "utf8");

    await assert.rejects(
      () =>
        runNodeStep("05-autonomous", ["-e", "setInterval(() => {}, 1000);"], {
          env: { ...process.env },
          logDirectory,
          stepTimeoutMs: 30_000,
          stallTimeoutMs: 30_000,
          heartbeatMs: 100,
          watchActivityPaths: [runStatePath, autonomousSummaryPath],
          monitorStep: async ({ idleMs }) => {
            const diagnostics = await inspectAutonomousOrphanedExecutionLock({
              runStatePath,
              autonomousSummaryPath,
              idleMs,
              minimumIdleMs: 150
            });

            return diagnostics
              ? {
                  terminationReason: diagnostics.reason
                }
              : null;
          }
        }),
      /orphaned_execution_lock/i
    );
  });

  await runTest("runNodeStep enforces stall timeout when no activity appears", async () => {
    const logDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-step-stall-"));

    await assert.rejects(
      () =>
        runNodeStep("stall-step", ["-e", "setTimeout(() => process.exit(0), 10_000);"], {
          env: { ...process.env },
          logDirectory,
          stepTimeoutMs: 30_000,
          stallTimeoutMs: 300,
          heartbeatMs: 100
        }),
      /stalled/i
    );
  });

  await runTest("runNodeStep treats watched file updates as activity", async () => {
    const logDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-factory-live-step-watch-"));
    const pulsePath = path.join(logDirectory, "pulse.txt");
    await writeFile(pulsePath, "start\n", "utf8");

    const result = await runNodeStep(
      "watch-activity-step",
      [
        "-e",
        "const fs=require('node:fs');const pulse=process.argv[1];let count=0;const timer=setInterval(()=>{fs.writeFileSync(pulse,String(Date.now()));count+=1;if(count>=6){clearInterval(timer);process.exit(0);}},80);",
        pulsePath
      ],
      {
        env: { ...process.env },
        logDirectory,
        stepTimeoutMs: 10_000,
        stallTimeoutMs: 250,
        heartbeatMs: 100,
        watchActivityPaths: [pulsePath]
      }
    );

    assert.equal(result.exitCode, 0);
  });

  console.log("Live roundtrip acceptance tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
