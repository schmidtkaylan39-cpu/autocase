import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { selectModelForTask } from "./model-policy.mjs";
import {
  describeRuntime,
  getRuntimeExecutionProfile,
  normalizeRuntimeChecks,
  pickRuntimeForRole
} from "./runtime-registry.mjs";
import { toPowerShellSingleQuotedLiteral } from "./powershell.mjs";

function relativeLabel(baseDir, targetPath) {
  return path.relative(baseDir, targetPath) || ".";
}

function escapeShellLiteral(value) {
  return String(value).replace(/'/g, `'"'"'`);
}

function toShellSingleQuotedLiteral(value) {
  return `'${escapeShellLiteral(value)}'`;
}

function hashTextSha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function buildIdempotencyKey({ runId, taskId, handoffId, runtimeId, promptHash }) {
  return hashTextSha256(
    JSON.stringify({
      runId,
      taskId,
      handoffId,
      runtimeId,
      promptHash
    })
  );
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  );
}

export function getLauncherMetadata(platform = process.platform) {
  return platform === "win32"
    ? { extension: ".ps1", language: "powershell" }
    : { extension: ".sh", language: "bash" };
}

function titleForRole(role) {
  switch (role) {
    case "planner":
      return "Planner";
    case "reviewer":
      return "Reviewer";
    case "executor":
      return "Executor";
    case "verifier":
      return "Verifier";
    case "orchestrator":
      return "Orchestrator";
    default:
      return role;
  }
}

function buildRoleAutomationGuidance(task) {
  if (task.role === "planner") {
    return [
      "# Planning Completion Rules",
      "- Use `status: \"completed\"` only when the plan is execution-ready and the brief is sufficiently clarified.",
      "- Use `status: \"blocked\"` when critical information is missing, a stop rule is triggered, or the plan is unsafe to continue automatically.",
      "- Omit `automationDecision` on completed results; only blocked results should request an automatic retry or reroute.",
      "- If you block, make the summary and notes concrete enough for the next automated retry or escalation round."
    ];
  }

  if (task.role === "reviewer") {
    const featureTaskId = String(task.id).replace(/^review-/, "implement-");
    return [
      "# Review Completion Rules",
      "- Use `status: \"completed\"` only when the reviewed implementation is acceptable for verification.",
      "- Use `status: \"blocked\"` when another Codex implementation round is required.",
      "- Omit `automationDecision` on completed results; only blocked results should request an automatic retry or reroute.",
      `- If you block, include an optional \`automationDecision\` object such as \`{"action":"rework_feature","targetTaskId":"${featureTaskId}","reason":"..."}\` or \`{"action":"replan_feature","targetTaskId":"${featureTaskId}","reason":"..."}\`.`,
      "- Keep findings concrete and file-aware so the next implementation round can act on them."
    ];
  }

  if (task.role === "orchestrator") {
    return [
      "# Delivery Completion Rules",
      "- Use `status: \"completed\"` only when the delivery handoff is ready and the run can be considered packaged.",
      "- Use `status: \"blocked\"` if the run still needs external release approval, missing evidence, or manual intervention.",
      "- Omit `automationDecision` on completed results; only blocked results should request an automatic retry or reroute.",
      '- If you expect another automatic pass to resolve it, include an optional `automationDecision` such as `{"action":"retry_task","reason":"release evidence still generating","delayMinutes":5}`.'
    ];
  }

  return [];
}

function buildDeterministicControlMetadata(modelSelection, launcherMetadata = {}) {
  const deterministicSettings = modelSelection?.deterministicSettings ?? {};
  const fixedModelId =
    deterministicSettings.fixedModelId ??
    launcherMetadata.fixedModelId ??
    launcherMetadata.fixedModel ??
    modelSelection?.preferredModel ??
    null;
  const maxTokens =
    deterministicSettings.maxTokens ??
    launcherMetadata.maxTokens ??
    launcherMetadata.maxOutputTokens;

  return compactObject({
    fixedModelId,
    fixedModel: fixedModelId,
    temperature: deterministicSettings.temperature ?? launcherMetadata.temperature,
    maxTokens,
    maxOutputTokens: maxTokens,
    topP: deterministicSettings.topP ?? launcherMetadata.topP
  });
}

function buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform = process.platform) {
  const promptHash = promptMetadata?.hash ?? promptMetadata?.promptHash;
  const promptHashAlgorithm =
    promptMetadata?.hashAlgorithm ??
    promptMetadata?.promptHashAlgorithm ??
    "sha256";
  const lines = [
    ["Preferred model", modelSelection.preferredModel],
    ["Model reason", modelSelection.selectionReason],
    [
      "Deterministic model id",
      launcherMetadata.fixedModelId ?? launcherMetadata.fixedModel ?? modelSelection.preferredModel
    ]
  ];

  if (launcherMetadata.temperature !== undefined) {
    lines.push(["Deterministic temperature", String(launcherMetadata.temperature)]);
  }

  if (launcherMetadata.maxTokens !== undefined || launcherMetadata.maxOutputTokens !== undefined) {
    lines.push([
      "Deterministic maxTokens",
      String(launcherMetadata.maxTokens ?? launcherMetadata.maxOutputTokens)
    ]);
  }

  if (launcherMetadata.topP !== undefined) {
    lines.push(["Deterministic topP", String(launcherMetadata.topP)]);
  }

  if (promptHash) {
    lines.push([
      "Prompt hash",
      `${promptHashAlgorithm}:${promptHash}`
    ]);
  }

  if (platform === "win32") {
    return lines.map(([label, value]) => {
      const labelLiteral = toPowerShellSingleQuotedLiteral(`${label}: `);
      const valueLiteral = toPowerShellSingleQuotedLiteral(value);
      return `Write-Host (${labelLiteral} + ${valueLiteral})`;
    });
  }

  return lines.map(
    ([label, value]) => `printf '${label}: %s\\n' ${toShellSingleQuotedLiteral(value)}`
  );
}

export function buildPromptDocument({
  workspacePath,
  spec,
  task,
  handoffId,
  modelSelection,
  runtimeId,
  launcherMetadata,
  executionGuardrails,
  rolePromptTemplate,
  briefPath,
  resultPath,
  runState
}) {
  return [
    rolePromptTemplate.trim(),
    "",
    "# Task Context",
    `- runId: ${runState.runId}`,
    `- project: ${spec.projectName}`,
    `- role: ${titleForRole(task.role)}`,
    `- taskId: ${task.id}`,
    `- handoffId: ${handoffId}`,
    `- workspaceRoot: ${workspacePath}`,
    `- preferredModel: ${modelSelection.preferredModel}`,
    `- modelSelectionMode: ${modelSelection.selectionMode}`,
    "",
    ...(launcherMetadata && Object.keys(launcherMetadata).length > 0
      ? [
          "# Deterministic Controls",
          ...(typeof launcherMetadata.fixedModelId === "string"
            ? [`- fixedModelId: ${launcherMetadata.fixedModelId}`]
            : []),
          ...(typeof launcherMetadata.temperature === "number"
            ? [`- temperature: ${launcherMetadata.temperature}`]
            : []),
          ...(typeof launcherMetadata.maxTokens === "number"
            ? [`- maxTokens: ${launcherMetadata.maxTokens}`]
            : typeof launcherMetadata.maxOutputTokens === "number"
              ? [`- maxTokens: ${launcherMetadata.maxOutputTokens}`]
              : []),
          ...(typeof launcherMetadata.topP === "number"
            ? [`- topP: ${launcherMetadata.topP}`]
            : []),
          "- Treat these model controls as fixed for deterministic replays.",
          ""
        ]
      : []),
    "# Execution Guardrails",
    `- runtimeId: ${runtimeId}`,
    `- timeoutMs: ${executionGuardrails.timeoutMs}`,
    `- retryBudget: ${executionGuardrails.retryBudget}`,
    `- circuitBreakerLimit: ${executionGuardrails.circuitBreakerLimit}`,
    "- Do not ask for additional retries or alternate launcher settings inside the task output.",
    "",
    "# Execution Rules",
    "- Read the attached task brief first.",
    "- Follow the risk stop rules exactly.",
    "- Do not claim the whole project is complete from this task alone.",
    "- Make every result verifiable.",
    ...(modelSelection.autoSwitch
      ? [
          "- If your current surface lets you choose a model, use the preferred model listed below."
        ]
      : []),
    ...(() => {
      const guidance = buildRoleAutomationGuidance(task);
      return guidance.length > 0 ? ["", ...guidance] : [];
    })(),
    "",
    "# Model Routing",
    `- preferredModel: ${modelSelection.preferredModel}`,
    `- fallbackModel: ${modelSelection.fallbackModel}`,
    `- selectionMode: ${modelSelection.selectionMode}`,
    `- selectionReason: ${modelSelection.selectionReason}`,
    ...(modelSelection.triggers.length > 0
      ? modelSelection.triggers.map((trigger) => `- trigger: ${trigger}`)
      : ["- trigger: none"]),
    "",
    "# Required Result Artifact",
    `Write a JSON file to this exact path when you finish: ${resultPath}`,
    "",
    "The JSON must include:",
    '- `"runId"`: this exact run id',
    '- `"taskId"`: this exact task id',
    '- `"handoffId"`: this exact handoff id',
    '- `"status"`: one of `"completed"`, `"failed"`, or `"blocked"`',
    '- `"summary"`: a short plain-English summary',
    '- `"changedFiles"`: an array of changed file paths',
    '- `"verification"`: an array of checks you ran',
    '- `"notes"`: an array of notable decisions or issues',
    '- optional `"automationDecision"`: only include this when `status` is `"blocked"` and the system should retry or reroute automatically',
    "",
    "# Workspace Root Path",
    workspacePath,
    "",
    "# Task Brief Path",
    briefPath
  ].join("\n");
}

