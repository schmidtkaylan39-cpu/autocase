import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import { readRunStateArtifact } from "./control-plane-artifacts.mjs";
import { buildHandoffDescriptor, getLauncherMetadata, renderHandoffMarkdown } from "./handoffs.mjs";
import { clarifyIntakeRequest } from "./intake-clarifier.mjs";
import {
  createBlockedConfirmationSpec,
  createConfirmedIntakeSpec,
  createRunStateIntakeContext,
  ensureIntakePlanningReady,
  ensureRunStateIntakePlanningReady,
  loadIntakeArtifacts,
  writeIntakeArtifacts
} from "./intake-state.mjs";
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
import { applyTaskArtifactToRunState } from "./result-application.mjs";
import { sampleProjectSpec } from "./sample-spec.mjs";
import { summarizeSpec, validateProjectSpec } from "./spec.mjs";
import { buildExecutionPlan, renderPlanMarkdown } from "./workflow.mjs";

const packageRootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const UTF8_BOM = "\uFEFF";

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonIfMissing(targetPath, value) {
  if (await fileExists(targetPath)) {
    return false;
  }

  await writeJson(targetPath, value);
  return true;
}

async function writeTextFileIfMissing(targetPath, value) {
  if (await fileExists(targetPath)) {
    return false;
  }

  await writeFile(targetPath, value, "utf8");
  return true;
}

async function writeTextFileWithOptionalBom(targetPath, value, options = {}) {
  const { bom = false } = options;
  const normalizedValue = typeof value === "string" ? value : String(value ?? "");
  const fileContents = bom && !normalizedValue.startsWith(UTF8_BOM) ? `${UTF8_BOM}${normalizedValue}` : normalizedValue;
  await writeFile(targetPath, fileContents, "utf8");
}

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

function normalizePathSegmentForComparison(value) {
  return process.platform === "win32" ? String(value).toLowerCase() : String(value);
}

function assertCanonicalHandoffOutputDir(runDirectory, resolvedOutputDir) {
  const relativeFromRun = path.relative(runDirectory, resolvedOutputDir);

  if (
    relativeFromRun.length === 0 ||
    relativeFromRun === "." ||
    relativeFromRun.startsWith("..") ||
    path.isAbsolute(relativeFromRun)
  ) {
    return;
  }

  const segments = relativeFromRun.split(/[\\/]+/).filter(Boolean);
  const runId = path.basename(runDirectory);

  if (
    segments.length >= 2 &&
    normalizePathSegmentForComparison(segments[0]) === "runs" &&
    normalizePathSegmentForComparison(segments[1]) === normalizePathSegmentForComparison(runId)
  ) {
    throw new Error(
      `Refusing to generate handoffs inside a nested run directory: ${resolvedOutputDir}. ` +
        'Pass an absolute output directory or a run-relative leaf such as "handoffs-failover".'
    );
  }
}

