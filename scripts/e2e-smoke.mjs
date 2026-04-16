import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function runNode(args) {
  await execFileAsync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8"
  });
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function escapeShellSingleQuoted(value) {
  return String(value).replace(/'/g, `'"'"'`);
}

function toPowerShellLiteral(value) {
  if (Array.isArray(value)) {
    return `@(${value.map((item) => toPowerShellLiteral(item)).join(", ")})`;
  }

  if (typeof value === "string") {
    return `'${escapePowerShellSingleQuoted(value)}'`;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "$true" : "$false";
  }

  if (value === null) {
    return "$null";
  }

  throw new Error(`Unsupported PowerShell literal: ${typeof value}`);
}

function buildResultArtifactScript(resultPath, artifact) {
  const completeArtifact = {
    runId: "{{RUN_ID}}",
    taskId: "{{TASK_ID}}",
    handoffId: "{{HANDOFF_ID}}",
    ...artifact
  };

  if (process.platform === "win32") {
    const escapedResultPath = escapePowerShellSingleQuoted(resultPath);
    const lines = ["$result = @{"];

    for (const [key, value] of Object.entries(completeArtifact)) {
      lines.push(`  ${key} = ${toPowerShellLiteral(value)}`);
    }

    lines.push("} | ConvertTo-Json -Depth 5");
    lines.push(`$result | Set-Content -Path '${escapedResultPath}' -Encoding utf8`);

    return `${lines.join("\n")}\n`;
  }

  return `cat > '${escapeShellSingleQuoted(resultPath)}' <<'JSON'
${JSON.stringify(completeArtifact, null, 2)}
JSON
`;
}

function bindArtifactScriptIdentity(script, descriptor) {
  return script
    .replaceAll("{{RUN_ID}}", descriptor.runId ?? "e2e-run")
    .replaceAll("{{TASK_ID}}", descriptor.taskId)
    .replaceAll("{{HANDOFF_ID}}", descriptor.handoffId ?? "e2e-handoff");
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-e2e-"));
  const reportsDir = path.join(tempDir, "reports");
  const runRoot = path.join(tempDir, "runs");
  const runStatePath = path.join(runRoot, "e2e-run", "run-state.json");
  const handoffIndexPath = path.join(runRoot, "e2e-run", "handoffs", "index.json");
  const dispatchResultsPath = path.join(runRoot, "e2e-run", "handoffs", "dispatch-results.json");
  const reportPath = path.join(runRoot, "e2e-run", "report.md");
  const syntheticDoctorPath = path.join(reportsDir, "synthetic-doctor.json");

  await runNode(["src/index.mjs", "validate", "examples/project-spec.valid.json"]);
  await runNode(["src/index.mjs", "plan", "examples/project-spec.valid.json", tempDir]);
  await runNode(["src/index.mjs", "doctor", reportsDir]);
  await runNode(["src/index.mjs", "run", "examples/project-spec.valid.json", runRoot, "e2e-run"]);
  await writeFile(
    syntheticDoctorPath,
    JSON.stringify(
      {
        checks: [
          { id: "openclaw", installed: true, ok: true },
          { id: "cursor", installed: true, ok: true },
          { id: "codex", installed: true, ok: true },
          { id: "local-ci", installed: true, ok: true }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  await runNode(["src/index.mjs", "tick", runStatePath, syntheticDoctorPath]);
  await runNode(["src/index.mjs", "dispatch", handoffIndexPath, "dry-run"]);

  const planningDryRunResults = JSON.parse(await readFile(dispatchResultsPath, "utf8"));
  assert.equal(planningDryRunResults.summary.wouldSkip, 1);
  assert.equal(planningDryRunResults.results[0]?.taskId, "planning-brief");
  assert.equal(planningDryRunResults.results[0]?.status, "would_skip");

  const planningHandoffIndex = JSON.parse(await readFile(handoffIndexPath, "utf8"));
  assert.equal(planningHandoffIndex.readyTaskCount, 1);
  assert.equal(planningHandoffIndex.descriptors[0]?.runtime.id, "manual");

  await runNode(["src/index.mjs", "task", runStatePath, "planning-brief", "completed", "synthetic planner"]);
  await runNode(["src/index.mjs", "tick", runStatePath, syntheticDoctorPath]);
  await runNode(["src/index.mjs", "dispatch", handoffIndexPath, "dry-run"]);

  const implementationDryRunResults = JSON.parse(await readFile(dispatchResultsPath, "utf8"));
  assert.equal(implementationDryRunResults.summary.wouldExecute, 2);
  assert.ok(implementationDryRunResults.results.every((result) => result.status === "would_execute"));

  const implementationHandoffIndex = JSON.parse(await readFile(handoffIndexPath, "utf8"));
  assert.equal(implementationHandoffIndex.readyTaskCount, 2);
  assert.ok(implementationHandoffIndex.descriptors.every((descriptor) => descriptor.runtime.id === "codex"));

  for (const descriptor of implementationHandoffIndex.descriptors) {
    await writeFile(
      descriptor.launcherPath,
      bindArtifactScriptIdentity(buildResultArtifactScript(descriptor.resultPath, {
        status: "completed",
        summary: `synthetic completion for ${descriptor.taskId}`,
        changedFiles: [`src/generated/${descriptor.taskId}.mjs`],
        verification: ["synthetic dispatch execute smoke"],
        notes: ["e2e synthetic artifact"]
      }), descriptor),
      "utf8"
    );
  }

  await runNode(["src/index.mjs", "dispatch", handoffIndexPath, "execute"]);

  const executeResults = JSON.parse(await readFile(dispatchResultsPath, "utf8"));
  assert.equal(executeResults.summary.completed, 2);
  assert.equal(executeResults.runStateSync?.updatedTasks.length, 2);
  assert.ok(
    executeResults.runStateSync?.updatedTasks.every((taskUpdate) => taskUpdate.nextStatus === "completed")
  );

  const runState = JSON.parse(await readFile(runStatePath, "utf8"));
  const planningTask = runState.taskLedger.find((task) => task.id === "planning-brief");
  const implementationTasks = runState.taskLedger.filter((task) => task.id.startsWith("implement-"));
  const reviewTasks = runState.taskLedger.filter((task) => task.id.startsWith("review-"));
  const report = await readFile(reportPath, "utf8");

  assert.equal(planningTask?.status, "completed");
  assert.ok(implementationTasks.length > 0);
  assert.ok(implementationTasks.every((task) => task.status === "completed"));
  assert.ok(reviewTasks.every((task) => task.status === "ready"));
  assert.match(report, /\[completed\] planning-brief ->/);
  assert.match(report, /\[completed\] implement-/);
  assert.match(report, /\[ready\] review-/);

  console.log(`E2E smoke passed in ${tempDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
