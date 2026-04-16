import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCliCandidates = [
  process.env.npm_execpath,
  path.resolve(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
const npmCliPath = npmCliCandidates.find((candidate) => existsSync(candidate));
const npmRunner = npmCliPath
  ? {
      command: process.execPath,
      fixedArgs: [npmCliPath]
    }
  : {
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      fixedArgs: []
    };

async function runCommand(command, args, cwd) {
  return execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function runNpm(args, cwd) {
  return runCommand(npmRunner.command, [...npmRunner.fixedArgs, ...args], cwd);
}

async function runInstalledBinary(packageName, args, cwd) {
  return runNpm(["exec", "--", packageName, ...args], cwd);
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-pack-"));

  try {
    const packDirectory = path.join(tempRoot, "pack");
    const installDirectory = path.join(tempRoot, "install");
    const workspaceDirectory = path.join(tempRoot, "workspace");

    await mkdir(packDirectory, { recursive: true });
    await mkdir(installDirectory, { recursive: true });

    const { stdout } = await runNpm(
      ["pack", "--json", "--pack-destination", packDirectory],
      projectRoot
    );
    const [packResult] = JSON.parse(stdout);
    const packagedPaths = new Set(packResult.files.map((file) => file.path));

    assert.equal(packResult.name, packageJson.name);
    assert.equal(packResult.version, packageJson.version);
    assert.ok(packagedPaths.has("src/index.mjs"));
    assert.ok(packagedPaths.has("config/factory.config.json"));
    assert.ok(packagedPaths.has("prompts/executor.md"));
    assert.ok(packagedPaths.has("examples/project-spec.valid.json"));
    assert.ok(![...packagedPaths].some((file) => file.startsWith(".github/")));
    assert.ok(![...packagedPaths].some((file) => file.startsWith("reports/")));
    assert.ok(![...packagedPaths].some((file) => file.startsWith("runs/")));
    assert.ok(![...packagedPaths].some((file) => file.startsWith("scripts/")));
    assert.ok(![...packagedPaths].some((file) => file.startsWith("tests/")));

    const tarballPath = path.join(packDirectory, packResult.filename);
    await stat(tarballPath);

    await runNpm(["init", "-y"], installDirectory);
    await runNpm(["install", tarballPath], installDirectory);

    const installedPackageDir = path.join(installDirectory, "node_modules", packageJson.name);
    const installedBinPath = path.join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? `${packageJson.name}.cmd` : packageJson.name
    );

    await stat(path.join(installedPackageDir, "package.json"));
    await stat(installedBinPath);

    const versionResult = await runInstalledBinary(packageJson.name, ["--version"], installDirectory);
    assert.equal(versionResult.stdout.trim(), packageJson.version);

    const helpResult = await runInstalledBinary(packageJson.name, ["--help"], installDirectory);
    assert.match(helpResult.stdout, new RegExp(`${packageJson.name} v${packageJson.version}`));
    assert.match(helpResult.stdout, new RegExp(`${packageJson.name} init \\[targetDir\\]`));

    await runInstalledBinary(packageJson.name, ["init", workspaceDirectory], installDirectory);
    await stat(path.join(workspaceDirectory, "specs", "project-spec.json"));
    await stat(path.join(workspaceDirectory, "config", "factory.config.json"));

    const validateResult = await runInstalledBinary(
      packageJson.name,
      ["validate", path.join(workspaceDirectory, "specs", "project-spec.json")],
      installDirectory
    );
    assert.match(validateResult.stdout, /Spec validation passed\./);

    console.log(`Pack check passed: ${packageJson.name}@${packageJson.version}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
