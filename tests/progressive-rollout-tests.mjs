import assert from "node:assert/strict";

import {
  evaluatePhaseSlo,
  parseArgs,
  parsePhaseSpec,
  runProgressiveRollout
} from "../scripts/progressive-rollout.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function createCommandResult(commandLine, exitCode, overrides = {}) {
  return {
    commandLine,
    startedAt: overrides.startedAt ?? "2026-04-19T00:00:00.000Z",
    finishedAt: overrides.finishedAt ?? "2026-04-19T00:00:01.000Z",
    durationMs: overrides.durationMs ?? 1_000,
    exitCode,
    signal: overrides.signal ?? null,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? ""
  };
}

function createExecuteStub(sequence) {
  const queue = [...sequence];
  const calls = [];

  return {
    calls,
    async executeCommand(commandLine, context) {
      const next = queue.shift();

      if (!next) {
        throw new Error(`Unexpected command invocation: ${commandLine}`);
      }

      calls.push({
        commandLine,
        ...context
      });

      return createCommandResult(commandLine, next.exitCode ?? 0, next);
    }
  };
}

async function main() {
  await runTest("parsePhaseSpec normalizes valid phase input", async () => {
    assert.deepEqual(parsePhaseSpec(" Canary : 5 : 2 "), {
      name: "canary",
      trafficPercent: 5,
      trials: 2
    });
  });

  await runTest("parsePhaseSpec rejects malformed and out-of-range values", async () => {
    assert.throws(
      () => parsePhaseSpec("canary:5"),
      /Invalid --phase value/i
    );
    assert.throws(
      () => parsePhaseSpec("canary:101:2"),
      /Must be 1\.\.100/i
    );
    assert.throws(
      () => parsePhaseSpec("canary:10:0"),
      /Invalid phase trials/i
    );
  });

  await runTest("parseArgs uses rollout defaults when no args or env overrides are provided", async () => {
    const options = parseArgs([], {});

    assert.equal(options.runCommand, "npm run selfcheck");
    assert.equal(options.rollbackCommand, null);
    assert.equal(options.minSuccessRate, 1);
    assert.equal(options.maxFailureCount, 0);
    assert.equal(options.maxConsecutiveFailures, 1);
    assert.equal(options.summaryFile, null);
    assert.deepEqual(options.phases, [
      { name: "canary", trafficPercent: 5, trials: 2 },
      { name: "ramp", trafficPercent: 20, trials: 3 },
      { name: "full", trafficPercent: 100, trials: 3 }
    ]);
  });

  await runTest("parseArgs merges env phases and lets cli flags override scalar options", async () => {
    const options = parseArgs(
      [
        "--run-command",
        "npm run acceptance:live",
        "--rollback-command",
        "npm run rollback:release",
        "--phase",
        "full:100:4",
        "--min-success-rate",
        "0.9",
        "--max-failure-count",
        "1",
        "--max-consecutive-failures",
        "0",
        "--summary-file",
        "reports/cli-rollout.json"
      ],
      {
        ROLLOUT_RUN_COMMAND: "npm run selfcheck",
        ROLLOUT_ROLLBACK_COMMAND: "npm run rollback:env",
        ROLLOUT_PHASES: "canary:10:2,ramp:50:3",
        ROLLOUT_MIN_SUCCESS_RATE: "0.75",
        ROLLOUT_MAX_FAILURE_COUNT: "2",
        ROLLOUT_MAX_CONSECUTIVE_FAILURES: "2",
        ROLLOUT_SUMMARY_FILE: "reports/env-rollout.json"
      }
    );

    assert.equal(options.runCommand, "npm run acceptance:live");
    assert.equal(options.rollbackCommand, "npm run rollback:release");
    assert.equal(options.minSuccessRate, 0.9);
    assert.equal(options.maxFailureCount, 1);
    assert.equal(options.maxConsecutiveFailures, 0);
    assert.equal(options.summaryFile, "reports/cli-rollout.json");
    assert.deepEqual(options.phases, [
      { name: "canary", trafficPercent: 10, trials: 2 },
      { name: "ramp", trafficPercent: 50, trials: 3 },
      { name: "full", trafficPercent: 100, trials: 4 }
    ]);
  });

  await runTest("parseArgs rejects unknown flags and decreasing phase order", async () => {
    assert.throws(
      () => parseArgs(["--unknown"], {}),
      /Unknown option/i
    );
    assert.throws(
      () => parseArgs(["--phase", "ramp:50:2", "--phase", "canary:5:1"], {}),
      /non-decreasing trafficPercent/i
    );
  });

  await runTest("evaluatePhaseSlo keeps a phase alive when the target is still reachable", async () => {
    const evaluation = evaluatePhaseSlo({
      attempts: 1,
      successes: 0,
      failures: 1,
      consecutiveFailures: 1,
      remainingTrials: 4,
      minSuccessRate: 0.5,
      maxFailureCount: 2,
      maxConsecutiveFailures: 2
    });

    assert.equal(evaluation.breached, false);
    assert.deepEqual(evaluation.reasons, []);
    assert.equal(evaluation.metrics.successRate, 0);
    assert.equal(evaluation.metrics.maxPossibleSuccessRate, 0.8);
  });

  await runTest("evaluatePhaseSlo reports failure-count, consecutive-failure, and unreachable-rate breaches", async () => {
    const failureCountBreach = evaluatePhaseSlo({
      attempts: 2,
      successes: 1,
      failures: 2,
      consecutiveFailures: 1,
      remainingTrials: 1,
      minSuccessRate: 0.5,
      maxFailureCount: 1,
      maxConsecutiveFailures: 2
    });
    const consecutiveFailureBreach = evaluatePhaseSlo({
      attempts: 3,
      successes: 1,
      failures: 2,
      consecutiveFailures: 2,
      remainingTrials: 1,
      minSuccessRate: 0.5,
      maxFailureCount: 3,
      maxConsecutiveFailures: 1
    });
    const unreachableRateBreach = evaluatePhaseSlo({
      attempts: 2,
      successes: 0,
      failures: 2,
      consecutiveFailures: 2,
      remainingTrials: 1,
      minSuccessRate: 0.75,
      maxFailureCount: 5,
      maxConsecutiveFailures: 5
    });

    assert.equal(failureCountBreach.breached, true);
    assert.match(failureCountBreach.reasons.join("\n"), /failure count 2 exceeded maxFailureCount 1/i);

    assert.equal(consecutiveFailureBreach.breached, true);
    assert.match(
      consecutiveFailureBreach.reasons.join("\n"),
      /consecutive failures 2 exceeded maxConsecutiveFailures 1/i
    );

    assert.equal(unreachableRateBreach.breached, true);
    assert.match(unreachableRateBreach.reasons.join("\n"), /success rate target is no longer reachable/i);
    assert.equal(unreachableRateBreach.metrics.maxPossibleSuccessRate, 1 / 3);
  });

  await runTest("runProgressiveRollout promotes all phases on a clean rollout", async () => {
    const config = {
      runCommand: "npm run acceptance:live",
      rollbackCommand: "npm run rollback:release",
      phases: [
        { name: "canary", trafficPercent: 5, trials: 2 },
        { name: "full", trafficPercent: 100, trials: 1 }
      ],
      minSuccessRate: 1,
      maxFailureCount: 0,
      maxConsecutiveFailures: 0
    };
    const env = { ROLLOUT_TEST: "1" };
    const cwd = "C:\\rollout-fixture";
    const { calls, executeCommand } = createExecuteStub([
      { exitCode: 0, stdout: "canary pass 1" },
      { exitCode: 0, stdout: "canary pass 2" },
      { exitCode: 0, stdout: "full pass 1" }
    ]);

    const summary = await runProgressiveRollout(config, {
      executeCommand,
      cwd,
      env
    });

    assert.equal(summary.status, "passed");
    assert.equal(summary.failedPhase, null);
    assert.equal(summary.promotedTrafficPercent, 100);
    assert.equal(summary.rollback, null);
    assert.equal(summary.phases.length, 2);
    assert.equal(summary.phases[0].status, "passed");
    assert.equal(summary.phases[0].attempts, 2);
    assert.equal(summary.phases[0].logs[0]?.status, "passed");
    assert.equal(summary.phases[1].status, "passed");
    assert.equal(summary.phases[1].attempts, 1);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].cwd, cwd);
    assert.equal(calls[0].env, env);
    assert.deepEqual(
      calls.map((call) => ({
        commandLine: call.commandLine,
        phase: call.phase.name,
        attemptNumber: call.attemptNumber,
        commandType: call.commandType
      })),
      [
        {
          commandLine: "npm run acceptance:live",
          phase: "canary",
          attemptNumber: 1,
          commandType: "run"
        },
        {
          commandLine: "npm run acceptance:live",
          phase: "canary",
          attemptNumber: 2,
          commandType: "run"
        },
        {
          commandLine: "npm run acceptance:live",
          phase: "full",
          attemptNumber: 1,
          commandType: "run"
        }
      ]
    );
  });

  await runTest("runProgressiveRollout stops on SLO breach and triggers rollback once", async () => {
    const config = {
      runCommand: "npm run test:e2e",
      rollbackCommand: "npm run rollback:release",
      phases: [
        { name: "canary", trafficPercent: 5, trials: 1 },
        { name: "ramp", trafficPercent: 25, trials: 3 },
        { name: "full", trafficPercent: 100, trials: 1 }
      ],
      minSuccessRate: 1,
      maxFailureCount: 0,
      maxConsecutiveFailures: 0
    };
    const { calls, executeCommand } = createExecuteStub([
      { exitCode: 0, stdout: "canary ok" },
      { exitCode: 1, stderr: "ramp failed" },
      { exitCode: 0, stdout: "rollback ok" }
    ]);

    const summary = await runProgressiveRollout(config, { executeCommand });

    assert.equal(summary.status, "failed");
    assert.equal(summary.failedPhase, "ramp");
    assert.equal(summary.promotedTrafficPercent, 5);
    assert.equal(summary.phases.length, 2);
    assert.equal(summary.phases[0].status, "passed");
    assert.equal(summary.phases[1].status, "failed");
    assert.equal(summary.phases[1].attempts, 1);
    assert.equal(summary.phases[1].failures, 1);
    assert.match(summary.phases[1].sloBreachReasons.join("\n"), /failure count|consecutive failures/i);
    assert.deepEqual(
      calls.map((call) => ({
        commandLine: call.commandLine,
        phase: call.phase.name,
        attemptNumber: call.attemptNumber ?? null,
        commandType: call.commandType
      })),
      [
        {
          commandLine: "npm run test:e2e",
          phase: "canary",
          attemptNumber: 1,
          commandType: "run"
        },
        {
          commandLine: "npm run test:e2e",
          phase: "ramp",
          attemptNumber: 1,
          commandType: "run"
        },
        {
          commandLine: "npm run rollback:release",
          phase: "ramp",
          attemptNumber: null,
          commandType: "rollback"
        }
      ]
    );
    assert.equal(summary.rollback?.status, "passed");
    assert.equal(summary.rollback?.commandLine, "npm run rollback:release");
    assert.equal(summary.rollback?.stdout, "rollback ok");
  });

  console.log("Progressive rollout tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
