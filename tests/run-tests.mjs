import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRunHandoffs,
  initProject,
  planProject,
  reportProjectRun,
  runProject,
  updateRunTask,
  validateSpec
} from "../src/lib/commands.mjs";
import { dispatchHandoffs } from "../src/lib/dispatch.mjs";
import { writeJson } from "../src/lib/fs-utils.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const knownRuntimeIds = ["cursor", "openclaw", "codex", "local-ci"];

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
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
  const escapedResultPath = escapePowerShellSingleQuoted(resultPath);
  const lines = ["$result = @{"];

  for (const [key, value] of Object.entries(artifact)) {
    lines.push(`  ${key} = ${toPowerShellLiteral(value)}`);
  }

  lines.push("} | ConvertTo-Json -Depth 5");
  lines.push(`$result | Set-Content -Path '${escapedResultPath}' -Encoding utf8`);

  return lines.join("\n");
}

async function writeFakeDoctorReport(filePath, overrides = {}) {
  const checks = knownRuntimeIds.map((runtimeId) => ({
    id: runtimeId,
    installed: true,
    ok: false,
    ...(overrides[runtimeId] ?? {})
  }));

  await writeJson(filePath, { checks });
}

async function createDispatchReadyRun(validSpecPath, tempDir, runId, doctorOverrides = {}) {
  const runResult = await runProject(validSpecPath, tempDir, runId);
  const doctorReportPath = path.join(tempDir, `${runId}.doctor.json`);

  await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");
  await writeFakeDoctorReport(doctorReportPath, doctorOverrides);

  const handoffResult = await createRunHandoffs(runResult.statePath, undefined, doctorReportPath);

  return {
    runResult,
    handoffResult,
    doctorReportPath,
    runDirectory: path.dirname(runResult.statePath)
  };
}

async function limitDispatchToDescriptors(indexPath, runId, descriptors) {
  await writeJson(indexPath, {
    generatedAt: new Date().toISOString(),
    runId,
    readyTaskCount: descriptors.length,
    descriptors
  });
}

