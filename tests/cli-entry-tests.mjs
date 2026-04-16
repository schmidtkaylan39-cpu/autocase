import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runProject } from "../src/lib/commands.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntryPath = path.join(projectRoot, "src", "index.mjs");
const validSpecPath = path.join(projectRoot, "examples", "project-spec.valid.json");

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function runCli(args) {
  return execFileAsync(process.execPath, [cliEntryPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8"
  });
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

  await runTest("cli help prints installed command usage", async () => {
    const help = await runCli(["--help"]);

    assert.match(help.stdout, new RegExp(`${packageJson.name} v${packageJson.version}`));
    assert.match(help.stdout, new RegExp(`${packageJson.name} dispatch <handoffIndexPath>`));
    assert.match(help.stdout, new RegExp(`${packageJson.name} review-bundle \\[outputDir\\]`));
  });

  await runTest("cli version prints package version", async () => {
    const version = await runCli(["--version"]);

    assert.equal(version.stdout.trim(), packageJson.version);
  });

  await runTest("cli with no arguments prints help", async () => {
    const help = await runCli([]);

    assert.match(help.stdout, /Usage:/);
    assert.match(help.stdout, new RegExp(`${packageJson.name} --version`));
  });

  await runTest("cli handoff resolves prompt templates from the package when invoked outside the repo cwd", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-cli-handoff-"));
    const callerDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-cli-caller-"));
    const runResult = await runProject(validSpecPath, tempDir, "cli-handoff-run");

    const result = await execFileAsync(process.execPath, [cliEntryPath, "handoff", runResult.statePath], {
      cwd: callerDir,
      encoding: "utf8"
    });

    assert.match(result.stdout, /Handoff directory:/);
    await stat(path.join(tempDir, "cli-handoff-run", "handoffs", "planning-brief.handoff.json"));
  });

  console.log("CLI entry tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
