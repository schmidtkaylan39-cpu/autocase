#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";

import {
  applyTaskResult,
  confirmIntake,
  createRunHandoffs,
  intakeRequest,
  initProject,
  planProject,
  reportProjectRun,
  reviseIntake,
  runProject,
  scheduleTaskRetry,
  tickProjectRun,
  updateRunTask,
  validateSpec
} from "./lib/commands.mjs";
import { dispatchHandoffs } from "./lib/dispatch.mjs";
import { runAutonomousLoop } from "./lib/autonomous-run.mjs";
import { runRuntimeDoctor } from "./lib/doctor.mjs";
import { normalizePanelPort, startPanelServer } from "./lib/panel.mjs";
import { createReviewBundle } from "./lib/review-bundle.mjs";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json");

function printHelp() {
  console.log(`${packageMetadata.name} v${packageMetadata.version}

Usage:
  ${packageMetadata.name} init [targetDir]
  ${packageMetadata.name} intake <request> [workspaceDir]
  ${packageMetadata.name} confirm [workspaceDir]
  ${packageMetadata.name} revise [request] [workspaceDir]
  ${packageMetadata.name} validate <specPath>
  ${packageMetadata.name} plan <specPath> [outputDir]
  ${packageMetadata.name} run <specPath> [outputDir] [runId]
  ${packageMetadata.name} report <runStatePath>
  ${packageMetadata.name} task <runStatePath> <taskId> <status> [note]
  ${packageMetadata.name} result <runStatePath> <taskId> <resultPath>
  ${packageMetadata.name} retry <runStatePath> <taskId> [reason] [delayMinutes]
  ${packageMetadata.name} tick <runStatePath> [doctorReportPath] [outputDir]
  ${packageMetadata.name} review-bundle [outputDir] [bundleName] [--no-archive] [--allow-dirty]
  ${packageMetadata.name} doctor [outputDir]
  ${packageMetadata.name} handoff <runStatePath> [outputDir] [doctorReportPath]
  ${packageMetadata.name} dispatch <handoffIndexPath> [dry-run|execute]
  ${packageMetadata.name} autonomous <runStatePath> [doctorReportPath] [outputDir] [maxRounds]
  ${packageMetadata.name} panel [workspaceDir] [port]
  ${packageMetadata.name} --help
  ${packageMetadata.name} --version
`);
}

function printVersion() {
  console.log(packageMetadata.version);
}

async function runInit(targetDir = ".") {
  const result = await initProject(targetDir);
  console.log(`Starter structure created: ${result.targetDir}`);
  console.log(`Sample spec: ${result.sampleSpecPath}`);
  console.log(`Factory config: ${result.configPath}`);
  console.log(`Agents guide: ${result.agentsPath}`);

  if (Array.isArray(result.createdFiles) && result.createdFiles.length > 0) {
    console.log("Created files:");
    result.createdFiles.forEach((filePath) => console.log(`- ${filePath}`));
  }

  if (Array.isArray(result.preservedFiles) && result.preservedFiles.length > 0) {
    console.log("Preserved existing files:");
    result.preservedFiles.forEach((filePath) => console.log(`- ${filePath}`));
  }
}

