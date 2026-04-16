import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDirectory = path.join(projectRoot, ".github", "workflows");

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

function validateWorkflowShape(fileName, workflow) {
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
