import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntryPath = path.join(projectRoot, "src", "index.mjs");

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

  console.log("CLI entry tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
