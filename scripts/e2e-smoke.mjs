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

async function createFakeCodexBinary(binDir) {
  await mkdir(binDir, { recursive: true });
  const fakeNodeScriptPath = path.join(binDir, "fake-codex.mjs");

  await writeFile(
    fakeNodeScriptPath,
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
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
      'let promptText = "";',
      "for await (const chunk of process.stdin) {",
      "  promptText += chunk;",
      "}",
      "",
      'const resultPath = promptText.match(/Write a JSON file to this exact path when you finish: (.+)$/m)?.[1]?.trim();',
      'const runId = promptText.match(/^- runId: (.+)$/m)?.[1]?.trim();',
      'const taskId = promptText.match(/^- taskId: (.+)$/m)?.[1]?.trim();',
      'const handoffId = promptText.match(/^- handoffId: (.+)$/m)?.[1]?.trim();',
      "",
      "if (!resultPath || !runId || !taskId || !handoffId) {",
      '  console.error("fake codex could not parse the prompt contract");',
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
    specPath,
    packageJsonPath
  };
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-autonomous-e2e-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const runsRoot = path.join(workspaceRoot, "runs");
  const runId = "e2e-autonomous-run";
  const runRoot = path.join(runsRoot, runId);
  const runStatePath = path.join(runRoot, "run-state.json");
  const summaryPath = path.join(runRoot, "autonomous-summary.json");
  const reportPath = path.join(runRoot, "report.md");
  const handoffResultsPath = path.join(runRoot, "handoffs-autonomous", "dispatch-results.json");
  const fakeBinDir = path.join(tempDir, "fake-bin");

  await prepareWorkspace(workspaceRoot);
  await createFakeCodexBinary(fakeBinDir);

  const env = {
    ...process.env,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
  };

  await runNode(["src/index.mjs", "validate", path.join(workspaceRoot, "specs", "project-spec.json")], { env });
  await runNode(["src/index.mjs", "run", path.join(workspaceRoot, "specs", "project-spec.json"), runsRoot, runId], {
    env
  });
  await runNode(["src/index.mjs", "autonomous", runStatePath], { env });

  const runState = JSON.parse(await readFile(runStatePath, "utf8"));
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const report = await readFile(reportPath, "utf8");
  const finalDispatchResults = JSON.parse(await readFile(handoffResultsPath, "utf8"));
  const doctorReport = JSON.parse(await readFile(summary.doctorReportPath, "utf8"));
  const taskIds = runState.taskLedger.map((task) => task.id);
  const requiredRuntimeChecks = new Map(
    doctorReport.checks
      .filter((check) => check.requiredByDefaultRoute)
      .map((check) => [check.id, check.ok])
  );

  assert.equal(runState.status, "completed");
  assert.equal(summary.finalStatus, "completed");
  assert.equal(summary.stopReason, "run completed");
  assert.equal(summary.rounds.length, 5);
  assert.equal(summary.rounds.filter((round) => (round.dispatchSummary?.completed ?? 0) === 1).length, 5);
  assert.ok(runState.taskLedger.every((task) => task.status === "completed"));
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

  console.log(`Autonomous E2E smoke passed in ${tempDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
