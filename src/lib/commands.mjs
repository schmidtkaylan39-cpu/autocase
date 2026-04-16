import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import { buildHandoffDescriptor, renderHandoffMarkdown } from "./handoffs.mjs";
import { mergeFactoryConfig, roleDirectoryFromConfig, defaultFactoryConfig } from "./roles.mjs";
import {
  createArtifactPaths,
  createRunState,
  refreshRunState,
  renderRunReport,
  renderTaskBrief,
  summarizeRunState
} from "./run-state.mjs";
import { updateTaskInRunState } from "./run-state.mjs";
import { validateResultArtifact } from "./result-artifact.mjs";
import { sampleProjectSpec } from "./sample-spec.mjs";
import { summarizeSpec, validateProjectSpec } from "./spec.mjs";
import { buildExecutionPlan, renderPlanMarkdown } from "./workflow.mjs";

const packageRootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function inferWorkspaceRootFromSpecPath(specPath) {
  const resolvedSpecPath = path.resolve(specPath);
  const specDirectory = path.dirname(resolvedSpecPath);
  const containerDirectoryName = path.basename(specDirectory).toLowerCase();

  if (containerDirectoryName === "specs" || containerDirectoryName === "examples") {
    return path.dirname(specDirectory);
  }

  return specDirectory;
}

function resolveWorkspaceRelativePath(workspaceRoot, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(workspaceRoot, targetPath);
}

function resolveRunRelativePath(runDirectory, targetPath, fallbackPath) {
  const effectivePath = targetPath ?? fallbackPath;
  return path.isAbsolute(effectivePath) ? path.resolve(effectivePath) : path.resolve(runDirectory, effectivePath);
}

function inferWorkspaceRootFromRunState(runState, resolvedRunStatePath) {
  if (typeof runState?.workspacePath === "string" && runState.workspacePath.trim().length > 0) {
    return path.resolve(runState.workspacePath);
  }

  const runDirectory = path.dirname(resolvedRunStatePath);
  const runsDirectory = path.dirname(runDirectory);

  if (path.basename(runsDirectory).toLowerCase() === "runs") {
    return path.dirname(runsDirectory);
  }

  return runsDirectory;
}

async function loadFactoryConfig(configPath = "config/factory.config.json", workspaceRoot = process.cwd()) {
  const resolvedConfigPath = resolveWorkspaceRelativePath(workspaceRoot, configPath);

  try {
    await access(resolvedConfigPath);
  } catch {
    return {
      resolvedConfigPath: null,
      config: mergeFactoryConfig()
    };
  }

  return {
    resolvedConfigPath,
    config: mergeFactoryConfig(await readJson(resolvedConfigPath))
  };
}

function classifyHybridIssue(reason = "") {
  const normalizedReason = String(reason).trim();
  const retryablePatterns = [
    /\u8bf7\u6c42\u9891\u7387\u8fc7\u9ad8/i,
    /\u983b\u7387\u904e\u9ad8/i,
    /rate limit/i,
    /too many requests/i,
    /\u54cd\u5e94\u8d85\u65f6/i,
    /\u56de\u61c9\u8d85\u6642/i,
    /timed out/i,
    /\btimeout\b/i,
    /unexpected error occurred on our servers/i,
    /please try again/i,
    /\u53d1\u9001.?\u7ee7\u7eed/i,
    /send .*\u7ee7\u7eed/i
  ];

  return {
    reason: normalizedReason || "Hybrid runtime retry requested.",
    retryable: retryablePatterns.some((pattern) => pattern.test(normalizedReason))
  };
}

function addMinutes(timestamp, minutes) {
  return new Date(timestamp.getTime() + minutes * 60 * 1000).toISOString();
}

async function loadDoctorReport(
  doctorReportPath = "reports/runtime-doctor.json",
  workspaceRoot = process.cwd()
) {
  const resolvedDoctorReportPath = resolveWorkspaceRelativePath(workspaceRoot, doctorReportPath);

  try {
    await access(resolvedDoctorReportPath);
    return {
      resolvedDoctorReportPath,
      report: await readJson(resolvedDoctorReportPath)
    };
  } catch {
    return {
      resolvedDoctorReportPath: null,
      report: {
        checks: []
      }
    };
  }
}

