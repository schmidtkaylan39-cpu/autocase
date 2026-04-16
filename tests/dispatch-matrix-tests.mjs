import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRunHandoffs, runProject, updateRunTask } from "../src/lib/commands.mjs";
import { dispatchHandoffs } from "../src/lib/dispatch.mjs";
import { writeJson } from "../src/lib/fs-utils.mjs";

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

  return `${lines.join("\n")}\n`;
}

function buildRawResultScript(resultPath, rawContent) {
  const escapedResultPath = escapePowerShellSingleQuoted(resultPath);
  const escapedRawContent = escapePowerShellSingleQuoted(rawContent);
  return `Set-Content -Path '${escapedResultPath}' -Value '${escapedRawContent}' -Encoding utf8\n`;
}

function buildBarrierResultArtifactScript(resultPath, artifact, syncDirectory, markerName, expectedCount) {
  const escapedSyncDirectory = escapePowerShellSingleQuoted(syncDirectory);
  const escapedMarkerName = escapePowerShellSingleQuoted(markerName);
  const barrierLines = [
    `$syncDirectory = '${escapedSyncDirectory}'`,
    "New-Item -ItemType Directory -Force -Path $syncDirectory | Out-Null",
    `$markerPath = Join-Path $syncDirectory '${escapedMarkerName}.started'`,
    "Set-Content -Path $markerPath -Value 'ready' -Encoding utf8",
    `$expectedCount = ${expectedCount}`,
    "while ((Get-ChildItem -LiteralPath $syncDirectory -Filter '*.started' | Measure-Object).Count -lt $expectedCount) {",
    "  Start-Sleep -Milliseconds 25",
    "}"
  ];

  return `${barrierLines.join("\n")}\n${buildResultArtifactScript(resultPath, artifact)}`;
}

function modeForRuntime(runtimeId) {
  if (runtimeId === "cursor") {
    return "hybrid";
  }

  if (runtimeId === "manual") {
    return "manual";
  }

  return "automated";
}

async function writeFakeDoctorReport(filePath, overrides = {}) {
  const runtimeIds = ["openclaw", "cursor", "codex", "local-ci"];
  const checks = runtimeIds.map((runtimeId) => ({
    id: runtimeId,
    installed: true,
    ok: false,
    ...(overrides[runtimeId] ?? {})
  }));

  await writeJson(filePath, { checks });
}

