import path from "node:path";

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
    "",
    "# Execution Rules",
    "- Read the attached task brief first.",
    "- Follow the risk stop rules exactly.",
    "- Do not claim the whole project is complete from this task alone.",
    "- Make every result verifiable.",
    "",
    "# Required Result Artifact",
    `Write a JSON file to this exact path when you finish: ${resultPath}`,
    "",
    "The JSON must include:",
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

function buildCursorLauncher(workspacePath, briefPath, promptPath) {
  const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);
  const briefLiteral = toPowerShellSingleQuotedLiteral(briefPath);
  const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);

  return [
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

function buildCodexLauncher(promptPath, workspacePath) {
  const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
  const workspaceLiteral = toPowerShellSingleQuotedLiteral(workspacePath);

  return [
    `Set-Location -LiteralPath ${workspaceLiteral}`,
    `$prompt = Get-Content -Raw -LiteralPath ${promptLiteral}`,
    "$prompt | & codex -a never exec -C . -s workspace-write -"
  ].join("\n");
}

function buildManualLauncher(promptPath, briefPath) {
  const promptLiteral = toPowerShellSingleQuotedLiteral(promptPath);
  const briefLiteral = toPowerShellSingleQuotedLiteral(briefPath);
  return [
    "Write-Host 'Please handle this task manually.'",
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
  rolePromptTemplate,
  promptPath,
  briefPath,
  resultPath,
  doctorReport
}) {
  const runtimeChecks = normalizeRuntimeChecks(doctorReport);
  const selected = pickRuntimeForRole(task.role, runtimeChecks);
  const runtime = describeRuntime(selected.runtimeId);
  const alternatives = Object.entries(runtimeChecks)
    .filter(([runtimeId]) => runtimeId !== selected.runtimeId)
    .map(([runtimeId, status]) => ({
      runtimeId,
      ok: status.ok
    }));
  const promptText = buildPromptDocument({
    spec,
    task,
    rolePromptTemplate,
    briefPath,
    resultPath,
    runState
  });

  let launcherScript = buildManualLauncher(promptPath, briefPath);

  if (selected.runtimeId === "openclaw") {
    launcherScript = buildOpenClawLauncher(promptPath);
  } else if (selected.runtimeId === "cursor") {
    launcherScript = buildCursorLauncher(workspacePath, briefPath, promptPath);
  } else if (selected.runtimeId === "local-ci") {
    launcherScript = buildLocalCiLauncher(workspacePath, runState.mandatoryGates);
  } else if (selected.runtimeId === "codex") {
    launcherScript = buildCodexLauncher(promptPath, workspacePath);
  }

  return {
    version: 2,
    runId: runState.runId,
    taskId: task.id,
    role: task.role,
    runtime: {
      id: runtime.id,
      label: runtime.label,
      mode: runtime.mode,
      selectionStatus: selected.status,
      selectionReason: selected.reason
    },
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
