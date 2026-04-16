import { randomUUID } from "node:crypto";
import path from "node:path";

import { selectModelForTask } from "./model-policy.mjs";
import { describeRuntime, normalizeRuntimeChecks, pickRuntimeForRole } from "./runtime-registry.mjs";
import { toPowerShellSingleQuotedLiteral } from "./powershell.mjs";

function relativeLabel(baseDir, targetPath) {
  return path.relative(baseDir, targetPath) || ".";
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

function buildOpenClawLauncher(promptPath) {
  const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
  return [
    `$message = Get-Content -Raw -LiteralPath ${promptLiteral}`,
    "& openclaw agent --local --json --thinking medium --message $message"
  ].join("\n");
}

function buildCursorLauncher(workspacePath, briefPath, promptPath, modelSelection) {
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

function buildLocalCiLauncher(workspacePath, mandatoryGates = []) {
  const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);
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

  return [
    `Set-Location -LiteralPath ${workspaceLiteral}`,
    ...(commands.length > 0 ? commands : ["npm test"])
  ].join("\n");
}

function buildCodexLauncher(promptPath, workspacePath, modelSelection) {
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

function buildManualLauncher(promptPath, briefPath, modelSelection) {
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
  doctorReport
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

  let launcherScript = buildManualLauncher(promptPath, briefPath, modelSelection);

  if (selected.runtimeId === "openclaw") {
    launcherScript = buildOpenClawLauncher(promptPath);
  } else if (selected.runtimeId === "cursor") {
    launcherScript = buildCursorLauncher(workspacePath, briefPath, promptPath, modelSelection);
  } else if (selected.runtimeId === "local-ci") {
    launcherScript = buildLocalCiLauncher(workspacePath, runState.mandatoryGates);
  } else if (selected.runtimeId === "codex") {
    launcherScript = buildCodexLauncher(promptPath, workspacePath, modelSelection);
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
    "```powershell",
    descriptor.launcherScript,
    "```"
  ].join("\n");
}