async function runValidate(specPath) {
  const result = await validateSpec(specPath);

  if (!result.validation.valid) {
    console.error("Spec validation failed:");
    result.validation.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log("Spec validation passed.");
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runIntake(userRequest, workspaceDir = ".") {
  const result = await intakeRequest(userRequest, workspaceDir);
  console.log(`Clarification workspace: ${result.workspaceRoot}`);
  console.log(`Intake spec: ${result.artifactPaths.intakeSpecPath}`);
  console.log(`Intake summary: ${result.artifactPaths.intakeSummaryPath}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runConfirm(workspaceDir = ".") {
  const result = await confirmIntake(workspaceDir);
  console.log(`Clarification confirmed in: ${result.workspaceRoot}`);
  console.log(`Intake spec: ${result.artifactPaths.intakeSpecPath}`);
  console.log(`Intake summary: ${result.artifactPaths.intakeSummaryPath}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runRevise(userRequest, workspaceDir = ".") {
  const result = await reviseIntake(userRequest, workspaceDir);
  console.log(`Clarification revised in: ${result.workspaceRoot}`);
  console.log(`Intake spec: ${result.artifactPaths.intakeSpecPath}`);
  console.log(`Intake summary: ${result.artifactPaths.intakeSummaryPath}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runPlan(specPath, outputDir = "runs") {
  const result = await planProject(specPath, outputDir);

  if (!result.ok) {
    console.error("Could not generate an execution plan because the spec is invalid:");
    result.validation.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log(`Execution plan JSON: ${result.jsonPath}`);
  console.log(`Execution plan Markdown: ${result.markdownPath}`);
}

async function runWorkflow(specPath, outputDir = "runs", runId) {
  const result = await runProject(specPath, outputDir, runId);

  if (!result.ok) {
    console.error("Could not create a run because the spec is invalid:");
    result.validation.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log(`Run created: ${result.runId}`);
  console.log(`Run directory: ${result.runDirectory}`);
  console.log(`Run state: ${result.statePath}`);
  console.log(`Run report: ${result.reportPath}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runReport(runStatePath) {
  const result = await reportProjectRun(runStatePath);
  console.log(`Run report refreshed: ${result.reportPath}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runTaskUpdate(runStatePath, taskId, status, note = "") {
  const result = await updateRunTask(runStatePath, taskId, status, note);
  console.log(`Task updated: ${taskId}`);
  console.log(JSON.stringify(result.task, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runTaskResult(runStatePath, taskId, resultPath) {
  const result = await applyTaskResult(runStatePath, taskId, resultPath);
  console.log(`Task result applied: ${taskId}`);
  console.log(JSON.stringify(result.task, null, 2));
  console.log(JSON.stringify(result.artifact, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runTaskRetry(runStatePath, taskId, reason = "", delayMinutes) {
  const parsedDelayMinutes =
    delayMinutes === undefined ? undefined : Number.parseInt(delayMinutes, 10);
  const result = await scheduleTaskRetry(runStatePath, taskId, reason, parsedDelayMinutes);
  console.log(`Task retry scheduled: ${taskId}`);
  console.log(JSON.stringify(result.task, null, 2));
  console.log(
    JSON.stringify(
      {
        classification: result.classification,
        nextRetryAt: result.nextRetryAt,
        retryCount: result.retryCount,
        escalated: result.escalated
      },
      null,
      2
    )
  );
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runTick(runStatePath, doctorReportPath, outputDir) {
  const result = await tickProjectRun(runStatePath, doctorReportPath, outputDir);
  console.log(`Tick report: ${result.reportPath}`);
  console.log(`Tick handoff index: ${result.handoffIndexPath}`);
  console.log(
    JSON.stringify(
      {
        promotedRetryTasks: result.promotedRetryTasks,
        newlyReadyTasks: result.newlyReadyTasks,
        readyTaskCount: result.readyTaskCount
      },
      null,
      2
    )
  );
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runReviewBundle(args) {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const positionals = args.filter((arg) => !arg.startsWith("--"));
  const [outputDir, bundleName] = positionals;
  const archive = !flags.includes("--no-archive");
  const allowDirty = flags.includes("--allow-dirty");
  const result = await createReviewBundle({
    outputDir,
    bundleName,
    archive,
    allowDirty
  });
  console.log(`Review bundle directory: ${result.bundleDirectory}`);
  console.log(`Review manifest: ${result.manifestPath}`);
  console.log(`Review brief: ${result.reviewBriefPath}`);
  console.log(`Archive: ${result.archivePath ?? "directory only"}`);
  console.log(
    JSON.stringify(
      {
        archiveFormat: result.archiveFormat,
        fileCount: result.fileCount
      },
      null,
      2
    )
  );
}

async function runDoctor(outputDir = "reports") {
  const result = await runRuntimeDoctor(outputDir);
  console.log(`Doctor JSON: ${result.jsonPath}`);
  console.log(`Doctor Markdown: ${result.markdownPath}`);
  console.log(
    JSON.stringify(
      result.checks.map((check) => ({
        id: check.id,
        ok: check.ok
      })),
      null,
      2
    )
  );
}

async function runHandoff(runStatePath, outputDir, doctorReportPath) {
  const result = await createRunHandoffs(runStatePath, outputDir, doctorReportPath);
  console.log(`Handoff directory: ${result.outputDir}`);
  console.log(`Ready task count: ${result.readyTaskCount}`);
  console.log(`Handoff index: ${result.indexPath}`);
  console.log(
    JSON.stringify(
      result.descriptors.map((item) => ({
        taskId: item.taskId,
        runtime: item.runtime.label,
        launcherPath: item.launcherPath
      })),
      null,
      2
    )
  );
}

async function runDispatch(handoffIndexPath, mode = "dry-run") {
  const result = await dispatchHandoffs(handoffIndexPath, mode);
  console.log(`Dispatch JSON: ${result.resultJsonPath}`);
  console.log(`Dispatch Markdown: ${result.resultMarkdownPath}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

async function runAutonomous(runStatePath, doctorReportPath, outputDir, maxRounds) {
  const parsedMaxRounds = maxRounds === undefined ? undefined : Number.parseInt(maxRounds, 10);
  const result = await runAutonomousLoop(runStatePath, {
    doctorReportPath,
    handoffOutputDir: outputDir,
    maxRounds: Number.isFinite(parsedMaxRounds) ? parsedMaxRounds : undefined
  });
  console.log(`Autonomous summary JSON: ${result.summaryJsonPath}`);
  console.log(`Autonomous summary Markdown: ${result.summaryMarkdownPath}`);
  console.log(JSON.stringify(result.summary.runSummary, null, 2));
}

async function runPanel(workspaceDir = ".", portArg) {
  const port = normalizePanelPort(portArg);
  const panel = await startPanelServer({
    workspaceDir,
    port
  });

  console.log(`Panel workspace: ${panel.workspaceRoot}`);
  console.log(`Panel URL: ${panel.url}`);
  console.log("Press Ctrl+C to stop the panel server.");

  await new Promise((resolve, reject) => {
    let closing = false;

    const closeServer = () => {
      if (closing) {
        return;
      }

      closing = true;
      panel
        .close()
        .then(() => resolve())
        .catch((error) => reject(error));
    };

    process.once("SIGINT", closeServer);
    process.once("SIGTERM", closeServer);
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const [arg1, arg2, arg3, arg4] = args;

  switch (command) {
    case "init":
      await runInit(arg1);
      break;
    case "intake":
      if (!arg1) {
        throw new Error("Please provide a user request.");
      }
      await runIntake(arg1, arg2);
      break;
    case "confirm":
      await runConfirm(arg1);
      break;
    case "revise":
      await runRevise(arg1, arg2);
      break;
    case "validate":
      if (!arg1) {
        throw new Error("Please provide a spec path.");
      }
      await runValidate(arg1);
      break;
    case "plan":
      if (!arg1) {
        throw new Error("Please provide a spec path.");
      }
      await runPlan(arg1, arg2);
      break;
    case "run":
      if (!arg1) {
        throw new Error("Please provide a spec path.");
      }
      await runWorkflow(arg1, arg2, arg3);
      break;
    case "report":
      if (!arg1) {
        throw new Error("Please provide a run-state path.");
      }
      await runReport(arg1);
      break;
    case "task":
      if (!arg1 || !arg2 || !arg3) {
        throw new Error("Please provide run-state path, task id, and status.");
      }
      await runTaskUpdate(arg1, arg2, arg3, arg4 ?? "");
      break;
    case "result":
      if (!arg1 || !arg2 || !arg3) {
        throw new Error("Please provide run-state path, task id, and result path.");
      }
      await runTaskResult(arg1, arg2, arg3);
      break;
    case "retry":
      if (!arg1 || !arg2) {
        throw new Error("Please provide run-state path and task id.");
      }
      await runTaskRetry(arg1, arg2, arg3 ?? "", arg4);
      break;
    case "tick":
      if (!arg1) {
        throw new Error("Please provide a run-state path.");
      }
      await runTick(arg1, arg2, arg3);
      break;
    case "review-bundle":
      await runReviewBundle(args);
      break;
    case "doctor":
      await runDoctor(arg1);
      break;
    case "handoff":
      if (!arg1) {
        throw new Error("Please provide a run-state path.");
      }
      await runHandoff(arg1, arg2, arg3);
      break;
    case "dispatch":
      if (!arg1) {
        throw new Error("Please provide a handoff index path.");
      }
      await runDispatch(arg1, arg2);
      break;
    case "autonomous":
      if (!arg1) {
        throw new Error("Please provide a run-state path.");
      }
      await runAutonomous(arg1, arg2, arg3, arg4);
      break;
    case "panel":
      await runPanel(arg1, arg2);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      printVersion();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