function buildOpenClawLauncher(
  promptPath,
  modelSelection,
  launcherMetadata,
  promptMetadata,
  platform = process.platform
) {
  if (platform === "win32") {
    const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
    return [
      ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
      `$message = Get-Content -Raw -LiteralPath ${promptLiteral}`,
      "& openclaw agent --local --json --thinking medium --message $message"
    ].join("\n");
  }

  const promptLiteral = toShellSingleQuotedLiteral(promptPath);
  return [
    ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
    `message=$(cat ${promptLiteral})`,
    'openclaw agent --local --json --thinking medium --message "$message"'
  ].join("\n");
}

function buildCursorLauncher(
  workspacePath,
  briefPath,
  promptPath,
  modelSelection,
  launcherMetadata,
  promptMetadata,
  platform = process.platform
) {
  if (platform === "win32") {
    const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);
    const briefLiteral = toPowerShellSingleQuotedLiteral(briefPath);
    const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);

    return [
      ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
      `& cursor -n ${workspaceLiteral} ${briefLiteral} ${promptLiteral}`,
      "",
      "# Cursor is currently treated as a planning or review surface.",
      "# Open the prompt and brief files inside Cursor for guided handling."
    ].join("\n");
  }

  const workspaceLiteral = toShellSingleQuotedLiteral(workspacePath);
  const briefLiteral = toShellSingleQuotedLiteral(briefPath);
  const promptLiteral = toShellSingleQuotedLiteral(promptPath);

  return [
    ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
    `cursor -n ${workspaceLiteral} ${briefLiteral} ${promptLiteral}`,
    "",
    "# Cursor is currently treated as a planning or review surface.",
    "# Open the prompt and brief files inside Cursor for guided handling."
  ].join("\n");
}

function buildLocalCiResultArtifact(runId, taskId, handoffId, verificationCommands, mandatoryGates) {
  const effectiveCommands = verificationCommands.length > 0 ? verificationCommands : ["npm test"];
  const effectiveGates = mandatoryGates.length > 0 ? mandatoryGates : ["default npm test"];

  return JSON.stringify(
    {
      runId,
      taskId,
      handoffId,
      status: "completed",
      summary: `local-ci completed ${effectiveCommands.length} verification command(s).`,
      changedFiles: [],
      verification: effectiveCommands,
      notes: [`Completed verifier gates: ${effectiveGates.join(", ")}.`]
    },
    null,
    2
  );
}

