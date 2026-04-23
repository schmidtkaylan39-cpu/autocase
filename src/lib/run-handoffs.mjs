import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertCanonicalHandoffOutputDir,
  inferWorkspaceRootFromRunState,
  loadDoctorReport,
  packageRootDirectory,
  resolveRunRelativePath,
  writeTextFileWithOptionalBom
} from "./command-support.mjs";
import { readRunStateArtifact } from "./control-plane-artifacts.mjs";
import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import { buildHandoffDescriptor, getLauncherMetadata, renderHandoffMarkdown } from "./handoffs.mjs";
import { ensureRunStateIntakePlanningReady } from "./intake-state.mjs";
import { refreshRunState, renderRunReport } from "./run-state.mjs";

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