async function createDispatchReadyRun(tempDir, runId, doctorOverrides = {}) {
  const runResult = await runProject(validSpecPath, tempDir, runId);
  const doctorReportPath = path.join(tempDir, `${runId}.doctor.json`);
  await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");
  await writeFakeDoctorReport(doctorReportPath, doctorOverrides);

  const handoffResult = await createRunHandoffs(runResult.statePath, undefined, doctorReportPath);
  const baseDescriptor = handoffResult.descriptors[0];

  if (!baseDescriptor) {
    throw new Error("Expected at least one ready handoff descriptor.");
  }

  return {
    runResult,
    handoffResult,
    descriptor: {
      ...baseDescriptor,
      runtime: { ...baseDescriptor.runtime }
    },
    runDirectory: path.dirname(runResult.statePath),
    reportPath: path.join(path.dirname(runResult.statePath), "report.md")
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

async function runSingleDescriptorDispatchScenario({
  tempPrefix,
  runtimeId,
  launcherScript,
  doctorOverrides = { codex: { ok: true } }
}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
    tempDir,
    `${tempPrefix}-${Date.now()}`,
    doctorOverrides
  );

  descriptor.runtime = {
    ...descriptor.runtime,
    id: runtimeId,
    label: runtimeId,
    mode: modeForRuntime(runtimeId)
  };

  await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
  const resolvedLauncherScript = launcherScript.replaceAll("{{RESULT_PATH}}", descriptor.resultPath);
  await writeFile(descriptor.launcherPath, resolvedLauncherScript, "utf8");

  const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
  const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
  const report = await readFile(reportPath, "utf8");
  const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

  if (!task) {
    throw new Error(`Task not found in run-state: ${descriptor.taskId}`);
  }

  return {
    descriptor,
    dispatchResult,
    runState,
    report,
    task
  };
}

async function main() {
  await runTest("matrix: completed artifact updates run-state and unlocks review", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-completed-",
      runtimeId: "codex",
      launcherScript: buildResultArtifactScript("{{RESULT_PATH}}", {
        status: "completed",
        summary: "completed via matrix test",
        changedFiles: ["src/lib/dispatch.mjs"],
        verification: ["npm test"],
        notes: ["matrix completed path"]
      })
    });
    const { descriptor, dispatchResult, runState, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "completed");
    assert.equal(dispatchResult.summary.completed, 1);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "completed"
    });
    assert.equal(task.status, "completed");

    const reviewTaskId = descriptor.taskId.replace(/^implement-/, "review-");
    const reviewTask = runState.taskLedger.find((item) => item.id === reviewTaskId);
    assert.equal(reviewTask?.status, "ready");
    assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
    assert.match(report, new RegExp(`\\[ready\\] ${reviewTaskId} ->`));
    assert.equal(result.artifact?.status, "completed");
    assert.ok(Array.isArray(result.artifact?.changedFiles));
    assert.ok(Array.isArray(result.artifact?.verification));
    assert.ok(Array.isArray(result.artifact?.notes));
  });

  await runTest("matrix: failed artifact maps to failed task status", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-failed-",
      runtimeId: "codex",
      launcherScript: buildResultArtifactScript("{{RESULT_PATH}}", {
        status: "failed",
        summary: "failed via matrix test",
        changedFiles: ["src/lib/runtime-registry.mjs"],
        verification: ["npm run lint"],
        notes: ["matrix failed path"]
      })
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "failed");
    assert.equal(dispatchResult.summary.failed, 1);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "failed"
    });
    assert.equal(task.status, "failed");
    assert.match(report, new RegExp(`\\[failed\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: blocked artifact is valid contract but maps to blocked task via incomplete", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-blocked-",
      runtimeId: "codex",
      launcherScript: buildResultArtifactScript("{{RESULT_PATH}}", {
        status: "blocked",
        summary: "blocked via matrix test",
        changedFiles: [],
        verification: ["manual investigation"],
        notes: ["risk-stop triggered"]
      })
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "incomplete");
    assert.equal(result.artifact?.status, "blocked");
    assert.match(result.note ?? "", /blocked task/i);
    assert.equal(dispatchResult.summary.incomplete, 1);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "blocked"
    });
    assert.equal(task.status, "blocked");
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: invalid schema artifact blocks the task", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-schema-",
      runtimeId: "codex",
      launcherScript: buildResultArtifactScript("{{RESULT_PATH}}", {
        status: "completed",
        summary: "invalid schema boundary",
        changedFiles: "src/index.mjs",
        verification: ["npm test"]
      })
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "incomplete");
    assert.match(result.note ?? "", /expected schema/i);
    assert.equal(dispatchResult.summary.incomplete, 1);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "blocked"
    });
    assert.equal(task.status, "blocked");
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: blank summaries and empty notes fail stricter artifact validation", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-summary-",
      runtimeId: "codex",
      launcherScript: buildResultArtifactScript("{{RESULT_PATH}}", {
        status: "completed",
        summary: "   ",
        changedFiles: ["src/index.mjs"],
        verification: ["npm test"],
        notes: []
      })
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "incomplete");
    assert.match(result.note ?? "", /expected schema/i);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "blocked"
    });
    assert.equal(task.status, "blocked");
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: invalid JSON artifact blocks the task with parse error note", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-json-",
      runtimeId: "codex",
      launcherScript: buildRawResultScript("{{RESULT_PATH}}", "{ invalid-json")
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "incomplete");
    assert.equal(result.artifact, null);
    assert.ok(typeof result.note === "string" && result.note.length > 0);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "blocked"
    });
    assert.equal(task.status, "blocked");
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: missing artifact blocks the task", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-missing-",
      runtimeId: "codex",
      launcherScript: "Write-Output 'no artifact generated'\n"
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "incomplete");
    assert.match(result.note ?? "", /not written/i);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "blocked"
    });
    assert.equal(task.status, "blocked");
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: missing launcher path fails fast with a clear error", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-missing-launcher-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
      tempDir,
      `missing-launcher-${Date.now()}`,
      { codex: { ok: true } }
    );

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await rm(descriptor.launcherPath, { force: true });

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);
    const result = dispatchResult.results[0];

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /launcher script not found/i);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "failed"
    });
    assert.equal(task?.status, "failed");
    assert.match(report, new RegExp(`\\[failed\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: launcher timeout is reported as a timeout-specific failure", async () => {
    const previousTimeout = process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS;
    process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS = "100";

    try {
      const scenario = await runSingleDescriptorDispatchScenario({
        tempPrefix: "ai-factory-matrix-timeout-",
        runtimeId: "codex",
        launcherScript: "Start-Sleep -Milliseconds 300\n"
      });
      const { descriptor, dispatchResult, report, task } = scenario;
      const result = dispatchResult.results[0];

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /timed out/i);
      assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
        taskId: descriptor.taskId,
        nextStatus: "failed"
      });
      assert.equal(task.status, "failed");
      assert.match(report, new RegExp(`\\[failed\\] ${descriptor.taskId} ->`));
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS;
      } else {
        process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  await runTest("matrix: manual runtime is skipped and does not mutate run-state", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-manual-",
      runtimeId: "manual",
      launcherScript: "throw 'manual runtime should not auto execute'\n"
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "skipped");
    assert.equal(dispatchResult.summary.skipped, 1);
    assert.equal(dispatchResult.runStateSync?.updatedTasks.length, 0);
    assert.equal(task.status, "ready");
    assert.match(report, new RegExp(`\\[ready\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: hybrid runtime is skipped and does not mutate run-state", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-hybrid-",
      runtimeId: "cursor",
      launcherScript: "throw 'cursor runtime should not auto execute'\n"
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "skipped");
    assert.equal(dispatchResult.summary.skipped, 1);
    assert.equal(dispatchResult.runStateSync?.updatedTasks.length, 0);
    assert.equal(task.status, "ready");
    assert.match(report, new RegExp(`\\[ready\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: runStateSync is null when run-state.json is absent", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-nosync-"));
    const handoffDir = path.join(tempDir, "handoffs");
    const indexPath = path.join(handoffDir, "index.json");
    const launcherPath = path.join(handoffDir, "standalone.launch.ps1");
    const resultPath = path.join(handoffDir, "results", "standalone.result.json");

    await mkdir(path.join(handoffDir, "results"), { recursive: true });
    await writeFile(
      launcherPath,
      buildResultArtifactScript(resultPath, {
        status: "completed",
        summary: "standalone dispatch execute",
        changedFiles: [],
        verification: ["matrix standalone"],
        notes: ["no run-state in this scenario"]
      }),
      "utf8"
    );

    await writeJson(indexPath, {
      generatedAt: new Date().toISOString(),
      runId: "standalone-dispatch-run",
      readyTaskCount: 1,
      descriptors: [
        {
          taskId: "standalone-task",
          runtime: { id: "codex", label: "Codex", mode: "automated" },
          launcherPath,
          resultPath
        }
      ]
    });

    const dispatchResult = await dispatchHandoffs(indexPath, "execute");

    assert.equal(dispatchResult.summary.completed, 1);
    assert.equal(dispatchResult.results[0]?.status, "completed");
    assert.equal(dispatchResult.runStateSync, null);
  });

  await runTest("matrix: unsupported dispatch modes fail fast", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-mode-"));
    const indexPath = path.join(tempDir, "index.json");

    await writeJson(indexPath, {
      generatedAt: new Date().toISOString(),
      runId: "bad-mode-run",
      readyTaskCount: 0,
      descriptors: []
    });

    await assert.rejects(() => dispatchHandoffs(indexPath, "preview"), /unsupported dispatch mode/i);
  });

  await runTest("matrix: concurrent dispatch execute preserves both run-state updates", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-concurrent-"));
    const { runResult, handoffResult, reportPath } = await createDispatchReadyRun(
      tempDir,
      `concurrent-dispatch-${Date.now()}`,
      { codex: { ok: true } }
    );
    const [firstDescriptor, secondDescriptor] = handoffResult.descriptors;

    if (!firstDescriptor || !secondDescriptor) {
      throw new Error("Expected two ready descriptors for concurrent dispatch coverage.");
    }

    const syncDirectory = path.join(tempDir, "dispatch-sync");
    const firstIndexPath = path.join(path.dirname(handoffResult.indexPath), "index-a.json");
    const secondIndexPath = path.join(path.dirname(handoffResult.indexPath), "index-b.json");

    await writeFile(
      firstDescriptor.launcherPath,
      buildBarrierResultArtifactScript(
        firstDescriptor.resultPath,
        {
          status: "completed",
          summary: `completed ${firstDescriptor.taskId}`,
          changedFiles: ["src/lib/dispatch.mjs"],
          verification: ["npm test"],
          notes: ["concurrent dispatch A"]
        },
        syncDirectory,
        "first",
        2
      ),
      "utf8"
    );
    await writeFile(
      secondDescriptor.launcherPath,
      buildBarrierResultArtifactScript(
        secondDescriptor.resultPath,
        {
          status: "completed",
          summary: `completed ${secondDescriptor.taskId}`,
          changedFiles: ["src/lib/run-state.mjs"],
          verification: ["npm test"],
          notes: ["concurrent dispatch B"]
        },
        syncDirectory,
        "second",
        2
      ),
      "utf8"
    );
    await limitDispatchToDescriptors(firstIndexPath, handoffResult.runId, [firstDescriptor]);
    await limitDispatchToDescriptors(secondIndexPath, handoffResult.runId, [secondDescriptor]);

    const [firstDispatchResult, secondDispatchResult] = await Promise.all([
      dispatchHandoffs(firstIndexPath, "execute"),
      dispatchHandoffs(secondIndexPath, "execute")
    ]);
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");

    assert.equal(firstDispatchResult.summary.completed, 1);
    assert.equal(secondDispatchResult.summary.completed, 1);

    for (const descriptor of [firstDescriptor, secondDescriptor]) {
      const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);
      const reviewTask = runState.taskLedger.find(
        (item) => item.id === descriptor.taskId.replace(/^implement-/, "review-")
      );

      assert.equal(task?.status, "completed");
      assert.equal(reviewTask?.status, "ready");
      assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
      assert.match(report, new RegExp(`\\[ready\\] ${descriptor.taskId.replace(/^implement-/, "review-")} ->`));
    }
  });

  console.log("Dispatch matrix tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