export async function initProject(targetDir = ".") {
  const specsDir = path.resolve(targetDir, "specs");
  const runsDir = path.resolve(targetDir, "runs");
  const reportsDir = path.resolve(targetDir, "reports");
  const configDir = path.resolve(targetDir, "config");

  await ensureDirectory(specsDir);
  await ensureDirectory(runsDir);
  await ensureDirectory(reportsDir);
  await ensureDirectory(configDir);

  const sampleSpecPath = path.join(specsDir, "project-spec.json");
  const configPath = path.join(configDir, "factory.config.json");
  await writeJson(sampleSpecPath, sampleProjectSpec);
  await writeJson(configPath, defaultFactoryConfig);

  return {
    targetDir: path.resolve(targetDir),
    sampleSpecPath,
    configPath
  };
}

export async function validateSpec(specPath) {
  const resolvedSpecPath = path.resolve(specPath);
  const spec = await readJson(resolvedSpecPath);
  const validation = validateProjectSpec(spec);

  return {
    resolvedSpecPath,
    validation,
    summary: validation.valid ? summarizeSpec(spec) : null
  };
}

export async function planProject(specPath, outputDir = "runs") {
  const resolvedSpecPath = path.resolve(specPath);
  const spec = await readJson(resolvedSpecPath);
  const validation = validateProjectSpec(spec);

  if (!validation.valid) {
    return {
      ok: false,
      validation
    };
  }

  const plan = buildExecutionPlan(spec);
  const resolvedOutputDir = path.resolve(outputDir);
  await ensureDirectory(resolvedOutputDir);

  const jsonPath = path.join(resolvedOutputDir, "execution-plan.json");
  const markdownPath = path.join(resolvedOutputDir, "execution-plan.md");

  await writeJson(jsonPath, plan);
  await writeFile(markdownPath, `${renderPlanMarkdown(plan)}\n`, "utf8");

  return {
    ok: true,
    plan,
    jsonPath,
    markdownPath
  };
}

export async function runProject(
  specPath,
  outputDir = "runs",
  requestedRunId,
  configPath = "config/factory.config.json"
) {
  const resolvedSpecPath = path.resolve(specPath);
  const workspaceRoot = inferWorkspaceRootFromSpecPath(resolvedSpecPath);
  const resolvedOutputDir = resolveWorkspaceRelativePath(workspaceRoot, outputDir);
  const spec = await readJson(resolvedSpecPath);
  const validation = validateProjectSpec(spec);

  if (!validation.valid) {
    return {
      ok: false,
      validation
    };
  }

  const { config, resolvedConfigPath } = await loadFactoryConfig(configPath, workspaceRoot);
  const plan = buildExecutionPlan(spec);
  const runState = createRunState(spec, plan, config, requestedRunId, workspaceRoot);
  const artifactPaths = createArtifactPaths(resolvedOutputDir, config, runState.runId);

  await ensureDirectory(artifactPaths.runDirectory);
  await ensureDirectory(artifactPaths.briefsDirectory);

  await writeJson(artifactPaths.specSnapshotPath, spec);
  await writeJson(artifactPaths.planJsonPath, plan);
  await writeFile(artifactPaths.planMarkdownPath, `${renderPlanMarkdown(plan)}\n`, "utf8");
  await writeJson(artifactPaths.rolesPath, roleDirectoryFromConfig(config));
  await writeJson(artifactPaths.statePath, runState);
  await writeFile(artifactPaths.reportPath, `${renderRunReport(runState, plan)}\n`, "utf8");

  for (const task of runState.taskLedger) {
    const briefPath = path.join(artifactPaths.briefsDirectory, `${task.id}.md`);
    await writeFile(briefPath, `${renderTaskBrief(spec, runState, task)}\n`, "utf8");
  }

  return {
    ok: true,
    runId: runState.runId,
    runDirectory: artifactPaths.runDirectory,
    statePath: artifactPaths.statePath,
    reportPath: artifactPaths.reportPath,
    summary: summarizeRunState(runState),
    configPath: resolvedConfigPath
  };
}

export async function reportProjectRun(runStatePath) {
  const resolvedRunStatePath = path.resolve(runStatePath);
  const runState = refreshRunState(await readJson(resolvedRunStatePath));
  const runDirectory = path.dirname(resolvedRunStatePath);
  const planPath = path.join(runDirectory, "execution-plan.json");
  const plan = await readJson(planPath);
  const reportPath = path.join(runDirectory, "report.md");
  const report = renderRunReport(runState, plan);

  await writeJson(resolvedRunStatePath, runState);
  await writeFile(reportPath, `${report}\n`, "utf8");

  return {
    runDirectory,
    reportPath,
    summary: summarizeRunState(runState)
  };
}