async function main() {
  const validSpecPath = path.join(projectRoot, "examples", "project-spec.valid.json");
  const invalidSpecPath = path.join(projectRoot, "examples", "project-spec.invalid.json");

  await runTest("validate passes for valid spec", async () => {
    const result = await validateSpec(validSpecPath);
    assert.equal(result.validation.valid, true);
    assert.equal(result.summary?.projectName, "AI Factory Demo");
  });

  await runTest("validate fails for invalid spec", async () => {
    const result = await validateSpec(invalidSpecPath);
    assert.equal(result.validation.valid, false);
    assert.match(result.validation.errors.join("\n"), /projectGoal/);
  });

  await runTest("plan creates json and markdown outputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-plan-"));
    const result = await planProject(validSpecPath, tempDir);

    assert.equal(result.ok, true);
    await stat(path.join(tempDir, "execution-plan.json"));
    await stat(path.join(tempDir, "execution-plan.md"));

    const markdown = await readFile(path.join(tempDir, "execution-plan.md"), "utf8");
    assert.match(markdown, /AI Factory Demo Execution Plan/);
  });

  await runTest("init creates starter folders and spec", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-init-"));
    const result = await initProject(tempDir);

    assert.match(result.sampleSpecPath, /project-spec\.json$/);
    assert.match(result.configPath, /factory\.config\.json$/);
    await stat(path.join(tempDir, "specs", "project-spec.json"));
    await stat(path.join(tempDir, "config", "factory.config.json"));
  });

  await runTest("run creates a full run directory with state and briefs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-run-"));
    const result = await runProject(validSpecPath, tempDir, "test-run");

    assert.equal(result.ok, true);
    await stat(path.join(tempDir, "test-run", "run-state.json"));
    await stat(path.join(tempDir, "test-run", "roles.json"));
    await stat(path.join(tempDir, "test-run", "task-briefs", "planning-brief.md"));
  });

  await runTest("report rewrites report from run state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-report-"));
    const runResult = await runProject(validSpecPath, tempDir, "report-run");
    const reportResult = await reportProjectRun(runResult.statePath);

    assert.match(reportResult.reportPath, /report\.md$/);
    const report = await readFile(reportResult.reportPath, "utf8");
    assert.match(report, /AI Factory Demo Run Report/);
  });

  await runTest("updating planning task unlocks implementation tasks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-task-"));
    const runResult = await runProject(validSpecPath, tempDir, "task-run");
    const updateResult = await updateRunTask(
      runResult.statePath,
      "planning-brief",
      "completed",
      "planner finished"
    );

    assert.equal(updateResult.task?.status, "completed");
    assert.ok(updateResult.summary.readyTasks >= 2);

    const runStateAfterUpdate = JSON.parse(
      await readFile(path.join(tempDir, "task-run", "run-state.json"), "utf8")
    );
    const implementationTask = runStateAfterUpdate.taskLedger.find(
      (task) => task.id === "implement-spec-intake"
    );

    assert.equal(implementationTask.status, "ready");
  });

  await runTest("handoff generation creates prompt, json, markdown, and launcher", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-handoff-"));
    const runResult = await runProject(validSpecPath, tempDir, "handoff-run");
    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");

    const fakeDoctorPath = path.join(tempDir, "doctor.json");
    await writeFakeDoctorReport(fakeDoctorPath, {
      codex: { ok: true }
    });

    const result = await createRunHandoffs(
      path.join(tempDir, "handoff-run", "run-state.json"),
      undefined,
      fakeDoctorPath
    );

    assert.equal(result.readyTaskCount, 2);
    await stat(path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.prompt.md"));
    await stat(path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.handoff.json"));
    await stat(path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.handoff.md"));
    await stat(path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.launch.ps1"));
    await stat(path.join(tempDir, "handoff-run", "handoffs", "results"));
  });

  await runTest("dispatch dry-run produces dispatch results", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-dispatch-"));
    const runResult = await runProject(validSpecPath, tempDir, "dispatch-run");
    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");

    const fakeDoctorPath = path.join(tempDir, "doctor.json");
    await writeFakeDoctorReport(fakeDoctorPath, {
      codex: { ok: true }
    });

    const handoffResult = await createRunHandoffs(
      path.join(tempDir, "dispatch-run", "run-state.json"),
      undefined,
      fakeDoctorPath
    );
    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "dry-run");

    assert.equal(dispatchResult.summary.total, 2);
    assert.ok(dispatchResult.results.every((item) => item.status === "would_execute"));
    await stat(path.join(tempDir, "dispatch-run", "handoffs", "dispatch-results.json"));
  });

  await runTest("dispatch execute writes blocked state and report when no result artifact is written", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-dispatch-exec-"));
    const { runResult, handoffResult } = await createDispatchReadyRun(
      validSpecPath,
      tempDir,
      "dispatch-exec-run",
      {
        codex: { ok: true }
      }
    );
    const [descriptor] = handoffResult.descriptors;

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await writeFile(descriptor.launcherPath, "Write-Output 'noop'\n", "utf8");

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const updatedTask = runState.taskLedger.find((task) => task.id === descriptor.taskId);
    const report = await readFile(path.join(path.dirname(runResult.statePath), "report.md"), "utf8");

    assert.equal(dispatchResult.summary.incomplete, 1);
    assert.equal(dispatchResult.results[0].status, "incomplete");
    assert.equal(dispatchResult.runStateSync?.updatedTasks.length, 1);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "blocked"
    });
    assert.equal(updatedTask?.status, "blocked");
    assert.match(updatedTask?.notes?.at(-1) ?? "", /dispatch:incomplete/);
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("dispatch execute rejects invalid result artifact schema and blocks the task", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-dispatch-schema-"));
    const { runResult, handoffResult } = await createDispatchReadyRun(
      validSpecPath,
      tempDir,
      "dispatch-schema-run",
      {
        codex: { ok: true }
      }
    );
    const [descriptor] = handoffResult.descriptors;

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await writeFile(
      descriptor.launcherPath,
      buildResultArtifactScript(descriptor.resultPath, {
        status: "completed",
        summary: "missing notes array on purpose",
        changedFiles: "src/index.mjs",
        verification: ["npm test"]
      }),
      "utf8"
    );

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const updatedTask = runState.taskLedger.find((task) => task.id === descriptor.taskId);
    const report = await readFile(path.join(path.dirname(runResult.statePath), "report.md"), "utf8");

    assert.equal(dispatchResult.summary.incomplete, 1);
    assert.equal(dispatchResult.results[0].status, "incomplete");
    assert.match(dispatchResult.results[0].note ?? "", /expected schema/i);
    assert.deepEqual(dispatchResult.results[0].artifact, {
      status: "completed",
      summary: "missing notes array on purpose",
      changedFiles: "src/index.mjs",
      verification: ["npm test"]
    });
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "blocked"
    });
    assert.equal(updatedTask?.status, "blocked");
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("dispatch execute validates result artifacts and syncs run-state plus report", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-dispatch-complete-"));
    const { runResult, handoffResult } = await createDispatchReadyRun(
      validSpecPath,
      tempDir,
      "dispatch-complete-run",
      {
        codex: { ok: true }
      }
    );

    for (const [index, descriptor] of handoffResult.descriptors.entries()) {
      await writeFile(
        descriptor.launcherPath,
        buildResultArtifactScript(descriptor.resultPath, {
          status: "completed",
          summary: `completed ${descriptor.taskId}`,
          changedFiles: [`src/features/${index}.mjs`],
          verification: ["npm test", "npm run test:e2e"],
          notes: [`artifact ok for ${descriptor.taskId}`]
        }),
        "utf8"
      );
    }

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(path.join(path.dirname(runResult.statePath), "report.md"), "utf8");

    assert.equal(dispatchResult.summary.total, handoffResult.descriptors.length);
    assert.equal(dispatchResult.summary.completed, handoffResult.descriptors.length);
    assert.ok(dispatchResult.results.every((item) => item.status === "completed"));
    assert.ok(
      dispatchResult.results.every(
        (item) =>
          item.artifact &&
          typeof item.artifact.summary === "string" &&
          Array.isArray(item.artifact.changedFiles) &&
          Array.isArray(item.artifact.verification) &&
          Array.isArray(item.artifact.notes)
      )
    );
    assert.equal(dispatchResult.runStateSync?.updatedTasks.length, handoffResult.descriptors.length);

    for (const descriptor of handoffResult.descriptors) {
      const implementationTask = runState.taskLedger.find((task) => task.id === descriptor.taskId);
      const reviewTask = runState.taskLedger.find(
        (task) => task.id === descriptor.taskId.replace(/^implement-/, "review-")
      );

      assert.equal(implementationTask?.status, "completed");
      assert.match(implementationTask?.notes?.at(-1) ?? "", /dispatch:completed/);
      assert.equal(reviewTask?.status, "ready");
      assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
      assert.match(report, new RegExp(`\\[ready\\] ${descriptor.taskId.replace(/^implement-/, "review-")} ->`));
    }

    assert.match(report, /- Completed: 3/);
    assert.match(report, /- Ready: 2/);
  });

  console.log("All tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
