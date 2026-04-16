import { randomUUID } from "node:crypto";
import path from "node:path";

import { selectModelForTask } from "./model-policy.mjs";
import { describeRuntime, normalizeRuntimeChecks, pickRuntimeForRole } from "./runtime-registry.mjs";
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

export function buildPromptDocument({
  spec,
  task,
  handoffId,
  modelSelection,
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
    `- preferredModel: ${modelSelection.preferredModel}`,
    `- modelSelectionMode: ${modelSelection.selectionMode}`,
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
    "",
    "# Task Brief Path",
    briefPath
  ].join("\n");
}

function buildOpenClawLauncher(promptPath, platform = process.platform) {
  if (platform === "win32") {
    const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
    return [
      `$message = Get-Content -Raw -LiteralPath ${promptLiteral}`,
      "& openclaw agent --local --json --thinking medium --message $message"
    ].join("\n");
  }

  const promptLiteral = toShellSingleQuotedLiteral(promptPath);
  return [
    `message=$(cat ${promptLiteral})`,
    'openclaw agent --local --json --thinking medium --message "$message"'
  ].join("\n");
}

function buildCursorLauncher(workspacePath, briefPath, promptPath, modelSelection, platform = process.platform) {
  if (platform === "win32") {
    const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);
    const briefLiteral = toPowerShellSingleQuotedLiteral(briefPath);
    const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
    const preferredModelLiteral = toPowerShellSingleQuotedLiteral(modelSelection.preferredModel);
    const selectionReasonLiteral = toPowerShellSingleQuotedLiteral(modelSelection.selectionReason);

    return [
      `Write-Host ('Preferred model: ' + ${preferredModelLiteral})`,
      `Write-Host ('Model reason: ' + ${selectionReasonLiteral})`,
      `& cursor -n ${workspaceLiteral} ${briefLiteral} ${promptLiteral}`,
      "",
      "# Cursor is currently treated as a planning or review surface.",
      "# Open the prompt and brief files inside Cursor for guided handling."
    ].join("\n");
  }

  const workspaceLiteral = toShellSingleQuotedLiteral(workspacePath);
  const briefLiteral = toShellSingleQuotedLiteral(briefPath);
  const promptLiteral = toShellSingleQuotedLiteral(promptPath);
  const preferredModelLiteral = toShellSingleQuotedLiteral(modelSelection.preferredModel);
  const selectionReasonLiteral = toShellSingleQuotedLiteral(modelSelection.selectionReason);

  return [
    `printf 'Preferred model: %s\\n' ${preferredModelLiteral}`,
    `printf 'Model reason: %s\\n' ${selectionReasonLiteral}`,
    `cursor -n ${workspaceLiteral} ${briefLiteral} ${promptLiteral}`,
    "",
    "# Cursor is currently treated as a planning or review surface.",
    "# Open the prompt and brief files inside Cursor for guided handling."
  ].join("\n");
}

function buildLocalCiLauncher(workspacePath, mandatoryGates = [], platform = process.platform) {
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

  if (platform === "win32") {
    const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);
    return [
      `Set-Location -LiteralPath ${workspaceLiteral}`,
      ...(commands.length > 0 ? commands : ["npm test"])
    ].join("\n");
  }

  const workspaceLiteral = toShellSingleQuotedLiteral(workspacePath);
  return [
    `cd ${workspaceLiteral}`,
    ...(commands.length > 0 ? commands : ["npm test"])
  ].join("\n");
}

function buildCodexLauncher(promptPath, workspacePath, modelSelection, platform = process.platform) {
  if (platform === "win32") {
    const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
    const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);
    const preferredModelLiteral = toPowerShellSingleQuotedLiteral(modelSelection.preferredModel);

    return [
      `Set-Location -LiteralPath ${workspaceLiteral}`,
      `Write-Host ('Preferred model: ' + ${preferredModelLiteral})`,
      `$prompt = Get-Content -Raw -LiteralPath ${promptLiteral}`,
      "$prompt | & codex -a never exec -C . -s workspace-write -"
    ].join("\n");
  }

  const promptLiteral = toShellSingleQuotedLiteral(promptPath);
  const workspaceLiteral = toShellSingleQuotedLiteral(workspacePath);
  const preferredModelLiteral = toShellSingleQuotedLiteral(modelSelection.preferredModel);

  return [
    `cd ${workspaceLiteral}`,
    `printf 'Preferred model: %s\\n' ${preferredModelLiteral}`,
    `prompt=$(cat ${promptLiteral})`,
    'printf "%s" "$prompt" | codex -a never exec -C . -s workspace-write -'
  ].join("\n");
}

function buildManualLauncher(promptPath, briefPath, modelSelection, platform = process.platform) {
  if (platform === "win32") {
    const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
    const briefLiteral = toPowerShellSingleQuotedLiteral(briefPath);
    const preferredModelLiteral = toPowerShellSingleQuotedLiteral(modelSelection.preferredModel);
    const selectionReasonLiteral = toPowerShellSingleQuotedLiteral(modelSelection.selectionReason);
    return [
      "Write-Host 'Please handle this task manually.'",
      `Write-Host ('Preferred model: ' + ${preferredModelLiteral})`,
      `Write-Host ('Model reason: ' + ${selectionReasonLiteral})`,
      `Write-Host ('Prompt: ' + ${promptLiteral})`,
      `Write-Host ('Brief: ' + ${briefLiteral})`
    ].join("\n");
  }

  const promptLiteral = toShellSingleQuotedLiteral(promptPath);
  const briefLiteral = toShellSingleQuotedLiteral(briefPath);
  const preferredModelLiteral = toShellSingleQuotedLiteral(modelSelection.preferredModel);
  const selectionReasonLiteral = toShellSingleQuotedLiteral(modelSelection.selectionReason);

  return [
    "echo 'Please handle this task manually.'",
    `printf 'Preferred model: %s\\n' ${preferredModelLiteral}`,
    `printf 'Model reason: %s\\n' ${selectionReasonLiteral}`,
    `printf 'Prompt: %s\\n' ${promptLiteral}`,
    `printf 'Brief: %s\\n' ${briefLiteral}`
  ].join("\n");
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
  const selected = pickRuntimeForRole(task.role, runtimeChecks);
  const runtime = describeRuntime(selected.runtimeId);
  const modelSelection = selectModelForTask(task, runState);
  const alternatives = Object.entries(runtimeChecks)
    .filter(([runtimeId]) => runtimeId !== selected.runtimeId)
    .map(([runtimeId, status]) => ({
      runtimeId,
      ok: status.ok
    }));
  const promptText = buildPromptDocument({
    spec,
    task,
    handoffId,
    modelSelection,
    rolePromptTemplate,
    briefPath,
    resultPath,
    runState
  });
  const launcher = getLauncherMetadata(platform);

  let launcherScript = buildManualLauncher(promptPath, briefPath, modelSelection, platform);

  if (selected.runtimeId === "openclaw") {
    launcherScript = buildOpenClawLauncher(promptPath, platform);
  } else if (selected.runtimeId === "cursor") {
    launcherScript = buildCursorLauncher(workspacePath, briefPath, promptPath, modelSelection, platform);
  } else if (selected.runtimeId === "local-ci") {
    launcherScript = buildLocalCiLauncher(workspacePath, runState.mandatoryGates, platform);
  } else if (selected.runtimeId === "codex") {
    launcherScript = buildCodexLauncher(promptPath, workspacePath, modelSelection, platform);
  }

  return {
    version: 3,
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
      promptPath,
      briefPath,
      resultPath
    },
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
