import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validSpecPath = path.join(projectRoot, "examples", "project-spec.valid.json");
const defaultLauncherTimeoutMs = 300000;

async function runNode(args, options = {}) {
  const result = await execFileAsync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8",
    ...options
  });

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function createFakeCodexBinary(binDir) {
  await mkdir(binDir, { recursive: true });
  const fakeNodeScriptPath = path.join(binDir, "fake-codex.mjs");

  await writeFile(
    fakeNodeScriptPath,
    [
      'import { mkdir, readFile, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      "",
      "const args = process.argv.slice(2);",
      "",
      'if (args.includes("--help")) {',
      '  console.log("fake codex help");',
      "  process.exit(0);",
      "}",
      "",
      'if (args[0] === "login" && args[1] === "status") {',
      '  console.log("Authenticated as fake-codex");',
      "  process.exit(0);",
      "}",
      "",
      "const statePath = process.env.AI_FACTORY_FAKE_CODEX_STATE;",
      'const faultMode = String(process.env.AI_FACTORY_FAKE_CODEX_FAULT ?? "none").toLowerCase();',
      "const timeoutMs = Number.parseInt(process.env.AI_FACTORY_FAKE_CODEX_TIMEOUT_MS ?? \"1500\", 10);",
      "",
      "async function readState() {",
      "  if (!statePath) {",
      "    return {};",
      "  }",
      "",
      "  try {",
      "    return JSON.parse(await readFile(statePath, \"utf8\"));",
      "  } catch {",
      "    return {};",
      "  }",
      "}",
      "",
      "async function writeState(nextState) {",
      "  if (!statePath) {",
      "    return;",
      "  }",
      "",
      "  await mkdir(path.dirname(statePath), { recursive: true });",
      "  await writeFile(statePath, JSON.stringify(nextState, null, 2), \"utf8\");",
      "}",
      "",
      "let promptText = \"\";",
      "for await (const chunk of process.stdin) {",
      "  promptText += chunk;",
      "}",
      "",
      "const resultPath = promptText.match(/Write a JSON file to this exact path when you finish: (.+)$/m)?.[1]?.trim();",
      "const runId = promptText.match(/^- runId: (.+)$/m)?.[1]?.trim();",
      "const taskId = promptText.match(/^- taskId: (.+)$/m)?.[1]?.trim();",
      "const handoffId = promptText.match(/^- handoffId: (.+)$/m)?.[1]?.trim();",
      "",
      "if (!resultPath || !runId || !taskId || !handoffId) {",
      '  console.error("fake codex could not parse the prompt contract");',
      "  process.exit(1);",
      "}",
      "",
      "const state = await readState();",
      "state.invocations = (state.invocations ?? 0) + 1;",
      "state.lastTaskId = taskId;",
      "",
      "const isReviewerTask = /^review-/.test(taskId);",
      "const injectTimeout = faultMode === \"timeout-once\" && state.timeoutInjected !== true && isReviewerTask;",
      "const injectTimeoutError = faultMode === \"timeout-error-once\" && state.timeoutErrorInjected !== true && isReviewerTask;",
      "const injectBadGateway = faultMode === \"bad-gateway-once\" && state.badGatewayInjected !== true && isReviewerTask;",
      "",
      "if (injectBadGateway) {",
      "  state.badGatewayInjected = true;",
      "  await writeState(state);",
      '  console.error("Injected 502 Bad Gateway from fake codex runtime");',
      "  process.exit(1);",
      "}",
      "",
      "if (injectTimeoutError) {",
      "  state.timeoutErrorInjected = true;",
      "  await writeState(state);",
      '  console.error("Injected timeout while waiting for upstream planner/reviewer surface");',
      "  process.exit(1);",
      "}",
      "",
      "await mkdir(path.dirname(resultPath), { recursive: true });",
      "await writeFile(",
      "  resultPath,",
      "  JSON.stringify(",
      "    {",
      "      runId,",
      "      taskId,",
      "      handoffId,",
      '      status: "completed",',
      '      summary: `fake codex completed ${taskId}`,',
      "      changedFiles: [],",
      '      verification: ["fake autonomous e2e codex"],',
      '      notes: ["simulated gpt-runner/codex launcher execution"]',
      "    },",
      "    null,",
      "    2",
      "  ),",
      '  "utf8"',
      ");",
      "",
      "if (injectTimeout) {",
      "  state.timeoutInjected = true;",
      "  await writeState(state);",
      "  await new Promise((resolve) => setTimeout(resolve, Number.isFinite(timeoutMs) ? timeoutMs : 1500));",
      "  process.exit(0);",
      "}",
      "",
      "await writeState(state);",
      'console.log(`fake codex completed ${taskId}`);'
    ].join("\n"),
    "utf8"
  );

  if (process.platform === "win32") {
    const fakeCommandPath = path.join(binDir, "codex.cmd");
    await writeFile(
      fakeCommandPath,
      `@echo off\r\nnode "%~dp0fake-codex.mjs" %*\r\n`,
      "utf8"
    );
    return fakeCommandPath;
  }

  const fakeCommandPath = path.join(binDir, "codex");
  await writeFile(
    fakeCommandPath,
    `#!/usr/bin/env sh\nnode "$(dirname "$0")/fake-codex.mjs" "$@"\n`,
    "utf8"
  );
  await chmod(fakeCommandPath, 0o755);

  return fakeCommandPath;
}