export async function updateRunTask(runStatePath, taskId, nextStatus, note = "") {
  const resolvedRunStatePath = path.resolve(runStatePath);
  const existingRunState = await readJson(resolvedRunStatePath);
  const nextRunState = updateTaskInRunState(existingRunState, taskId, nextStatus, note);
  const runDirectory = path.dirname(resolvedRunStatePath);
  const plan = await readJson(path.join(runDirectory, "execution-plan.json"));
  const reportPath = path.join(runDirectory, "report.md");

  await writeJson(resolvedRunStatePath, nextRunState);
  await writeFile(reportPath, `${renderRunReport(nextRunState, plan)}\n`, "utf8");

  return {
    runDirectory,
    reportPath,
    summary: summarizeRunState(nextRunState),
    task: nextRunState.taskLedger.find((task) => task.id === taskId)
  };
}

export async function scheduleTaskRetry(
  runStatePath,
  taskId,
  reason = "",
  retryDelayMinutes,
  configPath = "config/factory.config.json"
) {
  const resolvedRunStatePath = path.resolve(runStatePath);
  const runDirectory = path.dirname(resolvedRunStatePath);
  const existingRunState = await readJson(resolvedRunStatePath);
  const workspaceRoot = inferWorkspaceRootFromRunState(existingRunState, resolvedRunStatePath);
  const { config } = await loadFactoryConfig(configPath, workspaceRoot);
  const retryConfig = config.retryPolicy.hybridSurface ?? {
    maxAttempts: 3,
    retryDelayMinutes: 3,
    unlockAfterMinutes: 30
  };
  const issue = classifyHybridIssue(reason);
  const effectiveDelayMinutes =
    typeof retryDelayMinutes === "number" && Number.isFinite(retryDelayMinutes)
      ? retryDelayMinutes
      : retryConfig.retryDelayMinutes;
  const effectiveUnlockDelayMinutes =
    typeof retryConfig.unlockAfterMinutes === "number" && Number.isFinite(retryConfig.unlockAfterMinutes)
      ? retryConfig.unlockAfterMinutes
      : null;
  const targetTask = existingRunState.taskLedger.find((task) => task.id === taskId);

  if (!targetTask) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (!["ready", "in_progress", "waiting_retry"].includes(targetTask.status)) {
    throw new Error(
      `Cannot schedule a retry for task ${taskId} while it is ${targetTask.status}.`
    );
  }

  const retryCount = (targetTask.retryCount ?? 0) + 1;
  const shouldEscalate = retryCount >= retryConfig.maxAttempts;
  const now = new Date();
  const nextRetryAt = shouldEscalate
    ? effectiveUnlockDelayMinutes === null
      ? null
      : addMinutes(now, effectiveUnlockDelayMinutes)
    : addMinutes(now, effectiveDelayMinutes);
  const nextRunState = refreshRunState({
    ...existingRunState,
    updatedAt: now.toISOString(),
    taskLedger: existingRunState.taskLedger.map((task) => {
      if (task.id !== taskId) {
        return task;
      }

      const nextStatus = shouldEscalate ? "blocked" : "waiting_retry";
      const statusNote = shouldEscalate
        ? `retry-escalated:${issue.reason}`
        : `retry-scheduled:${issue.reason}`;

      return {
        ...task,
        status: nextStatus,
        retryCount,
        nextRetryAt,
        lastRetryReason: issue.reason,
        notes: [
          ...(Array.isArray(task.notes) ? task.notes : []),
          `${now.toISOString()} ${statusNote}`
        ]
      };
    })
  });
  const plan = await readJson(path.join(runDirectory, "execution-plan.json"));
  const reportPath = path.join(runDirectory, "report.md");

  await writeJson(resolvedRunStatePath, nextRunState);
  await writeFile(reportPath, `${renderRunReport(nextRunState, plan)}\n`, "utf8");

  return {
    runDirectory,
    reportPath,
    classification: issue.retryable ? "retryable_transient" : "manual_retry_requested",
    nextRetryAt,
    retryCount,
    escalated: shouldEscalate,
    summary: summarizeRunState(nextRunState),
    task: nextRunState.taskLedger.find((task) => task.id === taskId)
  };
}

