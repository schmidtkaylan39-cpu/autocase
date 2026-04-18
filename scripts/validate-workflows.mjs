import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDirectory = path.join(projectRoot, ".github", "workflows");
const releaseReadinessWorkflowFiles = new Set(["release-readiness.yml", "release-readiness.yaml"]);
const requiredWindowsSmokeScripts = ["backup:project", "release:win"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function summarizeYamlError(error) {
  if (error?.linePos?.[0]) {
    const { line, col } = error.linePos[0];
    return `${error.message} (${line}:${col})`;
  }

  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runsOnTargetsWindows(runsOn) {
  if (typeof runsOn === "string") {
    return runsOn.toLowerCase().includes("windows");
  }

  if (Array.isArray(runsOn)) {
    return runsOn.some((candidate) => typeof candidate === "string" && candidate.toLowerCase().includes("windows"));
  }

  return false;
}

function stepTargetsWindows(step) {
  if (!isPlainObject(step) || typeof step.if !== "string") {
    return false;
  }

  const expression = step.if.toLowerCase();

  return expression.includes("windows-latest") || expression.includes("runner.os") && expression.includes("windows");
}

function stepRunsScript(step, scriptName) {
  if (!isPlainObject(step) || typeof step.run !== "string") {
    return false;
  }

  const commandPattern = new RegExp(`\\bnpm\\s+run\\s+${escapeRegExp(scriptName)}\\b`, "i");
  return commandPattern.test(step.run);
}

function describeStep(step) {
  if (isPlainObject(step) && typeof step.name === "string" && step.name.trim().length > 0) {
    return step.name.trim();
  }

  return "(unnamed step)";
}

export function validateReleaseReadinessWindowsSmoke(fileName, workflow) {
  const foundScripts = new Set();

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!isPlainObject(job) || !Array.isArray(job.steps)) {
      continue;
    }

    const jobTargetsWindows = runsOnTargetsWindows(job["runs-on"]);

    for (const step of job.steps) {
      for (const scriptName of requiredWindowsSmokeScripts) {
        if (!stepRunsScript(step, scriptName)) {
          continue;
        }

        if (!jobTargetsWindows && !stepTargetsWindows(step)) {
          throw new Error(
            `${fileName}: step "${describeStep(step)}" in job "${jobId}" runs "npm run ${scriptName}" without a Windows-only guard.`
          );
        }

        foundScripts.add(scriptName);
      }
    }
  }

  const missingScripts = requiredWindowsSmokeScripts.filter((scriptName) => !foundScripts.has(scriptName));

  if (missingScripts.length > 0) {
    const missingCommands = missingScripts.map((scriptName) => `"npm run ${scriptName}"`).join(", ");
    throw new Error(
      `${fileName}: missing required Windows release smoke command(s): ${missingCommands}.`
    );
  }
}

export function validateWorkflowSemantics(fileName, workflow) {
  if (!releaseReadinessWorkflowFiles.has(fileName)) {
    return;
  }

  validateReleaseReadinessWindowsSmoke(fileName, workflow);
}

export function validateWorkflowShape(fileName, workflow) {
  if (!isPlainObject(workflow)) {
    throw new Error(`${fileName}: workflow root must be a YAML mapping.`);
  }

  if (typeof workflow.name !== "string" || workflow.name.trim().length === 0) {
    throw new Error(`${fileName}: missing non-empty top-level "name".`);
  }

  if (!Object.hasOwn(workflow, "on")) {
    throw new Error(`${fileName}: missing top-level "on".`);
  }

  if (!isPlainObject(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
    throw new Error(`${fileName}: top-level "jobs" must contain at least one job.`);
  }

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!isPlainObject(job)) {
      throw new Error(`${fileName}: job "${jobId}" must be a YAML mapping.`);
    }

    if (!Object.hasOwn(job, "runs-on") && !Object.hasOwn(job, "uses")) {
      throw new Error(`${fileName}: job "${jobId}" must define "runs-on" or "uses".`);
    }
  }
}

async function validateWorkflowFile(filePath) {
  const fileName = path.basename(filePath);
  const source = await readFile(filePath, "utf8");
  const document = YAML.parseDocument(source, {
    prettyErrors: true,
    merge: true
  });

  if (document.errors.length > 0) {
    throw new Error(
      `${fileName}: ${document.errors.map((error) => summarizeYamlError(error)).join("; ")}`
    );
  }

  const workflow = document.toJS();
  validateWorkflowShape(fileName, workflow);
  validateWorkflowSemantics(fileName, workflow);

  return {
    fileName,
    jobCount: Object.keys(workflow.jobs).length
  };
}

async function main() {
  const directoryEntries = await readdir(workflowsDirectory, {
    withFileTypes: true
  });
  const workflowFiles = directoryEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => path.join(workflowsDirectory, name));

  if (workflowFiles.length === 0) {
    throw new Error("No workflow files found under .github/workflows.");
  }

  const results = [];

  for (const workflowFile of workflowFiles) {
    results.push(await validateWorkflowFile(workflowFile));
  }

  for (const result of results) {
    console.log(`PASS ${result.fileName} (${result.jobCount} jobs)`);
  }

  console.log(`Validated ${results.length} workflow files.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