function dedupeCommands(values) {
  const seen = new Set();
  const results = [];

  for (const value of values ?? []) {
    const normalized = typeof value === "string" ? value.trim() : "";

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(normalized);
  }

  return results;
}

function getQuickStartVerificationCommands(spec) {
  if (!spec?.factoryMetadata?.quickStartVerifierContract) {
    return [];
  }

  return ["npm run quick-start:verify-output"];
}

function buildLocalCiLauncher(
  workspacePath,
  modelSelection,
  launcherMetadata,
  promptMetadata,
  options = {},
  platform = process.platform
) {
  const {
    runId,
    taskId,
    handoffId,
    resultPath,
    mandatoryGates = [],
    additionalVerificationCommands = [],
    additionalVerificationGates = []
  } = options;
  const gateToCommand = {
    build: "npm run build",
    lint: "npm run lint",
    typecheck: "npm run typecheck",
    "unit test": "npm test",
    "integration test": "npm run test:integration",
    "e2e test": "npm run test:e2e"
  };

  const commands = mandatoryGates
    .map((gate) => gateToCommand[gate])
    .filter(Boolean);
  const effectiveCommands = dedupeCommands([
    ...(commands.length > 0 ? commands : ["npm test"]),
    ...additionalVerificationCommands
  ]);
  const effectiveGates = dedupeCommands([
    ...(mandatoryGates.length > 0 ? mandatoryGates : ["default npm test"]),
    ...additionalVerificationGates
  ]);
  const artifactJson = buildLocalCiResultArtifact(
    runId,
    taskId,
    handoffId,
    effectiveCommands,
    effectiveGates
  );

  if (platform === "win32") {
    const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);
    const resultPathLiteral = toPowerShellSingleQuotedLiteral(resultPath);
    return [
      `Set-Location -LiteralPath ${workspaceLiteral}`,
      ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
      ...effectiveCommands,
      `$resultDirectory = Split-Path -Parent ${resultPathLiteral}`,
      "if (![string]::IsNullOrWhiteSpace($resultDirectory)) {",
      "  New-Item -ItemType Directory -Force -Path $resultDirectory | Out-Null",
      "}",
      "$resultJson = @'",
      artifactJson,
      "'@",
      `$resultJson | Set-Content -LiteralPath ${resultPathLiteral} -Encoding utf8`
    ].join("\n");
  }

  const workspaceLiteral = toShellSingleQuotedLiteral(workspacePath);
  const resultPathLiteral = toShellSingleQuotedLiteral(resultPath);
  return [
    `cd ${workspaceLiteral}`,
    ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
    ...effectiveCommands,
    `mkdir -p "$(dirname -- ${resultPathLiteral})"`,
    `cat > ${resultPathLiteral} <<'JSON'`,
    artifactJson,
    "JSON"
  ].join("\n");
}

function buildCodexLauncher(
  promptPath,
  workspacePath,
  modelSelection,
  launcherMetadata,
  promptMetadata,
  platform = process.platform
) {
  if (platform === "win32") {
    const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
    const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);

    return [
      `Set-Location -LiteralPath ${workspaceLiteral}`,
      ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
      `$prompt = Get-Content -Raw -LiteralPath ${promptLiteral}`,
      "$prompt | & codex -a never exec --skip-git-repo-check -C . -s workspace-write -"
    ].join("\n");
  }

  const promptLiteral = toShellSingleQuotedLiteral(promptPath);
  const workspaceLiteral = toShellSingleQuotedLiteral(workspacePath);

  return [
    `cd ${workspaceLiteral}`,
    ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
    `prompt=$(cat ${promptLiteral})`,
    'printf "%s" "$prompt" | codex -a never exec --skip-git-repo-check -C . -s workspace-write -'
  ].join("\n");
}

