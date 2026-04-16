import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import { buildPowerShellFileArgs, getPowerShellInvocation } from "./powershell.mjs";
import { renderRunReport, updateTaskInRunState } from "./run-state.mjs";

const execFileAsync = promisify(execFile);

function renderDispatchReport(summary, results) {
  return [
    "# Dispatch Report",
    "",
    `- mode: ${summary.mode}`,
    `- total: ${summary.total}`,
    `- executed: ${summary.executed}`,
    `- completed: ${summary.completed}`,
    `- incomplete: ${summary.incomplete}`,
    `- would_execute: ${summary.wouldExecute}`,
    `- skipped: ${summary.skipped}`,
    `- would_skip: ${summary.wouldSkip}`,
    `- failed: ${summary.failed}`,
    "",
    "## Results",
    ...results.map((result) => `- ${result.taskId} -> ${result.status} (${result.runtime})`)
  ].join("\n");
}

async function runPowerShellScript(scriptPath) {
  const runtime = getPowerShellInvocation();
  return execFileAsync(
    runtime.command,
    buildPowerShellFileArgs(scriptPath),
    {
      encoding: "utf8",
      windowsHide: runtime.windowsHide,
      timeout: 120000
    }
  );
}

function shouldAutoExecute(runtimeId) {
  return runtimeId === "openclaw" || runtimeId === "local-ci" || runtimeId === "codex";
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readResultArtifact(resultPath) {
  if (!resultPath || !(await fileExists(resultPath))) {
    return {
      exists: false,
      valid: false,
      artifact: null,
      reason: "Result artifact was not written."
    };
  }

  try {
    const artifact = await readJson(resultPath);
    const validStatus = new Set(["completed", "failed", "blocked"]);
    const valid =
      typeof artifact.summary === "string" &&
      validStatus.has(artifact.status) &&
      Array.isArray(artifact.changedFiles) &&
      Array.isArray(artifact.verification) &&
      Array.isArray(artifact.notes);

    return {
      exists: true,
      valid,
      artifact,
      reason: valid ? null : "Result artifact exists but does not match the expected schema."
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      artifact: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function mapDispatchResultToTaskStatus(result) {
  if (result.status === "completed") {
    return "completed";
  }

  if (result.status === "failed") {
    return "failed";
  }

  if (result.status === "incomplete") {
    return "blocked";
  }

  return null;
}

export async function dispatchHandoffs(indexPath, mode = "dry-run") {
  const resolvedIndexPath = path.resolve(indexPath);
  const handoffIndex = await readJson(resolvedIndexPath);
  const outputDir = path.dirname(resolvedIndexPath);
  const results = [];

  for (const descriptor of handoffIndex.descriptors) {
    const runtimeId = descriptor.runtime.id;

    if (mode === "dry-run") {
      results.push({
        taskId: descriptor.taskId,
        runtime: runtimeId,
        status: shouldAutoExecute(runtimeId) ? "would_execute" : "would_skip",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null
      });
      continue;
    }

    if (!shouldAutoExecute(runtimeId)) {
      results.push({
        taskId: descriptor.taskId,
        runtime: runtimeId,
        status: "skipped",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        note: "This runtime is currently treated as manual or hybrid only."
      });
      continue;
    }

    try {
      const execution = await runPowerShellScript(descriptor.launcherPath);
      const resultArtifact = await readResultArtifact(descriptor.resultPath ?? null);
      let status = "incomplete";
      let note = resultArtifact.reason ?? "Launcher finished but no result artifact was written.";

      if (resultArtifact.valid && resultArtifact.artifact?.status === "completed") {
        status = "completed";
        note = "Launcher finished and result artifact passed validation.";
      } else if (resultArtifact.valid && resultArtifact.artifact?.status === "failed") {
        status = "failed";
        note = "Runtime reported a failed task in the result artifact.";
      }

      results.push({
        taskId: descriptor.taskId,
        runtime: runtimeId,
        status,
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        stdout: execution.stdout.trim(),
        stderr: execution.stderr.trim(),
        note,
        artifact: resultArtifact.artifact
      });
    } catch (error) {
      results.push({
        taskId: descriptor.taskId,
        runtime: runtimeId,
        status: "failed",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode,
    total: results.length,
    executed: results.filter((item) => item.status === "completed" || item.status === "incomplete").length,
    completed: results.filter((item) => item.status === "completed").length,
    incomplete: results.filter((item) => item.status === "incomplete").length,
    wouldExecute: results.filter((item) => item.status === "would_execute").length,
    skipped: results.filter((item) => item.status === "skipped" || item.status === "would_skip").length,
    wouldSkip: results.filter((item) => item.status === "would_skip").length,
    failed: results.filter((item) => item.status === "failed").length
  };

  let runStateSync = null;

  if (mode === "execute") {
    const runDirectory = path.resolve(outputDir, "..");
    const runStatePath = path.join(runDirectory, "run-state.json");
    const planPath = path.join(runDirectory, "execution-plan.json");
    const reportPath = path.join(runDirectory, "report.md");

    if (await fileExists(runStatePath)) {
      let runState = await readJson(runStatePath);
      const updatedTasks = [];

      for (const result of results) {
        const nextStatus = mapDispatchResultToTaskStatus(result);

        if (!nextStatus) {
          continue;
        }

        runState = updateTaskInRunState(
          runState,
          result.taskId,
          nextStatus,
          `dispatch:${result.status}`
        );
        updatedTasks.push({
          taskId: result.taskId,
          nextStatus
        });
      }

      await writeJson(runStatePath, runState);

      if (await fileExists(planPath)) {
        const plan = await readJson(planPath);
        await writeFile(reportPath, `${renderRunReport(runState, plan)}\n`, "utf8");
      }

      runStateSync = {
        runStatePath,
        reportPath: (await fileExists(reportPath)) ? reportPath : null,
        updatedTasks
      };
    }
  }

  await ensureDirectory(outputDir);

  const resultJsonPath = path.join(outputDir, "dispatch-results.json");
  const resultMarkdownPath = path.join(outputDir, "dispatch-results.md");

  await writeJson(resultJsonPath, {
    summary,
    results,
    runStateSync
  });
  await writeFile(resultMarkdownPath, `${renderDispatchReport(summary, results)}\n`, "utf8");

  return {
    resultJsonPath,
    resultMarkdownPath,
    summary,
    results,
    runStateSync
  };
}
