#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";

import {
  applyTaskResult,
  createRunHandoffs,
  initProject,
  planProject,
  reportProjectRun,
  runProject,
  updateRunTask,
  validateSpec
} from "./lib/commands.mjs";
import { dispatchHandoffs } from "./lib/dispatch.mjs";
import { runRuntimeDoctor } from "./lib/doctor.mjs";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json");

function printHelp() {
  console.log(`${packageMetadata.name} v${packageMetadata.version}

Usage:
  ${packageMetadata.name} init [targetDir]
  ${packageMetadata.name} validate <specPath>
  ${packageMetadata.name} plan <specPath> [outputDir]
  ${packageMetadata.name} run <specPath> [outputDir] [runId]
  ${packageMetadata.name} report <runStatePath>
  ${packageMetadata.name} task <runStatePath> <taskId> <status> [note]
  ${packageMetadata.name} result <runStatePath> <taskId> <resultPath>
  ${packageMetadata.name} doctor [outputDir]
  ${packageMetadata.name} handoff <runStatePath> [outputDir] [doctorReportPath]
  ${packageMetadata.name} dispatch <handoffIndexPath> [dry-run|execute]
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

async function main() {
  const [command, arg1, arg2, arg3, arg4] = process.argv.slice(2);

  switch (command) {
    case "init":
      await runInit(arg1);
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