function buildGptRunnerLauncher(
  promptPath,
  workspacePath,
  modelSelection,
  launcherMetadata,
  promptMetadata,
  platform = process.platform
) {
  if (platform === "win32") {
    const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
    const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);
    const preferredModelLiteral = toPowerShellSingleQuotedLiteral(modelSelection.preferredModel);

    return [
      `Set-Location -LiteralPath ${workspaceLiteral}`,
      ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
      `$prompt = Get-Content -Raw -LiteralPath ${promptLiteral}`,
      `$prompt | & codex -m ${preferredModelLiteral} -a never exec --skip-git-repo-check -C . -s workspace-write -`
    ].join("\n");
  }

  const promptLiteral = toShellSingleQuotedLiteral(promptPath);
  const workspaceLiteral = toShellSingleQuotedLiteral(workspacePath);
  const preferredModelLiteral = toShellSingleQuotedLiteral(modelSelection.preferredModel);

  return [
    `cd ${workspaceLiteral}`,
    ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
    `prompt=$(cat ${promptLiteral})`,
    `printf "%s" "$prompt" | codex -m ${preferredModelLiteral} -a never exec --skip-git-repo-check -C . -s workspace-write -`
  ].join("\n");
}

function buildManualLauncher(
  workspacePath,
  promptPath,
  briefPath,
  modelSelection,
  launcherMetadata,
  promptMetadata,
  platform = process.platform
) {
  if (platform === "win32") {
    const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);
    const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
    const briefLiteral = toPowerShellSingleQuotedLiteral(briefPath);
    return [
      "Write-Host 'Please handle this task manually.'",
      ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
      `Write-Host ('Workspace root: ' + ${workspaceLiteral})`,
      `Write-Host ('Prompt: ' + ${promptLiteral})`,
      `Write-Host ('Brief: ' + ${briefLiteral})`
    ].join("\n");
  }

  const workspaceLiteral = toShellSingleQuotedLiteral(workspacePath);
  const promptLiteral = toShellSingleQuotedLiteral(promptPath);
  const briefLiteral = toShellSingleQuotedLiteral(briefPath);

  return [
    "echo 'Please handle this task manually.'",
    ...buildLauncherOutputLines(modelSelection, launcherMetadata, promptMetadata, platform),
    `printf 'Workspace root: %s\\n' ${workspaceLiteral}`,
    `printf 'Prompt: %s\\n' ${promptLiteral}`,
    `printf 'Brief: %s\\n' ${briefLiteral}`
  ].join("\n");
}

function hasExplicitRoleRuntimeOverride(runState, role) {
  const configuredPreferences = runState?.runtimeRouting?.roleOverrides?.[role];
  return Array.isArray(configuredPreferences) && configuredPreferences.length > 0;
}

function hasTransientGptRunnerRetrySignal(task) {
  const retrySignals = [
    task?.lastRetryReason,
    ...(Array.isArray(task?.notes) ? task.notes : [])
  ];

  return retrySignals.some((value) => /transient gpt runner upstream failure/i.test(String(value ?? "")));
}

function shouldAutoFailoverPlannerOrReviewerToCodex(task, runState, runtimeChecks, selectedRuntimeId) {
  if (!task || (task.role !== "planner" && task.role !== "reviewer")) {
    return false;
  }

  if (selectedRuntimeId !== "gpt-runner") {
    return false;
  }

  if (hasExplicitRoleRuntimeOverride(runState, task.role)) {
    return false;
  }

  if (!runtimeChecks?.codex?.ok) {
    return false;
  }

  return hasTransientGptRunnerRetrySignal(task);
}

function resolveTaskRuntimeSelection(task, runState, runtimeChecks) {
  const selected = pickRuntimeForRole(task.role, runtimeChecks, runState.runtimeRouting);

  if (!shouldAutoFailoverPlannerOrReviewerToCodex(task, runState, runtimeChecks, selected.runtimeId)) {
    return selected;
  }

  return {
    runtimeId: "codex",
    status: "ready",
    reason:
      "Codex was selected automatically after a transient GPT Runner upstream failure for this task."
  };
}