export async function tickProjectRun(
  runStatePath,
  doctorReportPath = "reports/runtime-doctor.json",
  outputDir
) {
  const resolvedRunStatePath = path.resolve(runStatePath);
  const previousRunState = await readJson(resolvedRunStatePath);
  const workspaceRoot = inferWorkspaceRootFromRunState(previousRunState, resolvedRunStatePath);
  const refreshedRunState = refreshRunState(previousRunState);
  const runDirectory = path.dirname(resolvedRunStatePath);
  const plan = await readJson(path.join(runDirectory, "execution-plan.json"));
  const reportPath = path.join(runDirectory, "report.md");
  const promotedRetryTasks = [];
  const newlyReadyTasks = [];

  for (const refreshedTask of refreshedRunState.taskLedger) {
    const previousTask = previousRunState.taskLedger.find((task) => task.id === refreshedTask.id);

    if (!previousTask) {
      continue;
    }

    if (previousTask.status === "waiting_retry" && refreshedTask.status === "ready") {
      promotedRetryTasks.push(refreshedTask.id);
      newlyReadyTasks.push(refreshedTask.id);
      continue;
    }

    if (previousTask.status !== "ready" && refreshedTask.status === "ready") {
      newlyReadyTasks.push(refreshedTask.id);
    }
  }

  await writeJson(resolvedRunStatePath, refreshedRunState);
  await writeFile(reportPath, `${renderRunReport(refreshedRunState, plan)}\n`, "utf8");

  const handoffResult = await createRunHandoffs(
    resolvedRunStatePath,
    outputDir,
    resolveWorkspaceRelativePath(workspaceRoot, doctorReportPath)
  );
  const nextRunState = await readJson(resolvedRunStatePath);

  return {
    runDirectory,
    reportPath,
    handoffIndexPath: handoffResult.indexPath,
    readyTaskCount: handoffResult.readyTaskCount,
    promotedRetryTasks,
    newlyReadyTasks,
    descriptors: handoffResult.descriptors,
    summary: summarizeRunState(nextRunState)
  };
}

function mapArtifactStatusToTaskStatus(status) {
  if (status === "completed") {
    return "completed";
  }

  if (status === "failed") {
    return "failed";
  }

  return "blocked";
}

export async function applyTaskResult(runStatePath, taskId, resultPath) {
  const resolvedRunStatePath = path.resolve(runStatePath);
  const resolvedResultPath = path.resolve(resultPath);
  const runDirectory = path.dirname(resolvedRunStatePath);
  const existingRunState = await readJson(resolvedRunStatePath);
  const targetTask = existingRunState.taskLedger.find((task) => task.id === taskId);

  if (!targetTask) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (!["ready", "in_progress", "waiting_retry"].includes(targetTask.status)) {
    throw new Error(
      `Cannot apply a result artifact to task ${taskId} while it is ${targetTask.status}.`
    );
  }

  if (
    typeof targetTask.activeResultPath === "string" &&
    targetTask.activeResultPath.trim().length > 0 &&
    path.resolve(targetTask.activeResultPath) !== resolvedResultPath
  ) {
    throw new Error(
      `Result artifact path mismatch: expected ${targetTask.activeResultPath}, received ${resolvedResultPath}.`
    );
  }

  const artifact = validateResultArtifact(await readJson(resolvedResultPath), {
    runId: existingRunState.runId,
    taskId,
    handoffId:
      typeof targetTask.activeHandoffId === "string" && targetTask.activeHandoffId.trim().length > 0
        ? targetTask.activeHandoffId
        : undefined
  });
  const nextStatus = mapArtifactStatusToTaskStatus(artifact.status);

  const nextRunState = updateTaskInRunState(
    existingRunState,
    taskId,
    nextStatus,
    `result:${artifact.status}`
  );
  const plan = await readJson(path.join(runDirectory, "execution-plan.json"));
  const reportPath = path.join(runDirectory, "report.md");

  await writeJson(resolvedRunStatePath, nextRunState);
  await writeFile(reportPath, `${renderRunReport(nextRunState, plan)}\n`, "utf8");

  return {
    runDirectory,
    reportPath,
    resultPath: resolvedResultPath,
    artifact,
    summary: summarizeRunState(nextRunState),
    task: nextRunState.taskLedger.find((task) => task.id === taskId)
  };
}

