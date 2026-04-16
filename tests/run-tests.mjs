import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyTaskResult,
  createRunHandoffs,
  initProject,
  planProject,
  reportProjectRun,
  runProject,
  scheduleTaskRetry,
  tickProjectRun,
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
  const completeArtifact = {
    runId: "{{RUN_ID}}",
    taskId: "{{TASK_ID}}",
    handoffId: "{{HANDOFF_ID}}",
    ...artifact
  };
  const lines = ["$result = @{"];

  for (const [key, value] of Object.entries(completeArtifact)) {
    lines.push(`  ${key} = ${toPowerShellLiteral(value)}`);
  }

  lines.push("} | ConvertTo-Json -Depth 5");
  lines.push(`$result | Set-Content -Path '${escapedResultPath}' -Encoding utf8`);

  return lines.join("\n");
}

function withArtifactIdentity(artifact, identity = {}) {
  return {
    runId: identity.runId ?? "fixture-run",
    taskId: identity.taskId ?? "fixture-task",
    handoffId: identity.handoffId ?? "fixture-handoff",
    ...artifact
  };
}

function bindArtifactScriptIdentity(script, descriptor) {
  return script
    .replaceAll("{{RUN_ID}}", descriptor.runId ?? "fixture-run")
    .replaceAll("{{TASK_ID}}", descriptor.taskId)
    .replaceAll("{{HANDOFF_ID}}", descriptor.handoffId ?? "fixture-handoff");
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
    const implementationTask = result.plan.phases
      .find((phase) => phase.id === "implementation")
      ?.tasks?.find((task) => task.id === "implement-spec-intake");
    const verificationTask = result.plan.phases
      .find((phase) => phase.id === "verification")
      ?.tasks?.find((task) => task.id === "verify-spec-intake");

    assert.match(markdown, /AI Factory Demo Execution Plan/);
    assert.equal(implementationTask?.owner, "Codex");
    assert.deepEqual(verificationTask?.gates, [
      "build",
      "lint",
      "typecheck",
      "unit test",
      "integration test",
      "e2e test"
    ]);
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
    const runState = JSON.parse(await readFile(path.join(tempDir, "test-run", "run-state.json"), "utf8"));

    assert.equal(result.ok, true);
    await stat(path.join(tempDir, "test-run", "run-state.json"));
    await stat(path.join(tempDir, "test-run", "roles.json"));
    await stat(path.join(tempDir, "test-run", "task-briefs", "planning-brief.md"));
    assert.equal(runState.workspacePath, projectRoot);
    assert.equal(runState.modelPolicy.planner.defaultModel, "gpt-5.4");
    assert.equal(runState.modelPolicy.executor.defaultModel, "codex");
  });

  await runTest("run resolves workspace config and launcher roots from the spec workspace", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-workspace-config-"));
    const workspace = path.join(tempRoot, "workspace");
    const specPath = path.join(workspace, "specs", "project-spec.json");
    const configPath = path.join(workspace, "config", "factory.config.json");
    const doctorReportPath = path.join(workspace, "reports", "runtime-doctor.json");

    await mkdir(path.join(workspace, "specs"), { recursive: true });
    await mkdir(path.join(workspace, "config"), { recursive: true });
    await mkdir(path.join(workspace, "reports"), { recursive: true });
    await writeFile(specPath, await readFile(validSpecPath, "utf8"), "utf8");
    await writeJson(configPath, {
      roles: {
        verifier: {
          tool: "Workspace CI",
          automation: "automated",
          responsibilities: ["build"],
          finalAuthority: true
        }
      },
      mandatoryGates: ["build"]
    });
    await writeFakeDoctorReport(doctorReportPath, {
      codex: { ok: true }
    });

    const runResult = await runProject(specPath, path.join(workspace, "runs"), "workspace-config-run");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));

    assert.equal(runResult.configPath, configPath);
    assert.equal(runState.workspacePath, workspace);
    assert.deepEqual(runState.mandatoryGates, ["build"]);
    assert.equal(runState.roles.verifier.tool, "Workspace CI");

    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");
    const handoffResult = await createRunHandoffs(runResult.statePath, undefined, doctorReportPath);
    const handoffDescriptor = JSON.parse(
      await readFile(path.join(handoffResult.outputDir, "implement-spec-intake.handoff.json"), "utf8")
    );

    assert.match(
      handoffDescriptor.launcherScript.split(/\r?\n/)[0] ?? "",
      new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
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

  await runTest("task updates reject unsupported task statuses", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-task-invalid-status-"));
    const runResult = await runProject(validSpecPath, tempDir, "task-invalid-status-run");

    await assert.rejects(
      () => updateRunTask(runResult.statePath, "planning-brief", "unknown-status"),
      /unsupported task status/i
    );
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
    const handoffDescriptor = JSON.parse(
      await readFile(path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.handoff.json"), "utf8")
    );
    const promptText = await readFile(
      path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.prompt.md"),
      "utf8"
    );

    await stat(path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.prompt.md"));
    await stat(path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.handoff.json"));
    await stat(path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.handoff.md"));
    await stat(path.join(tempDir, "handoff-run", "handoffs", "implement-spec-intake.launch.ps1"));
    await stat(path.join(tempDir, "handoff-run", "handoffs", "results"));
    assert.match(handoffDescriptor.handoffId ?? "", /^[0-9a-f-]{36}$/i);
    assert.match(handoffDescriptor.paths.resultPath, /implement-spec-intake\.[0-9a-f-]{36}\.result\.json$/i);
    assert.equal(handoffDescriptor.model.preferredModel, "codex");
    assert.match(promptText, new RegExp(`- handoffId: ${handoffDescriptor.handoffId}`));
    assert.match(promptText, /# Model Routing/);
    assert.match(promptText, /preferredModel: codex/);
    assert.match(promptText, /"runId"/);
    assert.match(promptText, /"taskId"/);
    assert.match(promptText, /"handoffId"/);
  });

  await runTest("handoff model routing can be overridden from workspace config and auto-escalates to gpt-5.4-pro", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-model-policy-"));
    const workspace = path.join(tempRoot, "workspace");
    const specPath = path.join(workspace, "specs", "project-spec.json");
    const configPath = path.join(workspace, "config", "factory.config.json");
    const doctorReportPath = path.join(workspace, "reports", "runtime-doctor.json");

    await mkdir(path.join(workspace, "specs"), { recursive: true });
    await mkdir(path.join(workspace, "config"), { recursive: true });
    await mkdir(path.join(workspace, "reports"), { recursive: true });
    await writeFile(specPath, await readFile(validSpecPath, "utf8"), "utf8");
    await writeJson(configPath, {
      modelPolicy: {
        planner: {
          defaultModel: "gpt-5.4",
          escalatedModel: "gpt-5.4-pro",
          autoSwitch: true
        }
      }
    });
    await writeFakeDoctorReport(doctorReportPath, {
      cursor: { ok: true }
    });

    const runResult = await runProject(specPath, path.join(workspace, "runs"), "model-policy-run");
    const runStatePath = runResult.statePath;
    const runState = JSON.parse(await readFile(runStatePath, "utf8"));

    runState.status = "attention_required";
    await writeJson(runStatePath, runState);

    const handoffResult = await createRunHandoffs(runStatePath, undefined, doctorReportPath);
    const handoffDescriptor = JSON.parse(
      await readFile(path.join(handoffResult.outputDir, "planning-brief.handoff.json"), "utf8")
    );

    assert.equal(handoffDescriptor.model.preferredModel, "gpt-5.4-pro");
    assert.equal(handoffDescriptor.model.selectionMode, "escalated");
    assert.match(handoffDescriptor.promptText, /preferredModel: gpt-5\.4-pro/);
  });

  await runTest("handoff generation uses the workspace path persisted in run-state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-handoff-workspace-"));
    await runProject(validSpecPath, tempDir, "handoff-workspace-run");
    const runStatePath = path.join(tempDir, "handoff-workspace-run", "run-state.json");
    const runState = JSON.parse(await readFile(runStatePath, "utf8"));

    runState.workspacePath = "C:/persisted/workspace";
    await writeJson(runStatePath, runState);
    await updateRunTask(runStatePath, "planning-brief", "completed", "planner finished");

    const fakeDoctorPath = path.join(tempDir, "doctor.json");
    await writeFakeDoctorReport(fakeDoctorPath, {
      codex: { ok: true }
    });

    const result = await createRunHandoffs(runStatePath, undefined, fakeDoctorPath);
    const handoffDescriptor = JSON.parse(
      await readFile(
        path.join(tempDir, "handoff-workspace-run", "handoffs", "implement-spec-intake.handoff.json"),
        "utf8"
      )
    );

    assert.equal(result.descriptors[0]?.taskId, "implement-spec-intake");
    assert.match(handoffDescriptor.launcherScript, /C:\/persisted\/workspace/);
  });

  await runTest("handoff defaults doctor report lookup to the workspace root", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-workspace-doctor-"));
    const workspace = path.join(tempRoot, "workspace");
    const specPath = path.join(workspace, "specs", "project-spec.json");
    const doctorReportPath = path.join(workspace, "reports", "runtime-doctor.json");

    await mkdir(path.join(workspace, "specs"), { recursive: true });
    await mkdir(path.join(workspace, "reports"), { recursive: true });
    await writeFile(specPath, await readFile(validSpecPath, "utf8"), "utf8");
    await writeJson(doctorReportPath, {
      checks: [
        { id: "cursor", installed: true, ok: false, error: "workspace doctor says no cursor" }
      ]
    });

    const runResult = await runProject(specPath, path.join(workspace, "runs"), "workspace-doctor-run");
    const handoffResult = await createRunHandoffs(runResult.statePath);
    const handoffDescriptor = JSON.parse(
      await readFile(path.join(handoffResult.outputDir, "planning-brief.handoff.json"), "utf8")
    );

    assert.equal(handoffDescriptor.runtime.id, "manual");
    assert.equal(handoffDescriptor.runtime.selectionStatus, "fallback");
  });

  await runTest("manual or hybrid result artifact can be applied back into the run-state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-apply-result-"));
    const runResult = await runProject(validSpecPath, tempDir, "apply-result-run");
    const planningResultsDirectory = path.join(tempDir, "apply-result-run", "handoffs", "results");
    const planningResultPath = path.join(planningResultsDirectory, "planning-brief.result.json");

    await mkdir(planningResultsDirectory, { recursive: true });
    await writeJson(planningResultPath, withArtifactIdentity({
      status: "completed",
      summary: "planner completed the brief",
      changedFiles: [],
      verification: ["reviewed brief and prompt"],
      notes: ["cursor surface result"]
    }, {
      runId: "apply-result-run",
      taskId: "planning-brief"
    }));

    const result = await applyTaskResult(runResult.statePath, "planning-brief", planningResultPath);
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const planningTask = runState.taskLedger.find((task) => task.id === "planning-brief");
    const implementationTask = runState.taskLedger.find((task) => task.id === "implement-spec-intake");
    const report = await readFile(path.join(tempDir, "apply-result-run", "report.md"), "utf8");

    assert.equal(result.task?.status, "completed");
    assert.equal(result.artifact.status, "completed");
    assert.equal(planningTask?.status, "completed");
    assert.equal(implementationTask?.status, "ready");
    assert.match(report, /\[completed\] planning-brief ->/);
    assert.match(report, /\[ready\] implement-spec-intake ->/);
  });

  await runTest("applying an invalid manual or hybrid result artifact fails fast", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-apply-invalid-result-"));
    const runResult = await runProject(validSpecPath, tempDir, "apply-invalid-result-run");
    const invalidResultsDirectory = path.join(
      tempDir,
      "apply-invalid-result-run",
      "handoffs",
      "results"
    );
    const invalidResultPath = path.join(invalidResultsDirectory, "planning-brief.result.json");

    await mkdir(invalidResultsDirectory, { recursive: true });
    await writeJson(invalidResultPath, withArtifactIdentity({
      status: "completed",
      summary: "missing required arrays",
      changedFiles: "src/index.mjs"
    }, {
      runId: "apply-invalid-result-run",
      taskId: "planning-brief"
    }));

    await assert.rejects(
      () => applyTaskResult(runResult.statePath, "planning-brief", invalidResultPath),
      /expected schema/i
    );
  });

  await runTest("applying a missing manual or hybrid result artifact fails fast", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-apply-missing-result-"));
    const runResult = await runProject(validSpecPath, tempDir, "apply-missing-result-run");
    const missingResultPath = path.join(
      tempDir,
      "apply-missing-result-run",
      "handoffs",
      "results",
      "planning-brief.result.json"
    );

    await assert.rejects(
      () => applyTaskResult(runResult.statePath, "planning-brief", missingResultPath),
      /(ENOENT|no such file)/i
    );
  });

  await runTest("result artifacts cannot complete tasks whose prerequisites are still pending", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-apply-out-of-order-"));
    const runResult = await runProject(validSpecPath, tempDir, "apply-out-of-order-run");
    const resultsDirectory = path.join(tempDir, "apply-out-of-order-run", "handoffs", "results");
    const resultPath = path.join(resultsDirectory, "review-spec-intake.result.json");

    await mkdir(resultsDirectory, { recursive: true });
    await writeJson(resultPath, withArtifactIdentity({
      status: "completed",
      summary: "review completed out of order",
      changedFiles: ["src/review.md"],
      verification: ["manual review"],
      notes: ["out of order"]
    }, {
      runId: "apply-out-of-order-run",
      taskId: "review-spec-intake"
    }));

    await assert.rejects(
      () => applyTaskResult(runResult.statePath, "review-spec-intake", resultPath),
      /(while it is pending|dependencies are completed)/i
    );

    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    assert.equal(runState.taskLedger.find((task) => task.id === "review-spec-intake")?.status, "pending");
    assert.equal(runState.taskLedger.find((task) => task.id === "verify-spec-intake")?.status, "pending");
  });

  await runTest("applyTaskResult rejects artifacts from another run or task", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-apply-foreign-result-"));
    const runResult = await runProject(validSpecPath, tempDir, "apply-foreign-result-run");
    const resultsDirectory = path.join(tempDir, "apply-foreign-result-run", "handoffs", "results");
    const foreignRunResultPath = path.join(resultsDirectory, "planning-brief.foreign-run.result.json");
    const foreignTaskResultPath = path.join(resultsDirectory, "planning-brief.foreign-task.result.json");

    await mkdir(resultsDirectory, { recursive: true });
    await writeJson(foreignRunResultPath, withArtifactIdentity({
      status: "completed",
      summary: "foreign run should be rejected",
      changedFiles: [],
      verification: ["manual check"],
      notes: ["wrong run id"]
    }, {
      runId: "different-run",
      taskId: "planning-brief"
    }));
    await writeJson(foreignTaskResultPath, withArtifactIdentity({
      status: "completed",
      summary: "foreign task should be rejected",
      changedFiles: [],
      verification: ["manual check"],
      notes: ["wrong task id"]
    }, {
      runId: "apply-foreign-result-run",
      taskId: "implement-spec-intake"
    }));

    await assert.rejects(
      () => applyTaskResult(runResult.statePath, "planning-brief", foreignRunResultPath),
      /belongs to run/i
    );
    await assert.rejects(
      () => applyTaskResult(runResult.statePath, "planning-brief", foreignTaskResultPath),
      /belongs to task/i
    );
  });

  await runTest("hybrid retry schedules a waiting window and records retry metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-retry-"));
    const runResult = await runProject(validSpecPath, tempDir, "retry-run");
    const result = await scheduleTaskRetry(
      runResult.statePath,
      "planning-brief",
      "请求频率过高，请稍后重试",
      3,
      path.join(projectRoot, "config", "factory.config.json")
    );
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const planningTask = runState.taskLedger.find((task) => task.id === "planning-brief");

    assert.equal(result.classification, "retryable_transient");
    assert.equal(result.escalated, false);
    assert.equal(planningTask?.status, "waiting_retry");
    assert.equal(planningTask?.retryCount, 1);
    assert.ok(typeof planningTask?.nextRetryAt === "string");
    assert.match(planningTask?.lastRetryReason ?? "", /频率过高/);
  });

  await runTest("hybrid retry rejects unknown task identifiers", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-retry-missing-task-"));
    const runResult = await runProject(validSpecPath, tempDir, "retry-missing-task-run");

    await assert.rejects(
      () => scheduleTaskRetry(runResult.statePath, "missing-task", "temporary server timeout"),
      /task not found/i
    );
  });

  await runTest("retry rejects tasks that are already completed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-retry-completed-"));
    const runResult = await runProject(validSpecPath, tempDir, "retry-completed-run");

    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");
    await assert.rejects(
      () => scheduleTaskRetry(runResult.statePath, "planning-brief", "force retry"),
      /cannot schedule a retry/i
    );

    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    assert.equal(runState.taskLedger.find((task) => task.id === "planning-brief")?.status, "completed");
    assert.ok(
      runState.taskLedger
        .filter((task) => task.id.startsWith("implement-"))
        .every((task) => task.status === "ready")
    );
  });

  await runTest("manual task updates preserve retry history while clearing stale retry windows", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-retry-history-"));
    const runResult = await runProject(validSpecPath, tempDir, "retry-history-run");

    await scheduleTaskRetry(
      runResult.statePath,
      "planning-brief",
      "temporary server timeout",
      3,
      path.join(projectRoot, "config", "factory.config.json")
    );

    const result = await updateRunTask(
      runResult.statePath,
      "planning-brief",
      "ready",
      "manual operator retry"
    );

    assert.equal(result.task?.status, "ready");
    assert.equal(result.task?.retryCount, 1);
    assert.equal(result.task?.lastRetryReason, "temporary server timeout");
    assert.equal(result.task?.nextRetryAt, null);
  });

  await runTest("handoff refresh promotes expired retry tasks back to ready", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-retry-ready-"));
    const runResult = await runProject(validSpecPath, tempDir, "retry-ready-run");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const modifiedRunState = {
      ...runState,
      taskLedger: runState.taskLedger.map((task) =>
        task.id === "planning-brief"
          ? {
              ...task,
              status: "waiting_retry",
              retryCount: 1,
              nextRetryAt: new Date(Date.now() - 60_000).toISOString(),
              lastRetryReason: "transient timeout"
            }
          : task
      )
    };

    await writeJson(runResult.statePath, modifiedRunState);
    const fakeDoctorPath = path.join(tempDir, "doctor.json");
    await writeFakeDoctorReport(fakeDoctorPath, {
      cursor: { ok: true }
    });

    const handoffResult = await createRunHandoffs(runResult.statePath, undefined, fakeDoctorPath);
    const refreshedRunState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const planningTask = refreshedRunState.taskLedger.find((task) => task.id === "planning-brief");

    assert.equal(planningTask?.status, "ready");
    assert.equal(planningTask?.nextRetryAt, null);
    assert.equal(handoffResult.readyTaskCount, 1);
    assert.equal(handoffResult.descriptors[0]?.taskId, "planning-brief");
  });

  await runTest("hybrid retry escalates to blocked after the configured retry limit", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-retry-escalate-"));
    const runResult = await runProject(validSpecPath, tempDir, "retry-escalate-run");

    await scheduleTaskRetry(
      runResult.statePath,
      "planning-brief",
      "响应超时，请发送继续",
      0,
      path.join(projectRoot, "config", "factory.config.json")
    );
    await scheduleTaskRetry(
      runResult.statePath,
      "planning-brief",
      "An unexpected error occurred on our servers.",
      0,
      path.join(projectRoot, "config", "factory.config.json")
    );
    const finalResult = await scheduleTaskRetry(
      runResult.statePath,
      "planning-brief",
      "请求频率过高，请稍后重试",
      0,
      path.join(projectRoot, "config", "factory.config.json")
    );
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const planningTask = runState.taskLedger.find((task) => task.id === "planning-brief");

    assert.equal(finalResult.escalated, true);
    assert.equal(planningTask?.status, "blocked");
    assert.equal(planningTask?.retryCount, 3);
    assert.ok(typeof planningTask?.nextRetryAt === "string");
  });

  await runTest("tick reopens blocked tasks after the unlock cooldown expires", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-blocked-unlock-"));
    const runResult = await runProject(validSpecPath, tempDir, "blocked-unlock-run");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const modifiedRunState = {
      ...runState,
      taskLedger: runState.taskLedger.map((task) =>
        task.id === "planning-brief"
          ? {
              ...task,
              status: "blocked",
              retryCount: 3,
              nextRetryAt: new Date(Date.now() - 60_000).toISOString(),
              lastRetryReason: "cooldown elapsed"
            }
          : task
      )
    };

    await writeJson(runResult.statePath, modifiedRunState);
    const fakeDoctorPath = path.join(tempDir, "doctor.json");
    await writeFakeDoctorReport(fakeDoctorPath, {
      cursor: { ok: true }
    });

    const result = await tickProjectRun(runResult.statePath, fakeDoctorPath);
    const refreshedRunState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const planningTask = refreshedRunState.taskLedger.find((task) => task.id === "planning-brief");

    assert.deepEqual(result.promotedRetryTasks, []);
    assert.ok(result.newlyReadyTasks.includes("planning-brief"));
    assert.equal(planningTask?.status, "ready");
    assert.equal(planningTask?.retryCount, 3);
    assert.equal(planningTask?.nextRetryAt, null);
  });

  await runTest("tick promotes expired retry tasks and rebuilds handoffs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-tick-ready-"));
    const runResult = await runProject(validSpecPath, tempDir, "tick-ready-run");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const modifiedRunState = {
      ...runState,
      taskLedger: runState.taskLedger.map((task) =>
        task.id === "planning-brief"
          ? {
              ...task,
              status: "waiting_retry",
              retryCount: 1,
              nextRetryAt: new Date(Date.now() - 60_000).toISOString(),
              lastRetryReason: "retry window elapsed"
            }
          : task
      )
    };

    await writeJson(runResult.statePath, modifiedRunState);
    const fakeDoctorPath = path.join(tempDir, "doctor.json");
    await writeFakeDoctorReport(fakeDoctorPath, {
      cursor: { ok: true }
    });

    const result = await tickProjectRun(runResult.statePath, fakeDoctorPath);
    const refreshedRunState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const planningTask = refreshedRunState.taskLedger.find((task) => task.id === "planning-brief");

    assert.deepEqual(result.promotedRetryTasks, ["planning-brief"]);
    assert.ok(result.newlyReadyTasks.includes("planning-brief"));
    assert.equal(result.readyTaskCount, 1);
    assert.equal(result.descriptors[0]?.taskId, "planning-brief");
    assert.equal(planningTask?.status, "ready");
    assert.equal(planningTask?.nextRetryAt, null);
  });

  await runTest("tick preserves future retry windows and emits an empty handoff index", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-tick-wait-"));
    const runResult = await runProject(validSpecPath, tempDir, "tick-wait-run");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const modifiedRunState = {
      ...runState,
      taskLedger: runState.taskLedger.map((task) =>
        task.id === "planning-brief"
          ? {
              ...task,
              status: "waiting_retry",
              retryCount: 1,
              nextRetryAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              lastRetryReason: "server error"
            }
          : task
      )
    };

    await writeJson(runResult.statePath, modifiedRunState);
    const fakeDoctorPath = path.join(tempDir, "doctor.json");
    await writeFakeDoctorReport(fakeDoctorPath, {
      cursor: { ok: true }
    });

    const result = await tickProjectRun(runResult.statePath, fakeDoctorPath);
    const refreshedRunState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const planningTask = refreshedRunState.taskLedger.find((task) => task.id === "planning-brief");

    assert.deepEqual(result.promotedRetryTasks, []);
    assert.deepEqual(result.newlyReadyTasks, []);
    assert.equal(result.readyTaskCount, 0);
    assert.equal(result.descriptors.length, 0);
    assert.equal(planningTask?.status, "waiting_retry");
  });

  await runTest("tick preserves waiting retry tasks when nextRetryAt is invalid", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-tick-invalid-retry-"));
    const runResult = await runProject(validSpecPath, tempDir, "tick-invalid-retry-run");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const modifiedRunState = {
      ...runState,
      taskLedger: runState.taskLedger.map((task) =>
        task.id === "planning-brief"
          ? {
              ...task,
              status: "waiting_retry",
              retryCount: 1,
              nextRetryAt: "not-a-date",
              lastRetryReason: "bad timestamp"
            }
          : task
      )
    };

    await writeJson(runResult.statePath, modifiedRunState);
    const fakeDoctorPath = path.join(tempDir, "doctor.json");
    await writeFakeDoctorReport(fakeDoctorPath, {
      cursor: { ok: true }
    });

    const result = await tickProjectRun(runResult.statePath, fakeDoctorPath);
    const refreshedRunState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const planningTask = refreshedRunState.taskLedger.find((task) => task.id === "planning-brief");

    assert.deepEqual(result.promotedRetryTasks, []);
    assert.deepEqual(result.newlyReadyTasks, []);
    assert.equal(result.readyTaskCount, 0);
    assert.equal(planningTask?.status, "waiting_retry");
    assert.equal(planningTask?.nextRetryAt, "not-a-date");
  });

  await runTest("refresh downgrades ready tasks when a dependency is manually reopened in state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-refresh-downgrade-"));
    const runResult = await runProject(validSpecPath, tempDir, "refresh-downgrade-run");

    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const modifiedRunState = {
      ...runState,
      taskLedger: runState.taskLedger.map((task) =>
        task.id === "planning-brief"
          ? {
              ...task,
              status: "ready"
            }
          : task
      )
    };

    await writeJson(runResult.statePath, modifiedRunState);
    await reportProjectRun(runResult.statePath);

    const refreshedRunState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    assert.equal(refreshedRunState.taskLedger.find((task) => task.id === "planning-brief")?.status, "ready");
    assert.ok(
      refreshedRunState.taskLedger
        .filter((task) => task.id.startsWith("implement-"))
        .every((task) => task.status === "pending")
    );
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
      bindArtifactScriptIdentity(buildResultArtifactScript(descriptor.resultPath, {
        status: "completed",
        summary: "missing notes array on purpose",
        changedFiles: "src/index.mjs",
        verification: ["npm test"]
      }), descriptor),
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
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId,
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
        bindArtifactScriptIdentity(buildResultArtifactScript(descriptor.resultPath, {
          status: "completed",
          summary: `completed ${descriptor.taskId}`,
          changedFiles: [`src/features/${index}.mjs`],
          verification: ["npm test", "npm run test:e2e"],
          notes: [`artifact ok for ${descriptor.taskId}`]
        }), descriptor),
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
