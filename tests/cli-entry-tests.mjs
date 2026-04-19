import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

async function runCli(args, cwd = projectRoot) {
  return execFileAsync(process.execPath, [cliEntryPath, ...args], {
    cwd,
    encoding: "utf8"
  });
}

async function runOptionalCommand(command, args, cwd) {
  try {
    await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

  await runTest("cli help prints installed command usage", async () => {
    const help = await runCli(["--help"]);

    assert.match(help.stdout, new RegExp(`${packageJson.name} v${packageJson.version}`));
    assert.match(help.stdout, new RegExp(`${packageJson.name} intake <request>`));
    assert.match(help.stdout, new RegExp(`${packageJson.name} confirm \\[workspaceDir\\]`));
    assert.match(help.stdout, new RegExp(`${packageJson.name} revise \\[request\\] \\[workspaceDir\\]`));
    assert.match(help.stdout, new RegExp(`${packageJson.name} dispatch <handoffIndexPath>`));
    assert.match(help.stdout, new RegExp(`${packageJson.name} autonomous <runStatePath>`));
    assert.match(help.stdout, new RegExp(`${packageJson.name} panel \\[workspaceDir\\] \\[port\\]`));
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

  await runTest("cli handoff resolves relative output directories from the run directory when invoked outside the repo cwd", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-cli-handoff-relative-"));
    const callerDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-cli-handoff-relative-caller-"));
    const runResult = await runProject(validSpecPath, tempDir, "cli-handoff-relative-run");

    const result = await execFileAsync(
      process.execPath,
      [cliEntryPath, "handoff", runResult.statePath, "relative-handoffs"],
      {
        cwd: callerDir,
        encoding: "utf8"
      }
    );

    assert.match(result.stdout, /Handoff directory:/);
    await stat(path.join(tempDir, "cli-handoff-relative-run", "relative-handoffs", "planning-brief.handoff.json"));
    await assert.rejects(
      () => stat(path.join(callerDir, "relative-handoffs", "planning-brief.handoff.json"))
    );
  });

  await runTest("cli review-bundle parses --no-archive even when the flag appears before positional args", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-cli-review-source-"));
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-cli-review-output-"));

    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({ name: "cli-review-fixture", version: "0.0.1" }, null, 2),
      "utf8"
    );
    await writeFile(path.join(sourceDir, "README.md"), "# CLI Review Fixture\n", "utf8");
    await writeFile(path.join(sourceDir, "src", "index.mjs"), "export const fixture = true;\n", "utf8");

    const result = await runCli(["review-bundle", "--no-archive", outputDir, "cli-no-archive"], sourceDir);
    const outputEntries = await readdir(outputDir);

    assert.match(result.stdout, /Archive: directory only/);
    assert.ok(outputEntries.includes("cli-no-archive"));
    assert.ok(!outputEntries.includes("--no-archive"));
    await stat(path.join(outputDir, "cli-no-archive", "metadata", "bundle-manifest.json"));
  });

  await runTest("cli review-bundle rejects dirty worktrees by default and accepts --allow-dirty", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-cli-review-dirty-source-"));
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-cli-review-dirty-output-"));

    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({ name: "cli-review-dirty-fixture", version: "0.0.2" }, null, 2),
      "utf8"
    );
    await writeFile(path.join(sourceDir, "README.md"), "# CLI Review Dirty Fixture\n", "utf8");
    await writeFile(path.join(sourceDir, "src", "index.mjs"), "export const dirtyFixture = true;\n", "utf8");

    const gitAvailable = await runOptionalCommand("git", ["--version"], sourceDir);
    const gitInitialized = gitAvailable && (await runOptionalCommand("git", ["init"], sourceDir));

    if (!gitInitialized) {
      return;
    }

    await writeFile(path.join(sourceDir, "dirty-note.txt"), "dirty snapshot fixture\n", "utf8");

    await assert.rejects(
      () => runCli(["review-bundle", outputDir, "cli-dirty-default"], sourceDir),
      /dirty worktree snapshot/i
    );
    await assert.rejects(() => stat(path.join(outputDir, "cli-dirty-default")));

    const result = await runCli(
      ["review-bundle", "--allow-dirty", outputDir, "cli-dirty-allow"],
      sourceDir
    );
    const outputEntries = await readdir(outputDir);
    const manifest = JSON.parse(
      await readFile(path.join(outputDir, "cli-dirty-allow", "metadata", "bundle-manifest.json"), "utf8")
    );

    assert.match(result.stdout, /Review bundle directory:/);
    assert.ok(outputEntries.includes("cli-dirty-allow"));
    assert.ok(!outputEntries.includes("--allow-dirty"));
    assert.equal(manifest.provenance?.dirtySnapshot, true);
    assert.equal(manifest.provenance?.dirtySnapshotAllowed, true);
  });

  await runTest("cli intake creates clarification artifacts and prints the next step", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-cli-intake-"));
    const result = await runCli(["intake", "幫我把報表自動化", workspaceRoot]);
    const intakeSpecPath = path.join(workspaceRoot, "artifacts", "clarification", "intake-spec.json");
    const intakeSummaryPath = path.join(workspaceRoot, "artifacts", "clarification", "intake-summary.md");

    assert.match(result.stdout, /Clarification workspace:/);
    assert.match(result.stdout, /clarificationStatus/);
    await stat(intakeSpecPath);
    await stat(intakeSummaryPath);

    const intakeSpec = JSON.parse(await readFile(intakeSpecPath, "utf8"));
    assert.equal(intakeSpec.confirmedByUser, false);
  });

  console.log("CLI entry tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