export function buildHandoffDescriptor({
  workspacePath,
  spec,
  runState,
  plan,
  task,
  handoffId = randomUUID(),
  rolePromptTemplate,
  promptPath,
  briefPath,
  resultPath,
  doctorReport,
  platform = process.platform
}) {
  const runtimeChecks = normalizeRuntimeChecks(doctorReport);
  const selected = resolveTaskRuntimeSelection(task, runState, runtimeChecks);
  const runtime = describeRuntime(selected.runtimeId);
  const modelSelection = selectModelForTask(task, runState);
  const executionProfile = getRuntimeExecutionProfile({
    runtimeId: selected.runtimeId,
    task,
    runState,
    modelSelection
  });
  const deterministicControls = buildDeterministicControlMetadata(
    modelSelection,
    executionProfile.launcherMetadata
  );
  const alternatives = Object.entries(runtimeChecks)
    .filter(([runtimeId]) => runtimeId !== selected.runtimeId)
    .map(([runtimeId, status]) => ({
      runtimeId,
      ok: status.ok
    }));
  const promptText = buildPromptDocument({
    workspacePath,
    spec,
    task,
    handoffId,
    modelSelection,
    runtimeId: selected.runtimeId,
    launcherMetadata: deterministicControls,
    executionGuardrails: executionProfile.execution,
    rolePromptTemplate,
    briefPath,
    resultPath,
    runState
  });
  const persistedPromptText = `${promptText}\n`;
  const promptHash = hashTextSha256(persistedPromptText);
  const execution = {
    ...executionProfile.execution,
    idempotencyKey: buildIdempotencyKey({
      runId: runState.runId,
      taskId: task.id,
      handoffId,
      runtimeId: selected.runtimeId,
      promptHash
    })
  };
  const launcher = {
    ...getLauncherMetadata(platform),
    metadata: compactObject({
      runtimeId: selected.runtimeId,
      fixedModelId: deterministicControls.fixedModelId,
      fixedModel: deterministicControls.fixedModel,
      temperature: deterministicControls.temperature,
      maxTokens: deterministicControls.maxTokens,
      maxOutputTokens: deterministicControls.maxOutputTokens,
      topP: deterministicControls.topP,
      promptHashAlgorithm: "sha256",
      promptHash,
      promptEncoding: "utf8",
      promptByteLength: Buffer.byteLength(persistedPromptText, "utf8"),
      timeoutMs: execution.timeoutMs,
      retryBudget: execution.retryBudget,
      circuitBreakerLimit: execution.circuitBreakerLimit,
      idempotencyKey: execution.idempotencyKey
    })
  };

  let launcherScript = buildManualLauncher(
    workspacePath,
    promptPath,
    briefPath,
    modelSelection,
    launcher.metadata,
    launcher.metadata,
    platform
  );

  if (selected.runtimeId === "openclaw") {
    launcherScript = buildOpenClawLauncher(
      promptPath,
      modelSelection,
      launcher.metadata,
      launcher.metadata,
      platform
    );
  } else if (selected.runtimeId === "gpt-runner") {
    launcherScript = buildGptRunnerLauncher(
      promptPath,
      workspacePath,
      modelSelection,
      launcher.metadata,
      launcher.metadata,
      platform
    );
  } else if (selected.runtimeId === "cursor") {
    launcherScript = buildCursorLauncher(
      workspacePath,
      briefPath,
      promptPath,
      modelSelection,
      launcher.metadata,
      launcher.metadata,
      platform
    );
  } else if (selected.runtimeId === "local-ci") {
    const additionalVerificationCommands = getQuickStartVerificationCommands(spec);
    launcherScript = buildLocalCiLauncher(
      workspacePath,
      modelSelection,
      launcher.metadata,
      launcher.metadata,
      {
        runId: runState.runId,
        taskId: task.id,
        handoffId,
        resultPath,
        mandatoryGates: runState.mandatoryGates,
        additionalVerificationCommands,
        additionalVerificationGates:
          additionalVerificationCommands.length > 0 ? ["quick-start output verification"] : []
      },
      platform
    );
  } else if (selected.runtimeId === "codex") {
    launcherScript = buildCodexLauncher(
      promptPath,
      workspacePath,
      modelSelection,
      launcher.metadata,
      launcher.metadata,
      platform
    );
  }

  return {
    version: 4,
    runId: runState.runId,
    handoffId,
    taskId: task.id,
    role: task.role,
    runtime: {
      id: runtime.id,
      label: runtime.label,
      mode: runtime.mode,
      selectionStatus: selected.status,
      selectionReason: selected.reason
    },
    model: modelSelection,
    project: {
      name: spec.projectName,
      summary: spec.summary
    },
    task: {
      title: task.title,
      description: task.description,
      dependsOn: task.dependsOn,
      acceptanceCriteria: task.acceptanceCriteria
    },
    planSummary: {
      phaseCount: plan.phases.length,
      mandatoryGates: runState.mandatoryGates
    },
    paths: {
      workspacePath,
      promptPath,
      briefPath,
      resultPath
    },
    prompt: {
      hashAlgorithm: "sha256",
      hash: promptHash,
      encoding: "utf8",
      byteLength: Buffer.byteLength(persistedPromptText, "utf8")
    },
    execution,
    launcher,
    alternatives,
    promptText,
    launcherScript
  };
}