async function prepareWorkspace(workspaceRoot) {
  const specPath = path.join(workspaceRoot, "specs", "project-spec.json");
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const baseSpec = JSON.parse(await readFile(validSpecPath, "utf8"));
  const singleFeatureSpec = {
    ...baseSpec,
    coreFeatures: Array.isArray(baseSpec.coreFeatures) ? baseSpec.coreFeatures.slice(0, 1) : []
  };
  const packageJson = {
    name: "ai-factory-autonomous-e2e",
    private: true,
    version: "1.0.0",
    scripts: {
      build: 'node -e "console.log(\'build ok\')"',
      lint: 'node -e "console.log(\'lint ok\')"',
      typecheck: 'node -e "console.log(\'typecheck ok\')"',
      test: 'node -e "console.log(\'test ok\')"',
      "test:integration": 'node -e "console.log(\'integration ok\')"',
      "test:e2e": 'node -e "console.log(\'fixture e2e ok\')"'
    }
  };

  await runNode(["src/index.mjs", "init", workspaceRoot]);
  await writeFile(specPath, `${JSON.stringify(singleFeatureSpec, null, 2)}\n`, "utf8");
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  return {
    specPath
  };
}

async function injectInterruptedPlannerClaim(runStatePath) {
  const runState = await readJson(runStatePath);
  const staleResultPath = path.join(
    path.dirname(runStatePath),
    "handoffs-autonomous",
    "results",
    "planning-brief.stale.result.json"
  );
  const staleLockPath = `${staleResultPath}.execute.lock`;
  const staleClaimTimestamp = new Date(Date.now() - 60000).toISOString();

  await mkdir(path.dirname(staleResultPath), { recursive: true });
  await writeFile(staleLockPath, `999999 ${new Date().toISOString()} stale-lock\n`, "utf8");

  const nextRunState = {
    ...runState,
    taskLedger: runState.taskLedger.map((task) =>
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
  };

  await writeJson(runStatePath, nextRunState);

  return {
    staleLockPath
  };
}

async function verifyScenario({
  scenario,
  runRoot,
  handoffResultsPath,
  fakeCodexStatePath,
  staleLockPath
}) {
  const runStatePath = path.join(runRoot, "run-state.json");
  const summaryPath = path.join(runRoot, "autonomous-summary.json");
  const reportPath = path.join(runRoot, "report.md");
  const runState = await readJson(runStatePath);
  const summary = await readJson(summaryPath);
  const report = await readFile(reportPath, "utf8");
  const finalDispatchResults = await readJson(handoffResultsPath);
  const doctorReport = await readJson(summary.doctorReportPath);
  const taskIds = runState.taskLedger.map((task) => task.id);
  const requiredRuntimeChecks = new Map(
    doctorReport.checks
      .filter((check) => check.requiredByDefaultRoute)
      .map((check) => [check.id, check.ok])
  );
  const fakeCodexState = await readJson(fakeCodexStatePath);

  assert.equal(runState.status, "completed", `${scenario.name}: run-state should complete`);
  assert.equal(summary.finalStatus, "completed", `${scenario.name}: autonomous summary should complete`);
  assert.equal(summary.stopReason, "run completed", `${scenario.name}: stop reason should be run completed`);
  assert.ok(runState.taskLedger.every((task) => task.status === "completed"), `${scenario.name}: all tasks should complete`);
  assert.deepEqual(taskIds, [
    "planning-brief",
    "implement-spec-intake",
    "review-spec-intake",
    "verify-spec-intake",
    "delivery-package"
  ]);
  assert.equal(requiredRuntimeChecks.get("gpt-runner"), true);
  assert.equal(requiredRuntimeChecks.get("codex"), true);
  assert.equal(requiredRuntimeChecks.get("local-ci"), true);
  assert.equal(finalDispatchResults.summary.completed, 1);
  assert.equal(finalDispatchResults.results[0]?.taskId, "delivery-package");
  assert.equal(finalDispatchResults.results[0]?.status, "completed");
  assert.match(report, /\[completed\] planning-brief ->/);
  assert.match(report, /\[completed\] implement-spec-intake ->/);
  assert.match(report, /\[completed\] review-spec-intake ->/);
  assert.match(report, /\[completed\] verify-spec-intake ->/);
  assert.match(report, /\[completed\] delivery-package ->/);
  assert.ok((fakeCodexState.invocations ?? 0) >= 1, `${scenario.name}: fake codex should have at least one invocation`);

  if (scenario.faultMode === "timeout-once") {
    assert.equal(fakeCodexState.timeoutInjected, true, "timeout scenario should inject one timeout");
  }

  if (scenario.faultMode === "timeout-error-once") {
    assert.equal(fakeCodexState.timeoutErrorInjected, true, "timeout-error scenario should inject one timeout failure");
  }

  if (scenario.faultMode === "bad-gateway-once") {
    assert.equal(fakeCodexState.badGatewayInjected, true, "bad-gateway scenario should inject one 502");
    const allTaskNotes = runState.taskLedger.flatMap((task) => task.notes ?? []);
    const recoveredWithinLauncher = (fakeCodexState.invocations ?? 0) > 4;
    assert.ok(
      allTaskNotes.some((note) => /dispatch:(failed|incomplete|invalid-automation-decision)|autonomous-(requeue|reset)/i.test(note)) ||
        recoveredWithinLauncher,
      "bad-gateway scenario should leave recovery evidence in task notes or through an extra launcher retry"
    );
  }

  if (scenario.injectInterruption === true) {
    assert.ok(
      summary.rounds.some((round) => round.recovery?.type === "planner_retry"),
      "interruption scenario should recover stale planner claim"
    );
    await assert.rejects(() => readFile(staleLockPath, "utf8"), /ENOENT/);
  }

  return {
    scenario: scenario.name,
    runId: path.basename(runRoot),
    rounds: summary.rounds.length,
    stopReason: summary.stopReason
  };
}

async function runScenario(scenario) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `ai-factory-autonomous-e2e-${scenario.name}-`));
  const workspaceRoot = path.join(tempDir, "workspace");
  const runsRoot = path.join(workspaceRoot, "runs");
  const runId = `e2e-${scenario.name}`;
  const runRoot = path.join(runsRoot, runId);
  const runStatePath = path.join(runRoot, "run-state.json");
  const handoffResultsPath = path.join(runRoot, "handoffs-autonomous", "dispatch-results.json");
  const fakeBinDir = path.join(tempDir, "fake-bin");
  const fakeCodexStatePath = path.join(tempDir, "fake-codex-state.json");

  await prepareWorkspace(workspaceRoot);
  await createFakeCodexBinary(fakeBinDir);
  await writeJson(fakeCodexStatePath, {});

  const env = {
    ...process.env,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    AI_FACTORY_FAKE_CODEX_FAULT: scenario.faultMode,
    AI_FACTORY_FAKE_CODEX_STATE: fakeCodexStatePath,
    AI_FACTORY_FAKE_CODEX_TIMEOUT_MS: String(scenario.fakeTimeoutMs ?? 1200),
    AI_FACTORY_LAUNCHER_TIMEOUT_MS: String(scenario.launcherTimeoutMs ?? defaultLauncherTimeoutMs),
    AI_FACTORY_POWERSHELL_TIMEOUT_MS: String(scenario.launcherTimeoutMs ?? defaultLauncherTimeoutMs)
  };

  await runNode(["src/index.mjs", "validate", path.join(workspaceRoot, "specs", "project-spec.json")], { env });
  await runNode(["src/index.mjs", "run", path.join(workspaceRoot, "specs", "project-spec.json"), runsRoot, runId], {
    env
  });

  let staleLockPath = null;

  if (scenario.injectInterruption === true) {
    const interruption = await injectInterruptedPlannerClaim(runStatePath);
    staleLockPath = interruption.staleLockPath;
  }

  await runNode(["src/index.mjs", "autonomous", runStatePath], { env });

  const verification = await verifyScenario({
    scenario,
    runRoot,
    handoffResultsPath,
    fakeCodexStatePath,
    staleLockPath
  });

  return {
    tempDir,
    ...verification
  };
}

async function main() {
  const scenarios = [
    {
      name: "baseline",
      faultMode: "none"
    },
    {
      name: "timeout-recovery",
      faultMode: "timeout-error-once"
    },
    {
      name: "bad-gateway-recovery",
      faultMode: "bad-gateway-once"
    },
    {
      name: "interruption-recovery",
      faultMode: "none",
      injectInterruption: true
    }
  ];
  const results = [];

  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push(result);
    console.log(
      `[${scenario.name}] passed: runId=${result.runId}, rounds=${result.rounds}, workspace=${result.tempDir}`
    );
  }

  console.log(`Autonomous E2E smoke passed (${results.length} scenarios).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
