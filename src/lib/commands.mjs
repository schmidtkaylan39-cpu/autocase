import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
import { sampleProjectSpec } from "./sample-spec.mjs";
import { summarizeSpec, validateProjectSpec } from "./spec.mjs";
import { buildExecutionPlan, renderPlanMarkdown } from "./workflow.mjs";

async function loadFactoryConfig(configPath = "config/factory.config.json") {
  const resolvedConfigPath = path.resolve(configPath);

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

async function loadDoctorReport(doctorReportPath = "reports/runtime-doctor.json") {
  const resolvedDoctorReportPath = path.resolve(doctorReportPath);

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
  const spec = await readJson(resolvedSpecPath);
  const validation = validateProjectSpec(spec);

  if (!validation.valid) {
    return {
      ok: false,
      validation
    };
  }

  const { config, resolvedConfigPath } = await loadFactoryConfig(configPath);
  const plan = buildExecutionPlan(spec);
  const runState = createRunState(spec, plan, config, requestedRunId);
  const artifactPaths = createArtifactPaths(outputDir, config, runState.runId);

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

export async function createRunHandoffs(
  runStatePath,
  outputDir,
  doctorReportPath = "reports/runtime-doctor.json"
) {
  const resolvedRunStatePath = path.resolve(runStatePath);
  const runDirectory = path.dirname(resolvedRunStatePath);
  const resolvedOutputDir = path.resolve(outputDir || path.join(runDirectory, "handoffs"));
  const runState = await readJson(resolvedRunStatePath);
  const plan = await readJson(path.join(runDirectory, "execution-plan.json"));
  const spec = await readJson(path.join(runDirectory, "spec.snapshot.json"));
  const { report: doctorReport } = await loadDoctorReport(doctorReportPath);
  const resultsDirectory = path.join(resolvedOutputDir, "results");

  await ensureDirectory(resolvedOutputDir);
  await ensureDirectory(resultsDirectory);

  const readyTasks = runState.taskLedger.filter((task) => task.status === "ready");
  const descriptors = [];

  for (const task of readyTasks) {
    const rolePromptTemplate = await readRolePrompt(task.role);
    const promptPath = path.join(resolvedOutputDir, `${task.id}.prompt.md`);
    const briefPath = path.join(runDirectory, "task-briefs", `${task.id}.md`);
    const resultPath = path.join(resultsDirectory, `${task.id}.result.json`);
    const descriptor = buildHandoffDescriptor({
      workspacePath: process.cwd(),
      spec,
      runState,
      plan,
      task,
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
      taskId: task.id,
      runtime: descriptor.runtime,
      handoffJsonPath,
      handoffMarkdownPath,
      launcherPath,
      promptPath,
      resultPath
    });
  }

  const indexPath = path.join(resolvedOutputDir, "index.json");
  await writeJson(indexPath, {
    generatedAt: new Date().toISOString(),
    runId: runState.runId,
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
  return readFile(path.resolve("prompts", fileName), "utf8");
}
