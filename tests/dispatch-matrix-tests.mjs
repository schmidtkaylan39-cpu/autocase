import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRunHandoffs, initProject, runProject, updateRunTask } from "../src/lib/commands.mjs";
import { dispatchHandoffs } from "../src/lib/dispatch.mjs";
import { writeJson } from "../src/lib/fs-utils.mjs";
import { getLauncherMetadata } from "../src/lib/handoffs.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validSpecPath = path.join(projectRoot, "examples", "project-spec.valid.json");

function computeDescriptorIdempotencyKey(descriptor) {
  const promptHash =
    descriptor.prompt?.hash ??
    descriptor.launcher?.metadata?.promptHash ??
    null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        runId: descriptor.runId ?? null,
        taskId: descriptor.taskId ?? descriptor.task?.id ?? null,
        handoffId: descriptor.handoffId ?? null,
        runtimeId: descriptor.runtime?.id ?? null,
        promptHash
      }),
      "utf8"
    )
    .digest("hex");
}

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

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => `${key} = ${toPowerShellLiteral(item)}`);
    return `@{ ${entries.join("; ")} }`;
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

function escapeShellSingleQuoted(value) {
  return String(value).replace(/'/g, `'"'"'`);
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
    .replaceAll("{{RUN_ID}}", descriptor.runId ?? "fixture-run")
    .replaceAll("{{TASK_ID}}", descriptor.taskId)
    .replaceAll("{{HANDOFF_ID}}", descriptor.handoffId ?? "fixture-handoff");
}

function buildRawResultScript(resultPath, rawContent) {
  if (process.platform === "win32") {
    const escapedResultPath = escapePowerShellSingleQuoted(resultPath);
    const escapedRawContent = escapePowerShellSingleQuoted(rawContent);
    return `Set-Content -Path '${escapedResultPath}' -Value '${escapedRawContent}' -Encoding utf8\n`;
  }

  return `cat > '${escapeShellSingleQuoted(resultPath)}' <<'RAW'
${rawContent}
RAW
`;
}

function buildBarrierResultArtifactScript(resultPath, artifact, syncDirectory, markerName, expectedCount) {
  if (process.platform === "win32") {
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

  const barrierLines = [
    `syncDirectory='${escapeShellSingleQuoted(syncDirectory)}'`,
    'mkdir -p "$syncDirectory"',
    `markerPath="$syncDirectory/${markerName}.started"`,
    'printf "ready\n" > "$markerPath"',
    `expectedCount=${expectedCount}`,
    'while [ "$(find "$syncDirectory" -maxdepth 1 -name "*.started" | wc -l | tr -d " ")" -lt "$expectedCount" ]; do',
    '  sleep 0.025',
    'done'
  ];

  return `${barrierLines.join("\n")}\n${buildResultArtifactScript(resultPath, artifact)}`;
}

function buildMarkerResultArtifactScript(resultPath, artifact, markerDirectory) {
  if (process.platform === "win32") {
    const escapedMarkerDirectory = escapePowerShellSingleQuoted(markerDirectory);
    const markerLines = [
      `$markerDirectory = '${escapedMarkerDirectory}'`,
      "New-Item -ItemType Directory -Force -Path $markerDirectory | Out-Null",
      "$markerPath = Join-Path $markerDirectory ([guid]::NewGuid().ToString() + '.txt')",
      "Set-Content -Path $markerPath -Value 'ran' -Encoding utf8",
      "Start-Sleep -Milliseconds 300"
    ];

    return `${markerLines.join("\n")}\n${buildResultArtifactScript(resultPath, artifact)}`;
  }

  const markerLines = [
    `markerDirectory='${escapeShellSingleQuoted(markerDirectory)}'`,
    'mkdir -p "$markerDirectory"',
    'markerPath="$markerDirectory/$(date +%s%N).txt"',
    'printf "ran\n" > "$markerPath"',
    'sleep 0.3'
  ];

  return `${markerLines.join("\n")}\n${buildResultArtifactScript(resultPath, artifact)}`;
}

function buildMarkerOnlyScript(markerDirectory) {
  if (process.platform === "win32") {
    return [
      `$markerDirectory = '${escapePowerShellSingleQuoted(markerDirectory)}'`,
      "New-Item -ItemType Directory -Force -Path $markerDirectory | Out-Null",
      "$markerPath = Join-Path $markerDirectory 'launcher-ran.txt'",
      "Set-Content -Path $markerPath -Value 'ran' -Encoding utf8"
    ].join("\n");
  }

  return [
    `markerDirectory='${escapeShellSingleQuoted(markerDirectory)}'`,
    'mkdir -p "$markerDirectory"',
    'printf "ran\n" > "$markerDirectory/launcher-ran.txt"'
  ].join("\n");
}

function buildLargeStderrArtifactScript(
  resultPath,
  artifact,
  {
    chunkSize = 4096,
    repeatCount = 320,
    tailMarker = "stderr-tail-marker"
  } = {}
) {
  const stderrChunk = "E".repeat(chunkSize);

  if (process.platform === "win32") {
    const lines = [
      `$stderrChunk = '${escapePowerShellSingleQuoted(stderrChunk)}'`,
      `for ($i = 0; $i -lt ${repeatCount}; $i++) { [Console]::Error.WriteLine($stderrChunk) }`,
      `[Console]::Error.WriteLine('${escapePowerShellSingleQuoted(tailMarker)}')`
    ];

    return `${lines.join("\n")}\n${buildResultArtifactScript(resultPath, artifact)}`;
  }

  const lines = [
    `stderrChunk='${escapeShellSingleQuoted(stderrChunk)}'`,
    "i=0",
    `while [ \"$i\" -lt ${repeatCount} ]; do`,
    "  printf '%s\\n' \"$stderrChunk\" >&2",
    "  i=$((i + 1))",
    "done",
    `printf '%s\\n' '${escapeShellSingleQuoted(tailMarker)}' >&2`
  ];

  return `${lines.join("\n")}\n${buildResultArtifactScript(resultPath, artifact)}`;
}

function buildTransientGptRunnerRecoveryScript(
  resultPath,
  artifact,
  {
    attemptCounterFileName = ".gpt-runner-attempt.txt",
    transientMessage = "503 Service Unavailable: transient upstream failure"
  } = {}
) {
  if (process.platform === "win32") {
    const lines = [
      `$resultPath = '${escapePowerShellSingleQuoted(resultPath)}'`,
      `$attemptCounterPath = Join-Path (Split-Path -Parent $resultPath) '${escapePowerShellSingleQuoted(
        attemptCounterFileName
      )}'`,
      "$attemptCount = 0",
      "if (Test-Path -LiteralPath $attemptCounterPath) {",
      "  $attemptCount = [int](Get-Content -LiteralPath $attemptCounterPath -Raw)",
      "}",
      "$attemptCount += 1",
      "Set-Content -LiteralPath $attemptCounterPath -Value $attemptCount -Encoding utf8",
      "if ($attemptCount -eq 1) {",
      `  [Console]::Error.WriteLine('${escapePowerShellSingleQuoted(transientMessage)}')`,
      "  exit 1",
      "}"
    ];

    return `${lines.join("\n")}\n${buildResultArtifactScript(resultPath, artifact)}`;
  }

  const lines = [
    `resultPath='${escapeShellSingleQuoted(resultPath)}'`,
    `attemptCounterPath="$(dirname "$resultPath")/${escapeShellSingleQuoted(attemptCounterFileName)}"`,
    "attemptCount=0",
    'if [ -f "$attemptCounterPath" ]; then',
    '  attemptCount="$(cat "$attemptCounterPath")"',
    "fi",
    "attemptCount=$((attemptCount + 1))",
    'printf "%s" "$attemptCount" > "$attemptCounterPath"',
    'if [ "$attemptCount" -eq 1 ]; then',
    `  printf '%s\\n' '${escapeShellSingleQuoted(transientMessage)}' >&2`,
    "  exit 1",
    "fi"
  ];

  return `${lines.join("\n")}\n${buildResultArtifactScript(resultPath, artifact)}`;
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
  const runtimeIds = ["openclaw", "cursor", "gpt-runner", "codex", "local-ci"];
  const checks = runtimeIds.map((runtimeId) => ({
    id: runtimeId,
    installed: true,
    ok: false,
    ...(overrides[runtimeId] ?? {})
  }));

  await writeJson(filePath, { checks });
}

async function expandHandoffDescriptor(descriptor) {
  if (!descriptor?.handoffJsonPath) {
    return descriptor;
  }

  const persistedDescriptor = JSON.parse(await readFile(descriptor.handoffJsonPath, "utf8"));

  return {
    ...persistedDescriptor,
    ...descriptor,
    runtime: {
      ...(persistedDescriptor.runtime ?? {}),
      ...(descriptor.runtime ?? {})
    },
    launcher: {
      ...(persistedDescriptor.launcher ?? {}),
      ...(descriptor.launcher ?? {})
    },
    prompt: descriptor.prompt ?? persistedDescriptor.prompt,
    execution: descriptor.execution ?? persistedDescriptor.execution,
    promptPath:
      descriptor.promptPath ??
      persistedDescriptor.promptPath ??
      persistedDescriptor.paths?.promptPath,
    resultPath:
      descriptor.resultPath ??
      persistedDescriptor.resultPath ??
      persistedDescriptor.paths?.resultPath
  };
}

async function createDispatchReadyRun(tempDir, runId, doctorOverrides = {}) {
  const runResult = await runProject(validSpecPath, tempDir, runId);
  const doctorReportPath = path.join(tempDir, `${runId}.doctor.json`);
  await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");
  await writeFakeDoctorReport(doctorReportPath, doctorOverrides);

  const handoffResult = await createRunHandoffs(runResult.statePath, undefined, doctorReportPath);
  const baseDescriptor = await expandHandoffDescriptor(handoffResult.descriptors[0]);

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

async function createReviewDispatchReadyRun(tempDir, runId, doctorOverrides = {}) {
  const runResult = await runProject(validSpecPath, tempDir, runId);
  const doctorReportPath = path.join(tempDir, `${runId}.doctor.json`);

  await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");
  await updateRunTask(runResult.statePath, "implement-spec-intake", "completed", "executor finished");
  await writeFakeDoctorReport(doctorReportPath, doctorOverrides);

  const handoffResult = await createRunHandoffs(runResult.statePath, undefined, doctorReportPath);
  const baseDescriptor = await expandHandoffDescriptor(
    handoffResult.descriptors.find((descriptor) => descriptor.taskId === "review-spec-intake")
  );

  if (!baseDescriptor) {
    throw new Error("Expected a review-spec-intake handoff descriptor.");
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

async function createPlannerDispatchReadyRun(tempDir, runId, doctorOverrides = {}) {
  const runResult = await runProject(validSpecPath, tempDir, runId);
  const doctorReportPath = path.join(tempDir, `${runId}.doctor.json`);

  await writeFakeDoctorReport(doctorReportPath, doctorOverrides);

  const handoffResult = await createRunHandoffs(runResult.statePath, undefined, doctorReportPath);
  const baseDescriptor = await expandHandoffDescriptor(
    handoffResult.descriptors.find((descriptor) => descriptor.taskId === "planning-brief")
  );

  if (!baseDescriptor) {
    throw new Error("Expected a planning-brief handoff descriptor.");
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

async function createVerifierDispatchReadyRun(tempDir, runId, doctorOverrides = {}) {
  const workspaceRoot = path.join(tempDir, "workspace");
  const specPath = path.join(workspaceRoot, "specs", "project-spec.json");
  const doctorReportPath = path.join(tempDir, `${runId}.doctor.json`);
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const baseSpec = JSON.parse(await readFile(validSpecPath, "utf8"));
  const singleFeatureSpec = {
    ...baseSpec,
    coreFeatures: Array.isArray(baseSpec.coreFeatures) ? baseSpec.coreFeatures.slice(0, 1) : []
  };
  const packageJson = {
    name: "ai-factory-verifier-fixture",
    private: true,
    version: "1.0.0",
    scripts: {
      build: 'node -e "console.log(\'build ok\')"',
      lint: 'node -e "console.log(\'lint ok\')"',
      typecheck: 'node -e "console.log(\'typecheck ok\')"',
      test: 'node -e "console.log(\'test ok\')"',
      "test:integration": 'node -e "console.log(\'integration ok\')"',
      "test:e2e": 'node -e "console.log(\'e2e ok\')"'
    }
  };

  await initProject(workspaceRoot);
  await writeFile(specPath, `${JSON.stringify(singleFeatureSpec, null, 2)}\n`, "utf8");
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const runResult = await runProject(specPath, path.join(workspaceRoot, "runs"), runId);

  await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");
  await updateRunTask(runResult.statePath, "implement-spec-intake", "completed", "executor finished");
  await updateRunTask(runResult.statePath, "review-spec-intake", "completed", "reviewer finished");
  await writeFakeDoctorReport(doctorReportPath, doctorOverrides);

  const handoffResult = await createRunHandoffs(runResult.statePath, undefined, doctorReportPath);
  const baseDescriptor = await expandHandoffDescriptor(
    handoffResult.descriptors.find((descriptor) => descriptor.taskId === "verify-spec-intake")
  );

  if (!baseDescriptor) {
    throw new Error("Expected a verify-spec-intake handoff descriptor.");
  }

  return {
    runResult,
    handoffResult,
    descriptor: {
      ...baseDescriptor,
      runtime: { ...baseDescriptor.runtime }
    },
    runDirectory: path.dirname(runResult.statePath),
    reportPath: path.join(path.dirname(runResult.statePath), "report.md"),
    workspaceRoot
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
      '      summary: "fake gpt-runner completed the task",',
      '      changedFiles: ["src/lib/handoffs.mjs"],',
      '      verification: ["fake-codex contract test"],',
      '      notes: ["simulated gpt-runner launcher execution"]',
      "    },",
      "    null,",
      "    2",
      "  ),",
      '  "utf8"',
      ");",
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

async function limitDispatchToDescriptors(indexPath, runId, descriptors) {
  const existingIndex = await (async () => {
    try {
      return JSON.parse(await readFile(indexPath, "utf8"));
    } catch {
      return {};
    }
  })();

  await writeJson(indexPath, {
    ...existingIndex,
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
  doctorOverrides = { codex: { ok: true } },
  beforeDispatch = null
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
  descriptor.execution = {
    ...descriptor.execution,
    idempotencyKey: computeDescriptorIdempotencyKey(descriptor)
  };

  await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
  const resolvedLauncherScript = bindArtifactScriptIdentity(
    launcherScript.replaceAll("{{RESULT_PATH}}", descriptor.resultPath),
    descriptor
  );
  await writeFile(descriptor.launcherPath, resolvedLauncherScript, "utf8");

  if (typeof beforeDispatch === "function") {
    await beforeDispatch({
      tempDir,
      runResult,
      handoffResult,
      descriptor,
      reportPath
    });
  }

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
    assert.equal(dispatchResult.summary.executed, 1);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "failed"
    });
    assert.equal(task.status, "failed");
    assert.match(report, new RegExp(`\\[failed\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: blocked reviewer artifacts can reopen implementation via automationDecision", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-review-rework-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createReviewDispatchReadyRun(
      tempDir,
      `review-rework-${Date.now()}`,
      {
        codex: { ok: true },
        "gpt-runner": { ok: true }
      }
    );

    descriptor.runtime = {
      ...descriptor.runtime,
      id: "gpt-runner",
      label: "gpt-runner",
      mode: "automated"
    };

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    const resolvedLauncherScript = bindArtifactScriptIdentity(
      buildResultArtifactScript("{{RESULT_PATH}}", {
        status: "blocked",
        summary: "review requested another implementation round",
        changedFiles: ["src/lib/commands.mjs"],
        verification: ["manual review"],
        notes: ["rework feature automatically"],
        automationDecision: {
          action: "rework_feature",
          targetTaskId: "implement-spec-intake",
          reason: "review found a concrete bug"
        }
      }).replaceAll("{{RESULT_PATH}}", descriptor.resultPath),
      descriptor
    );
    await writeFile(descriptor.launcherPath, resolvedLauncherScript, "utf8");

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const implementationTask = runState.taskLedger.find((item) => item.id === "implement-spec-intake");
    const reviewTask = runState.taskLedger.find((item) => item.id === "review-spec-intake");
    const verificationTask = runState.taskLedger.find((item) => item.id === "verify-spec-intake");
    const result = dispatchResult.results[0];

    assert.equal(result.status, "continued");
    assert.equal(result.nextTaskStatus, "pending");
    assert.equal(dispatchResult.summary.continued, 1);
    assert.equal(implementationTask?.status, "ready");
    assert.equal(reviewTask?.status, "pending");
    assert.equal(verificationTask?.status, "pending");
    assert.ok(
      dispatchResult.runStateSync?.updatedTasks?.some(
        (task) => task.taskId === "implement-spec-intake" && task.nextStatus === "ready"
      )
    );
    assert.ok(
      dispatchResult.runStateSync?.updatedTasks?.some(
        (task) => task.taskId === "review-spec-intake" && task.nextStatus === "pending"
      )
    );
    assert.match(report, /\[ready\] implement-spec-intake ->/);
    assert.match(report, /\[pending\] review-spec-intake ->/);
  });

  await runTest("matrix: generated gpt-runner launcher can execute end-to-end through fake codex", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-gpt-runner-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createPlannerDispatchReadyRun(
      tempDir,
      `gpt-runner-${Date.now()}`,
      {
        "gpt-runner": { ok: true },
        codex: { ok: true }
      }
    );
    const fakeBinDir = path.join(tempDir, "fake-bin");
    const previousPath = process.env.PATH;

    await createFakeCodexBinary(fakeBinDir);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath ?? ""}`;

    try {
      await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);

      const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
      const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
      const report = await readFile(reportPath, "utf8");
      const planningTask = runState.taskLedger.find((item) => item.id === "planning-brief");
      const implementationTask = runState.taskLedger.find((item) => item.id === "implement-spec-intake");
      const result = dispatchResult.results[0];

      assert.equal(descriptor.runtime.id, "gpt-runner");
      assert.equal(result.status, "completed");
      assert.equal(planningTask?.status, "completed");
      assert.equal(implementationTask?.status, "ready");
      assert.match(report, /\[completed\] planning-brief ->/);
      assert.match(report, /\[ready\] implement-spec-intake ->/);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  await runTest("matrix: generated local-ci launcher can execute a verifier task end-to-end", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-local-ci-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createVerifierDispatchReadyRun(
      tempDir,
      `local-ci-${Date.now()}`,
      {
        "local-ci": { ok: true }
      }
    );

    assert.equal(descriptor.runtime.id, "local-ci");
    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const verificationTask = runState.taskLedger.find((item) => item.id === "verify-spec-intake");
    const deliveryTask = runState.taskLedger.find((item) => item.id === "delivery-package");
    const result = dispatchResult.results[0];

    assert.equal(result.status, "completed");
    assert.equal(dispatchResult.summary.completed, 1);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: "verify-spec-intake",
      nextStatus: "completed"
    });
    assert.equal(verificationTask?.status, "completed");
    assert.equal(deliveryTask?.status, "ready");
    assert.deepEqual(result.artifact?.changedFiles, []);
    assert.deepEqual(result.artifact?.verification, [
      "npm run build",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run test:integration",
      "npm run test:e2e"
    ]);
    assert.match(result.artifact?.summary ?? "", /local-ci completed 6 verification command/);
    assert.match(report, /\[completed\] verify-spec-intake ->/);
    assert.match(report, /\[ready\] delivery-package ->/);
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
      launcherScript: process.platform === "win32" ? "Write-Output 'no artifact generated'\n" : "printf 'no artifact generated\\n'\n"
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

  await runTest("matrix: stale pre-existing result artifacts are deleted before execution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-stale-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
      tempDir,
      `stale-result-${Date.now()}`,
      { codex: { ok: true } }
    );

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await writeJson(descriptor.resultPath, {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId,
      status: "completed",
      summary: "stale artifact should not be reused",
      changedFiles: ["src/lib/dispatch.mjs"],
      verification: ["npm test"],
      notes: ["old result"]
    });
    await writeFile(
      descriptor.launcherPath,
      process.platform === "win32"
        ? "Write-Output 'launcher produced no new artifact'\n"
        : "printf 'launcher produced no new artifact\\n'\n",
      "utf8"
    );

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);
    const result = dispatchResult.results[0];

    assert.equal(result.status, "incomplete");
    assert.match(result.note ?? "", /not written/i);
    assert.equal(task?.status, "blocked");
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: restart recovery consumes an existing valid result artifact without rerunning the launcher", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-restart-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
      tempDir,
      `restart-recovery-${Date.now()}`,
      { codex: { ok: true } }
    );
    const markerDirectory = path.join(tempDir, "restart-marker");

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await updateRunTask(runResult.statePath, descriptor.taskId, "in_progress", "simulate crash after launcher artifact write");
    await writeJson(descriptor.resultPath, {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId,
      status: "completed",
      summary: "artifact survived the crash window",
      changedFiles: ["src/lib/dispatch.mjs"],
      verification: ["npm test"],
      notes: ["restart recovery fixture"]
    });
    await writeFile(
      descriptor.launcherPath,
      process.platform === "win32"
        ? [
            `$markerDirectory = '${escapePowerShellSingleQuoted(markerDirectory)}'`,
            "New-Item -ItemType Directory -Force -Path $markerDirectory | Out-Null",
            "$markerPath = Join-Path $markerDirectory 'launcher-ran.txt'",
            "Set-Content -Path $markerPath -Value 'ran' -Encoding utf8"
          ].join("\n")
        : [
            `markerDirectory='${escapeShellSingleQuoted(markerDirectory)}'`,
            'mkdir -p "$markerDirectory"',
            'printf "ran\n" > "$markerDirectory/launcher-ran.txt"'
          ].join("\n"),
      "utf8"
    );

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const result = dispatchResult.results[0];
    const markerFiles = await readdir(markerDirectory).catch(() => []);
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

    assert.equal(result?.status, "completed");
    assert.match(result?.note ?? "", /recovered existing result artifact after restart/i);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "completed"
    });
    assert.equal(task?.status, "completed");
    assert.equal(markerFiles.length, 0);
    assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: restart recovery still succeeds when a leftover execution lock exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-restart-lock-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
      tempDir,
      `restart-recovery-lock-${Date.now()}`,
      { codex: { ok: true } }
    );
    const markerDirectory = path.join(tempDir, "restart-lock-marker");
    const executionLockPath = `${path.resolve(descriptor.resultPath)}.execute.lock`;

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await updateRunTask(runResult.statePath, descriptor.taskId, "in_progress", "simulate crash before execution lock release");
    await writeJson(descriptor.resultPath, {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId,
      status: "completed",
      summary: "artifact survived with a leftover execution lock",
      changedFiles: ["src/lib/dispatch.mjs"],
      verification: ["npm test"],
      notes: ["restart recovery with lock fixture"]
    });
    await writeFile(executionLockPath, "crashed-dispatch\n", "utf8");
    await writeFile(
      descriptor.launcherPath,
      process.platform === "win32"
        ? [
            `$markerDirectory = '${escapePowerShellSingleQuoted(markerDirectory)}'`,
            "New-Item -ItemType Directory -Force -Path $markerDirectory | Out-Null",
            "$markerPath = Join-Path $markerDirectory 'launcher-ran.txt'",
            "Set-Content -Path $markerPath -Value 'ran' -Encoding utf8"
          ].join("\n")
        : [
            `markerDirectory='${escapeShellSingleQuoted(markerDirectory)}'`,
            'mkdir -p "$markerDirectory"',
            'printf "ran\n" > "$markerDirectory/launcher-ran.txt"'
          ].join("\n"),
      "utf8"
    );

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const result = dispatchResult.results[0];
    const markerFiles = await readdir(markerDirectory).catch(() => []);
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

    assert.equal(result?.status, "completed");
    assert.match(result?.note ?? "", /previous execution lock was still present/i);
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "completed"
    });
    assert.equal(task?.status, "completed");
    assert.equal(markerFiles.length, 0);
    assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: artifacts with mismatched handoff identity are rejected", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-identity-",
      runtimeId: "codex",
      launcherScript: buildResultArtifactScript("{{RESULT_PATH}}", {
        handoffId: "foreign-handoff",
        status: "completed",
        summary: "identity mismatch should be rejected",
        changedFiles: ["src/lib/dispatch.mjs"],
        verification: ["npm test"],
        notes: ["wrong handoff id"]
      })
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "incomplete");
    assert.match(result.note ?? "", /handoffId mismatch/i);
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
        launcherScript: process.platform === "win32" ? "Start-Sleep -Milliseconds 300\n" : "sleep 0.3\n"
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

  await runTest("matrix: launcher timeout still applies a valid result artifact when one was written", async () => {
    const previousTimeout = process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS;
    process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS = "600";

    try {
      const launcherScript = `${buildResultArtifactScript("{{RESULT_PATH}}", {
        status: "completed",
        summary: "artifact was written before the launcher timed out",
        changedFiles: ["src/lib/dispatch.mjs"],
        verification: ["npm test"],
        notes: ["timeout recovery path"]
      })}${process.platform === "win32" ? "Start-Sleep -Milliseconds 1200\n" : "sleep 1.2\n"}`;
      const scenario = await runSingleDescriptorDispatchScenario({
        tempPrefix: "ai-factory-matrix-timeout-artifact-",
        runtimeId: "codex",
        launcherScript
      });
      const { descriptor, dispatchResult, report, task } = scenario;
      const result = dispatchResult.results[0];

      assert.equal(result.status, "completed");
      assert.match(result.note ?? "", /timed out after writing a valid result artifact/i);
      assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
        taskId: descriptor.taskId,
        nextStatus: "completed"
      });
      assert.equal(task.status, "completed");
      assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS;
      } else {
        process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  await runTest("matrix: large stderr still completes with a valid artifact and stores only the tail", async () => {
    const previousMaxBuffer = process.env.AI_FACTORY_LAUNCHER_MAX_BUFFER_BYTES;
    const previousTailBytes = process.env.AI_FACTORY_DISPATCH_OUTPUT_TAIL_BYTES;
    const tailLimitBytes = 64 * 1024;
    const tailMarker = "stderr-tail-marker";

    delete process.env.AI_FACTORY_LAUNCHER_MAX_BUFFER_BYTES;
    delete process.env.AI_FACTORY_DISPATCH_OUTPUT_TAIL_BYTES;

    try {
      const scenario = await runSingleDescriptorDispatchScenario({
        tempPrefix: "ai-factory-matrix-large-stderr-",
        runtimeId: "codex",
        launcherScript: buildLargeStderrArtifactScript(
          "{{RESULT_PATH}}",
          {
            status: "completed",
            summary: "large stderr does not exhaust launcher buffering",
            changedFiles: ["src/lib/dispatch.mjs"],
            verification: ["node tests/dispatch-matrix-tests.mjs"],
            notes: ["large stderr path"]
          },
          { tailMarker }
        )
      });
      const { descriptor, dispatchResult, report, task } = scenario;
      const result = dispatchResult.results[0];
      const persistedDispatchResult = JSON.parse(await readFile(dispatchResult.resultJsonPath, "utf8"));
      const persistedResult = persistedDispatchResult.results[0];

      assert.equal(result.status, "completed");
      assert.equal(dispatchResult.summary.completed, 1);
      assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
        taskId: descriptor.taskId,
        nextStatus: "completed"
      });
      assert.equal(task.status, "completed");
      assert.ok(!/maxBuffer exceeded/i.test(result.error ?? ""));
      assert.ok(result.stderr.includes(tailMarker));
      assert.ok(persistedResult.stderr.includes(tailMarker));
      assert.ok(result.stderr.length <= tailLimitBytes);
      assert.ok(persistedResult.stderr.length <= tailLimitBytes);
      assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
    } finally {
      if (previousMaxBuffer === undefined) {
        delete process.env.AI_FACTORY_LAUNCHER_MAX_BUFFER_BYTES;
      } else {
        process.env.AI_FACTORY_LAUNCHER_MAX_BUFFER_BYTES = previousMaxBuffer;
      }

      if (previousTailBytes === undefined) {
        delete process.env.AI_FACTORY_DISPATCH_OUTPUT_TAIL_BYTES;
      } else {
        process.env.AI_FACTORY_DISPATCH_OUTPUT_TAIL_BYTES = previousTailBytes;
      }
    }
  });

  await runTest("matrix: dead-pid execute lock is reclaimed immediately and execution still completes", async () => {
    const deadPid = 999999;
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-dead-lock-",
      runtimeId: "codex",
      launcherScript: buildResultArtifactScript("{{RESULT_PATH}}", {
        status: "completed",
        summary: "dead lock recovery path completed",
        changedFiles: ["src/lib/dispatch.mjs"],
        verification: ["node tests/dispatch-matrix-tests.mjs"],
        notes: ["dead pid execute lock recovery"]
      }),
      beforeDispatch: async ({ descriptor }) => {
        const lockPath = `${descriptor.resultPath}.execute.lock`;
        await writeFile(lockPath, `${deadPid} ${new Date().toISOString()}\n`, "utf8");
      }
    });
    const { dispatchResult, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "completed");
    assert.equal(dispatchResult.summary.completed, 1);
    assert.equal(task.status, "completed");
    assert.match(result.note ?? "", /Recovered stale orphaned execution lock/i);
    assert.doesNotMatch(result.note ?? "", /Another dispatch process is already executing/i);
  });

  await runTest("matrix: gpt-runner transient upstream failures retry within one dispatch and then complete", async () => {
    const previousLauncherAttempts = process.env.AI_FACTORY_GPT_RUNNER_LAUNCHER_ATTEMPTS;
    const previousRetryBaseDelayMs = process.env.AI_FACTORY_GPT_RUNNER_RETRY_BASE_DELAY_MS;
    const previousRetryMaxDelayMs = process.env.AI_FACTORY_GPT_RUNNER_RETRY_MAX_DELAY_MS;
    const attemptCounterFileName = ".gpt-runner-attempt.txt";
    process.env.AI_FACTORY_GPT_RUNNER_LAUNCHER_ATTEMPTS = "2";
    process.env.AI_FACTORY_GPT_RUNNER_RETRY_BASE_DELAY_MS = "1";
    process.env.AI_FACTORY_GPT_RUNNER_RETRY_MAX_DELAY_MS = "1";

    try {
      const scenario = await runSingleDescriptorDispatchScenario({
        tempPrefix: "ai-factory-matrix-gpt-runner-transient-",
        runtimeId: "gpt-runner",
        doctorOverrides: { "gpt-runner": { ok: true } },
        launcherScript: buildTransientGptRunnerRecoveryScript(
          "{{RESULT_PATH}}",
          {
            status: "completed",
            summary: "transient upstream launcher failure recovered on retry",
            changedFiles: ["src/lib/dispatch.mjs"],
            verification: ["node tests/dispatch-matrix-tests.mjs"],
            notes: ["gpt-runner transient retry path"]
          },
          { attemptCounterFileName }
        )
      });
      const { descriptor, dispatchResult, report, task } = scenario;
      const result = dispatchResult.results[0];
      const attemptCounterPath = path.join(path.dirname(descriptor.resultPath), attemptCounterFileName);
      let attemptCounter = null;

      try {
        attemptCounter = await readFile(attemptCounterPath, "utf8");
      } catch {
        attemptCounter = null;
      }

      assert.equal(result.status, "completed");
      assert.equal(dispatchResult.summary.completed, 1);
      assert.equal(task.status, "completed");
      assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
        taskId: descriptor.taskId,
        nextStatus: "completed"
      });
      assert.equal(attemptCounter?.trim(), "2");
      assert.doesNotMatch(result.error ?? "", /service unavailable|maxbuffer/i);
      assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
    } finally {
      if (previousLauncherAttempts === undefined) {
        delete process.env.AI_FACTORY_GPT_RUNNER_LAUNCHER_ATTEMPTS;
      } else {
        process.env.AI_FACTORY_GPT_RUNNER_LAUNCHER_ATTEMPTS = previousLauncherAttempts;
      }

      if (previousRetryBaseDelayMs === undefined) {
        delete process.env.AI_FACTORY_GPT_RUNNER_RETRY_BASE_DELAY_MS;
      } else {
        process.env.AI_FACTORY_GPT_RUNNER_RETRY_BASE_DELAY_MS = previousRetryBaseDelayMs;
      }

      if (previousRetryMaxDelayMs === undefined) {
        delete process.env.AI_FACTORY_GPT_RUNNER_RETRY_MAX_DELAY_MS;
      } else {
        process.env.AI_FACTORY_GPT_RUNNER_RETRY_MAX_DELAY_MS = previousRetryMaxDelayMs;
      }
    }
  });

  await runTest("matrix: descriptor timeoutMs is enforced without environment overrides", async () => {
    const previousTimeout = process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS;
    delete process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS;

    try {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-step-timeout-"));
      const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
        tempDir,
        `step-timeout-${Date.now()}`,
        { codex: { ok: true } }
      );

      descriptor.execution = {
        ...descriptor.execution,
        timeoutMs: 100
      };

      await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
      await writeFile(
        descriptor.launcherPath,
        process.platform === "win32" ? "Start-Sleep -Milliseconds 300\n" : "sleep 0.3\n",
        "utf8"
      );

      const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
      const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
      const report = await readFile(reportPath, "utf8");
      const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);
      const result = dispatchResult.results[0];

      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /timed out/i);
      assert.equal(task?.status, "failed");
      assert.match(report, new RegExp(`\\[failed\\] ${descriptor.taskId} ->`));
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS;
      } else {
        process.env.AI_FACTORY_POWERSHELL_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  await runTest("matrix: prompt hash mismatches fail before launcher execution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-prompt-hash-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
      tempDir,
      `prompt-hash-${Date.now()}`,
      { codex: { ok: true } }
    );
    const markerDirectory = path.join(tempDir, "prompt-hash-markers");

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await writeFile(descriptor.launcherPath, buildMarkerOnlyScript(markerDirectory), "utf8");
    await writeFile(descriptor.promptPath, "tampered prompt\n", "utf8");

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const result = dispatchResult.results[0];
    const markerFiles = await readdir(markerDirectory).catch(() => []);
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /prompt hash mismatch/i);
    assert.equal(markerFiles.length, 0);
    assert.equal(task?.status, "failed");
    assert.match(report, new RegExp(`\\[failed\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: retry budget guard blocks execution before the launcher starts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-retry-budget-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
      tempDir,
      `retry-budget-${Date.now()}`,
      { codex: { ok: true } }
    );
    const markerDirectory = path.join(tempDir, "retry-budget-markers");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await writeFile(descriptor.launcherPath, buildMarkerOnlyScript(markerDirectory), "utf8");
    await writeJson(runResult.statePath, {
      ...runState,
      taskLedger: runState.taskLedger.map((task) =>
        task.id === descriptor.taskId
          ? {
              ...task,
              attempts: descriptor.execution.retryBudget
            }
          : task
      )
    });

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const result = dispatchResult.results[0];
    const markerFiles = await readdir(markerDirectory).catch(() => []);
    const nextRunState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const task = nextRunState.taskLedger.find((item) => item.id === descriptor.taskId);

    assert.equal(result.status, "skipped");
    assert.match(result.note ?? "", /retry budget exhausted/i);
    assert.equal(markerFiles.length, 0);
    assert.equal(task?.status, "blocked");
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: circuit breaker blocks execution after repeated dispatch failures", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-circuit-open-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
      tempDir,
      `circuit-open-${Date.now()}`,
      { codex: { ok: true } }
    );
    const markerDirectory = path.join(tempDir, "circuit-open-markers");
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await writeFile(descriptor.launcherPath, buildMarkerOnlyScript(markerDirectory), "utf8");
    await writeJson(runResult.statePath, {
      ...runState,
      taskLedger: runState.taskLedger.map((task) =>
        task.id === descriptor.taskId
          ? {
              ...task,
              notes: [
                "2026-04-19T00:00:00.000Z dispatch:failed",
                "2026-04-19T00:01:00.000Z dispatch:incomplete",
                "2026-04-19T00:02:00.000Z dispatch:failed"
              ]
            }
          : task
      )
    });

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const result = dispatchResult.results[0];
    const markerFiles = await readdir(markerDirectory).catch(() => []);
    const nextRunState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const task = nextRunState.taskLedger.find((item) => item.id === descriptor.taskId);

    assert.equal(result.status, "skipped");
    assert.match(result.note ?? "", /circuit breaker is open/i);
    assert.equal(markerFiles.length, 0);
    assert.equal(task?.status, "blocked");
    assert.match(report, new RegExp(`\\[blocked\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: duplicate idempotency keys skip repeated descriptor entries", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-idempotency-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
      tempDir,
      `idempotency-${Date.now()}`,
      { codex: { ok: true } }
    );
    const markerDirectory = path.join(tempDir, "idempotency-markers");

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor, { ...descriptor }]);
    await writeFile(
      descriptor.launcherPath,
      bindArtifactScriptIdentity(
        buildMarkerResultArtifactScript(
          descriptor.resultPath,
          {
            status: "completed",
            summary: "single idempotent execution",
            changedFiles: ["src/lib/dispatch.mjs"],
            verification: ["npm test"],
            notes: ["idempotency guard"]
          },
          markerDirectory
        ),
        descriptor
      ),
      "utf8"
    );

    const dispatchResult = await dispatchHandoffs(handoffResult.indexPath, "execute");
    const statuses = dispatchResult.results.map((result) => result.status).sort();
    const markerFiles = await readdir(markerDirectory);
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

    assert.deepEqual(statuses, ["completed", "skipped"]);
    assert.ok(dispatchResult.results.some((result) => /duplicate idempotency key/i.test(result.note ?? "")));
    assert.equal(markerFiles.length, 1);
    assert.equal(task?.status, "completed");
    assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: completed artifacts tolerate advisory continue automationDecision", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-advisory-complete-",
      runtimeId: "codex",
      launcherScript: buildResultArtifactScript("{{RESULT_PATH}}", {
        status: "completed",
        summary: "completed artifact carries an advisory continue hint",
        changedFiles: ["src/lib/result-artifact.mjs"],
        verification: ["npm test"],
        notes: ["completed advisory continuation should not block dispatch"],
        automationDecision: {
          action: "continue",
          targetTaskId: "review-spec-intake",
          reason: "review is the natural next step"
        }
      })
    });
    const { descriptor, dispatchResult, report, task } = scenario;
    const result = dispatchResult.results[0];

    assert.equal(result.status, "completed");
    assert.deepEqual(dispatchResult.runStateSync?.updatedTasks[0], {
      taskId: descriptor.taskId,
      nextStatus: "completed"
    });
    assert.equal(task.status, "completed");
    assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
  });

  await runTest("matrix: manual runtime is skipped and does not mutate run-state", async () => {
    const scenario = await runSingleDescriptorDispatchScenario({
      tempPrefix: "ai-factory-matrix-manual-",
      runtimeId: "manual",
      launcherScript: process.platform === "win32" ? "throw 'manual runtime should not auto execute'\n" : "exit 1\n"
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
      launcherScript: process.platform === "win32" ? "throw 'cursor runtime should not auto execute'\n" : "exit 1\n"
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
    const launcherPath = path.join(handoffDir, `standalone.launch${getLauncherMetadata().extension}`);
    const resultPath = path.join(handoffDir, "results", "standalone.result.json");

    await mkdir(path.join(handoffDir, "results"), { recursive: true });
    await writeFile(
      launcherPath,
      bindArtifactScriptIdentity(buildResultArtifactScript(resultPath, {
        status: "completed",
        summary: "standalone dispatch execute",
        changedFiles: [],
        verification: ["matrix standalone"],
        notes: ["no run-state in this scenario"]
      }), {
        runId: "standalone-dispatch-run",
        taskId: "standalone-task",
        handoffId: "standalone-handoff"
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

  await runTest("matrix: concurrent dispatch execute claims a single launcher run per descriptor", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-matrix-same-descriptor-"));
    const { runResult, handoffResult, descriptor, reportPath } = await createDispatchReadyRun(
      tempDir,
      `same-descriptor-${Date.now()}`,
      { codex: { ok: true } }
    );
    const markerDirectory = path.join(tempDir, "same-descriptor-markers");

    await limitDispatchToDescriptors(handoffResult.indexPath, handoffResult.runId, [descriptor]);
    await writeFile(
      descriptor.launcherPath,
      bindArtifactScriptIdentity(buildMarkerResultArtifactScript(
        descriptor.resultPath,
        {
          status: "completed",
          summary: "single execution lock",
          changedFiles: ["src/lib/dispatch.mjs"],
          verification: ["npm test"],
          notes: ["descriptor lock"]
        },
        markerDirectory
      ), descriptor),
      "utf8"
    );

    const [firstDispatchResult, secondDispatchResult] = await Promise.all([
      dispatchHandoffs(handoffResult.indexPath, "execute"),
      dispatchHandoffs(handoffResult.indexPath, "execute")
    ]);
    const statuses = [firstDispatchResult.results[0]?.status, secondDispatchResult.results[0]?.status].sort();
    const notes = [firstDispatchResult.results[0]?.note, secondDispatchResult.results[0]?.note];
    const markerFiles = await readdir(markerDirectory);
    const runState = JSON.parse(await readFile(runResult.statePath, "utf8"));
    const report = await readFile(reportPath, "utf8");
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

    assert.deepEqual(statuses, ["completed", "skipped"]);
    assert.equal(markerFiles.length, 1);
    assert.ok(notes.some((note) => /already executing/i.test(note ?? "")));
    assert.equal(task?.status, "completed");
    assert.match(report, new RegExp(`\\[completed\\] ${descriptor.taskId} ->`));
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
      bindArtifactScriptIdentity(buildBarrierResultArtifactScript(
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
      ), firstDescriptor),
      "utf8"
    );
    await writeFile(
      secondDescriptor.launcherPath,
      bindArtifactScriptIdentity(buildBarrierResultArtifactScript(
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
      ), secondDescriptor),
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