export function renderHandoffMarkdown(descriptor, baseDir) {
  return [
    `# Handoff: ${descriptor.task.title}`,
    "",
    `- runId: ${descriptor.runId}`,
    `- taskId: ${descriptor.taskId}`,
    `- handoffId: ${descriptor.handoffId}`,
    `- role: ${titleForRole(descriptor.role)}`,
    `- recommended runtime: ${descriptor.runtime.label}`,
    `- selection reason: ${descriptor.runtime.selectionReason}`,
    `- preferred model: ${descriptor.model.preferredModel}`,
    `- model reason: ${descriptor.model.selectionReason}`,
    ...(descriptor.model?.deterministicSettings?.fixedModelId
      ? [`- deterministic model id: ${descriptor.model.deterministicSettings.fixedModelId}`]
      : []),
    ...(descriptor.model?.deterministicSettings?.temperature !== undefined
      ? [`- deterministic temperature: ${descriptor.model.deterministicSettings.temperature}`]
      : []),
    ...(descriptor.model?.deterministicSettings?.maxTokens !== undefined
      ? [`- deterministic maxTokens: ${descriptor.model.deterministicSettings.maxTokens}`]
      : []),
    ...(descriptor.model?.deterministicSettings?.topP !== undefined
      ? [`- deterministic topP: ${descriptor.model.deterministicSettings.topP}`]
      : []),
    ...(descriptor.prompt?.hash
      ? [`- prompt hash: ${descriptor.prompt.hashAlgorithm ?? "sha256"}:${descriptor.prompt.hash}`]
      : []),
    ...(descriptor.execution?.idempotencyKey
      ? [`- idempotency key: ${descriptor.execution.idempotencyKey}`]
      : []),
    "",
    "## Project",
    `- name: ${descriptor.project.name}`,
    `- summary: ${descriptor.project.summary}`,
    "",
    "## Task",
    `- title: ${descriptor.task.title}`,
    `- description: ${descriptor.task.description}`,
    ...descriptor.task.acceptanceCriteria.map((item) => `- acceptance: ${item}`),
    "",
    "## Files",
    `- workspace: ${relativeLabel(baseDir, descriptor.paths.workspacePath)}`,
    `- prompt: ${relativeLabel(baseDir, descriptor.paths.promptPath)}`,
    `- brief: ${relativeLabel(baseDir, descriptor.paths.briefPath)}`,
    `- result: ${relativeLabel(baseDir, descriptor.paths.resultPath)}`,
    "",
    "## Suggested Launcher",
    `\`\`\`${descriptor.launcher?.language ?? "powershell"}`,
    descriptor.launcherScript,
    "```"
  ].join("\n");
}