function summarizeIntake(spec) {
  return {
    requestId: spec.requestId,
    clarificationStatus: spec.clarificationStatus,
    confirmedByUser: spec.confirmedByUser,
    openQuestionCount: Array.isArray(spec.openQuestions) ? spec.openQuestions.length : 0,
    approvalRequired: spec.approvalRequired,
    canFullyAutomate: spec.automationAssessment?.canFullyAutomate ?? false,
    estimatedAutomatablePercent: spec.automationAssessment?.estimatedAutomatablePercent ?? 0,
    recommendedNextStep: spec.recommendedNextStep
  };
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
  const agentsTemplatePath = path.join(packageRootDirectory, "templates", "AGENTS.template.md");

  await ensureDirectory(specsDir);
  await ensureDirectory(runsDir);
  await ensureDirectory(reportsDir);
  await ensureDirectory(configDir);

  const sampleSpecPath = path.join(specsDir, "project-spec.json");
  const configPath = path.join(configDir, "factory.config.json");
  const agentsPath = path.resolve(targetDir, "AGENTS.md");
  const agentsTemplate = await readFile(agentsTemplatePath, "utf8");
  const createdFiles = [];
  const preservedFiles = [];

  if (await writeJsonIfMissing(sampleSpecPath, sampleProjectSpec)) {
    createdFiles.push(sampleSpecPath);
  } else {
    preservedFiles.push(sampleSpecPath);
  }

  if (await writeJsonIfMissing(configPath, defaultFactoryConfig)) {
    createdFiles.push(configPath);
  } else {
    preservedFiles.push(configPath);
  }

  if (await writeTextFileIfMissing(agentsPath, agentsTemplate)) {
    createdFiles.push(agentsPath);
  } else {
    preservedFiles.push(agentsPath);
  }

  return {
    targetDir: path.resolve(targetDir),
    sampleSpecPath,
    configPath,
    agentsPath,
    createdFiles,
    preservedFiles
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

export async function intakeRequest(
  userRequest,
  workspaceDir = ".",
  configPath = "config/factory.config.json"
) {
  const workspaceRoot = path.resolve(workspaceDir);
  const { config } = await loadFactoryConfig(configPath, workspaceRoot);
  const spec = clarifyIntakeRequest(userRequest);
  const artifactPaths = await writeIntakeArtifacts(workspaceRoot, spec, config);

  return {
    workspaceRoot,
    artifactPaths,
    spec,
    summary: summarizeIntake(spec)
  };
}

export async function confirmIntake(workspaceDir = ".", configPath = "config/factory.config.json") {
  const workspaceRoot = path.resolve(workspaceDir);
  const { config } = await loadFactoryConfig(configPath, workspaceRoot);
  const intake = await loadIntakeArtifacts(workspaceRoot, config);

  if (!intake.exists || !intake.spec) {
    throw new Error(`No clarification artifact was found under ${workspaceRoot}. Run intake first.`);
  }

  let preview;

  try {
    preview = createConfirmedIntakeSpec(intake.spec);
  } catch (error) {
    const blockedSpec = createBlockedConfirmationSpec(intake.spec);
    const artifactPaths = await writeIntakeArtifacts(workspaceRoot, blockedSpec, config);
    const reasonText = error instanceof Error ? error.message : String(error);

    throw new Error(
      [
        "Cannot confirm intake yet.",
        `- ${reasonText}`,
        `- intakeSpecPath: ${artifactPaths.intakeSpecPath}`,
        `- intakeSummaryPath: ${artifactPaths.intakeSummaryPath}`
      ].join("\n"),
      {
        cause: error
      }
    );
  }

  const artifactPaths = await writeIntakeArtifacts(workspaceRoot, preview, config);

  return {
    workspaceRoot,
    artifactPaths,
    spec: preview,
    summary: summarizeIntake(preview)
  };
}

export async function reviseIntake(
  updatedRequest,
  workspaceDir = ".",
  configPath = "config/factory.config.json"
) {
  const workspaceRoot = path.resolve(workspaceDir);
  const { config } = await loadFactoryConfig(configPath, workspaceRoot);
  const intake = await loadIntakeArtifacts(workspaceRoot, config);
  const nextRequest = typeof updatedRequest === "string" && updatedRequest.trim().length > 0
    ? updatedRequest
    : intake.spec?.originalRequest;

  if (typeof nextRequest !== "string" || nextRequest.trim().length === 0) {
    throw new Error("Please provide a revised request or run intake first.");
  }

  const spec = clarifyIntakeRequest(nextRequest, {
    requestId: intake.spec?.requestId
  });
  const artifactPaths = await writeIntakeArtifacts(workspaceRoot, spec, config);

  return {
    workspaceRoot,
    artifactPaths,
    spec,
    summary: summarizeIntake(spec)
  };
}

export async function planProject(specPath, outputDir = "runs") {
  const resolvedSpecPath = path.resolve(specPath);
  const workspaceRoot = inferWorkspaceRootFromSpecPath(resolvedSpecPath);
  const { config } = await loadFactoryConfig("config/factory.config.json", workspaceRoot);
  await ensureIntakePlanningReady(workspaceRoot, config, "planning");
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
  const { config, resolvedConfigPath } = await loadFactoryConfig(configPath, workspaceRoot);
  await ensureIntakePlanningReady(workspaceRoot, config, "run creation");
  const spec = await readJson(resolvedSpecPath);
  const validation = validateProjectSpec(spec);

  if (!validation.valid) {
    return {
      ok: false,
      validation
    };
  }

  const plan = buildExecutionPlan(spec);
  const intake = await loadIntakeArtifacts(workspaceRoot, config);
  const intakeContext =
    intake.exists && intake.spec ? createRunStateIntakeContext(intake.spec, intake.artifactPaths, workspaceRoot) : null;
  const runState = createRunState(spec, plan, config, requestedRunId, workspaceRoot, intakeContext);
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
  const runState = refreshRunState(await readRunStateArtifact(resolvedRunStatePath));
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
  const existingRunState = await readRunStateArtifact(resolvedRunStatePath);
  const workspaceRoot = inferWorkspaceRootFromRunState(existingRunState, resolvedRunStatePath);
  await ensureRunStateIntakePlanningReady(existingRunState, workspaceRoot, null, "task update");
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
  const existingRunState = await readRunStateArtifact(resolvedRunStatePath);
  const workspaceRoot = inferWorkspaceRootFromRunState(existingRunState, resolvedRunStatePath);
  await ensureRunStateIntakePlanningReady(existingRunState, workspaceRoot, null, "retry scheduling");
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

  if (!["ready", "waiting_retry"].includes(targetTask.status)) {
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
  const previousRunState = await readRunStateArtifact(resolvedRunStatePath);
  const workspaceRoot = inferWorkspaceRootFromRunState(previousRunState, resolvedRunStatePath);
  await ensureRunStateIntakePlanningReady(previousRunState, workspaceRoot, null, "tick");
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
  const nextRunState = await readRunStateArtifact(resolvedRunStatePath);

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

export async function applyTaskResult(runStatePath, taskId, resultPath) {
  const resolvedRunStatePath = path.resolve(runStatePath);
  const resolvedResultPath = path.resolve(resultPath);
  const runDirectory = path.dirname(resolvedRunStatePath);
  const existingRunState = await readRunStateArtifact(resolvedRunStatePath);
  const workspaceRoot = inferWorkspaceRootFromRunState(existingRunState, resolvedRunStatePath);
  await ensureRunStateIntakePlanningReady(existingRunState, workspaceRoot, null, "result application");
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
    typeof targetTask.activeHandoffId !== "string" ||
    targetTask.activeHandoffId.trim().length === 0 ||
    typeof targetTask.activeResultPath !== "string" ||
    targetTask.activeResultPath.trim().length === 0
  ) {
    throw new Error(
      `Cannot apply a result artifact to task ${taskId} before an active handoff has been generated.`
    );
  }

  if (
    path.resolve(targetTask.activeResultPath) !== resolvedResultPath
  ) {
    throw new Error(
      `Result artifact path mismatch: expected ${targetTask.activeResultPath}, received ${resolvedResultPath}.`
    );
  }

  const artifact = validateResultArtifact(await readJson(resolvedResultPath), {
    runId: existingRunState.runId,
    taskId,
    handoffId: targetTask.activeHandoffId
  });
  const application = applyTaskArtifactToRunState(
    existingRunState,
    taskId,
    artifact,
    {
      notePrefix: "result"
    }
  );
  const plan = await readJson(path.join(runDirectory, "execution-plan.json"));
  const reportPath = path.join(runDirectory, "report.md");

  await writeJson(resolvedRunStatePath, application.runState);
  await writeFile(reportPath, `${renderRunReport(application.runState, plan)}\n`, "utf8");

  return {
    runDirectory,
    reportPath,
    resultPath: resolvedResultPath,
    artifact,
    summary: summarizeRunState(application.runState),
    task: application.task,
    updatedTasks: application.updatedTasks,
    appliedDecision: application.appliedDecision
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
  assertCanonicalHandoffOutputDir(runDirectory, resolvedOutputDir);
  const runState = refreshRunState(await readRunStateArtifact(resolvedRunStatePath));
  const workspaceRoot = inferWorkspaceRootFromRunState(runState, resolvedRunStatePath);
  await ensureRunStateIntakePlanningReady(runState, workspaceRoot, null, "handoff generation");
  const plan = await readJson(path.join(runDirectory, "execution-plan.json"));
  const spec = await readJson(path.join(runDirectory, "spec.snapshot.json"));
  const { report: doctorReport } = await loadDoctorReport(doctorReportPath, workspaceRoot);
  const resultsDirectory = path.join(resolvedOutputDir, "results");
  const launcherMetadata = getLauncherMetadata();

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
    const launcherPath = path.join(resolvedOutputDir, `${task.id}.launch${launcherMetadata.extension}`);
    const powerShellReadable = process.platform === "win32" && launcherMetadata.extension === ".ps1";

    await writeTextFileWithOptionalBom(promptPath, `${descriptor.promptText}\n`, {
      bom: powerShellReadable
    });
    await writeJson(handoffJsonPath, descriptor);
    await writeFile(
      handoffMarkdownPath,
      `${renderHandoffMarkdown(descriptor, resolvedOutputDir)}\n`,
      "utf8"
    );
    await writeTextFileWithOptionalBom(launcherPath, `${descriptor.launcherScript}\n`, {
      bom: powerShellReadable
    });

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
    orchestrator: "orchestrator.md"
  };
  const fileName = mapping[role] ?? "planner.md";
  return readFile(path.join(packageRootDirectory, "prompts", fileName), "utf8");
}