export async function createRunHandoffs(
  runStatePath,
  outputDir,
  doctorReportPath = "reports/runtime-doctor.json"
) {
  const resolvedRunStatePath = path.resolve(runStatePath);
  const runDirectory = path.dirname(resolvedRunStatePath);
  const resolvedOutputDir = resolveRunRelativePath(runDirectory, outputDir, path.join(runDirectory, "handoffs"));
  const runState = refreshRunState(await readJson(resolvedRunStatePath));
  const workspaceRoot = inferWorkspaceRootFromRunState(runState, resolvedRunStatePath);
  const plan = await readJson(path.join(runDirectory, "execution-plan.json"));
  const spec = await readJson(path.join(runDirectory, "spec.snapshot.json"));
  const { report: doctorReport } = await loadDoctorReport(doctorReportPath, workspaceRoot);
  const resultsDirectory = path.join(resolvedOutputDir, "results");

  await ensureDirectory(resolvedOutputDir);
  await ensureDirectory(resultsDirectory);

  const readyTasks = runState.taskLedger.filter((task) => task.status === "ready");
  const descriptors = [];
  const activeHandoffsByTaskId = new Map();

  for (const task of readyTasks) {
    const handoffId = randomUUID();
    const rolePromptTemplate = await readRolePrompt(task.role);
    const promptPath = path.join(resolvedOutputDir, `${task.id}.prompt.md`);
    const briefPath = path.join(runDirectory, "task-briefs", `${task.id}.md`);
    const resultPath = path.join(resultsDirectory, `${task.id}.${handoffId}.result.json`);
    const descriptor = buildHandoffDescriptor({
      workspacePath: runState.workspacePath ?? process.cwd(),
      spec,
      runState,
      plan,
      task,
      handoffId,
      rolePromptTemplate,
      promptPath,
      briefPath,
      resultPath,
      doctorReport
    });

    const handoffJsonPath = path.join(resolvedOutputDir, `${task.id}.handoff.json`);
    const handoffMarkdownPath = path.join(resolvedOutputDir, `${task.id}.handoff.md`);
    const launcherPath = path.join(resolvedOutputDir, `${task.id}.launch.ps1`);

    await writeFile(promptPath, `${descriptor.promptText}\n`, "utf8");
    await writeJson(handoffJsonPath, descriptor);
    await writeFile(
      handoffMarkdownPath,
      `${renderHandoffMarkdown(descriptor, resolvedOutputDir)}\n`,
      "utf8"
    );
    await writeFile(launcherPath, `${descriptor.launcherScript}\n`, "utf8");

    descriptors.push({
      runId: runState.runId,
      taskId: task.id,
      handoffId: descriptor.handoffId,
      runtime: descriptor.runtime,
      handoffJsonPath,
      handoffMarkdownPath,
      launcherPath,
      promptPath,
      resultPath
    });
    activeHandoffsByTaskId.set(task.id, {
      handoffId: descriptor.handoffId,
      resultPath,
      outputDir: resolvedOutputDir
    });
  }

  const nextRunState = {
    ...runState,
    taskLedger: runState.taskLedger.map((task) => {
      const activeHandoff = activeHandoffsByTaskId.get(task.id);

      if (!activeHandoff) {
        return task;
      }

      return {
        ...task,
        activeHandoffId: activeHandoff.handoffId,
        activeResultPath: activeHandoff.resultPath,
        activeHandoffOutputDir: activeHandoff.outputDir
      };
    })
  };

  await writeJson(resolvedRunStatePath, nextRunState);
  await writeFile(path.join(runDirectory, "report.md"), `${renderRunReport(nextRunState, plan)}\n`, "utf8");

  const indexPath = path.join(resolvedOutputDir, "index.json");
  await writeJson(indexPath, {
    generatedAt: new Date().toISOString(),
    runId: runState.runId,
    runDirectory,
    runStatePath: resolvedRunStatePath,
    readyTaskCount: descriptors.length,
    descriptors
  });

  return {
    runId: runState.runId,
    outputDir: resolvedOutputDir,
    readyTaskCount: descriptors.length,
    descriptors,
    indexPath
  };
}

async function readRolePrompt(role) {
  const mapping = {
    planner: "planner.md",
    reviewer: "reviewer.md",
    executor: "executor.md",
    verifier: "verifier.md",
    orchestrator: "planner.md"
  };
  const fileName = mapping[role] ?? "planner.md";
  return readFile(path.join(packageRootDirectory, "prompts", fileName), "utf8");
}
