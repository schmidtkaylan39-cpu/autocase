import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const npmCliPath =
  process.env.npm_execpath?.trim() ||
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const postjectCliPath = path.join(projectRoot, "node_modules", "postject", "dist", "cli.js");
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function compactTimestamp(timestamp = new Date()) {
  const iso = timestamp.toISOString();
  const [datePart, timePart] = iso.split("T");
  return `${datePart.replace(/-/g, "")}-${(timePart ?? "000000").replace(/[:.Z]/g, "").slice(0, 6)}`;
}

function parseArgs(argv) {
  const options = {
    backupOnly: false,
    outputDir: path.join(projectRoot, "release-artifacts")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--backup-only") {
      options.backupOnly = true;
      continue;
    }

    if (arg === "--output-dir") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --output-dir.");
      }

      options.outputDir = path.resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout ?? 300000
  });
}

async function runNpm(args, options = {}) {
  return run(process.execPath, [npmCliPath, ...args], options);
}

async function runPostject(args, options = {}) {
  return run(process.execPath, [postjectCliPath, ...args], options);
}

async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
}

async function removeIfExists(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
}

async function createBackups(outputRoot, releaseStamp, shortHead) {
  const backupsDirectory = path.join(outputRoot, "backups");
  const bundlePath = path.join(backupsDirectory, `ai-factory-starter-${releaseStamp}-${shortHead}.git.bundle`);
  const sourceZipPath = path.join(backupsDirectory, `ai-factory-starter-${releaseStamp}-${shortHead}-source.zip`);

  await ensureDirectory(backupsDirectory);
  await removeIfExists(bundlePath);
  await removeIfExists(sourceZipPath);

  await run("git", ["bundle", "create", bundlePath, "--all"]);

  const outputRootRelative = path.relative(projectRoot, outputRoot);
  const excludeArgs = [
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=release-artifacts"
  ];

  if (outputRootRelative && !outputRootRelative.startsWith("..")) {
    excludeArgs.push(`--exclude=${outputRootRelative.replace(/\\/g, "/")}`);
  }

  try {
    await run("tar", ["-a", "-cf", sourceZipPath, ...excludeArgs, "."], {
      cwd: projectRoot,
      timeout: 300000
    });
  } catch {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `$destination = '${sourceZipPath.replace(/'/g, "''")}'`,
      `if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }`,
      `Compress-Archive -Path '${projectRoot.replace(/'/g, "''")}\\*' -DestinationPath $destination -Force`
    ].join("\n");
    await run("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: projectRoot,
      timeout: 300000
    });
  }

  return {
    backupsDirectory,
    bundlePath,
    sourceZipPath
  };
}

async function createPackageTarball(outputRoot) {
  const packagesDirectory = path.join(outputRoot, "packages");
  await ensureDirectory(packagesDirectory);

  const { stdout } = await runNpm(["pack", "--json", "--pack-destination", packagesDirectory], {
    timeout: 300000
  });
  const records = JSON.parse(stdout);
  const packageRecord = Array.isArray(records) ? records[0] : null;

  if (!packageRecord?.filename) {
    throw new Error("npm pack did not return a package filename.");
  }

  return {
    packagesDirectory,
    tarballPath: path.join(packagesDirectory, packageRecord.filename),
    tarballFileName: packageRecord.filename
  };
}

async function extractPackageTarball(tarballPath, releaseDirectory) {
  const extractionDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-factory-release-"));

  try {
    await run("tar", ["-xzf", tarballPath, "-C", extractionDirectory], {
      timeout: 300000
    });

    const extractedPackageDirectory = path.join(extractionDirectory, "package");
    const appDirectory = path.join(releaseDirectory, "app");

    await removeIfExists(appDirectory);
    await rename(extractedPackageDirectory, appDirectory);

    return appDirectory;
  } finally {
    const extractedPackageDirectory = path.join(extractionDirectory, "package");

    try {
      await stat(extractedPackageDirectory);
      await removeIfExists(extractionDirectory);
    } catch {
      await removeIfExists(extractionDirectory);
    }
  }
}

function renderSeaLauncher() {
  return [
    "const path = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    "",
    "const appRoot = path.join(path.dirname(process.execPath), 'app');",
    "const entryUrl = pathToFileURL(path.join(appRoot, 'src', 'index.mjs')).href;",
    "",
    "import(entryUrl).catch((error) => {",
    "  console.error(error instanceof Error ? error.stack : String(error));",
    "  process.exitCode = 1;",
    "});",
    ""
  ].join("\n");
}

function renderReleaseReadme(packageVersion, shortHead) {
  return [
    "AI Factory Starter Windows Release",
    "",
    `Version: ${packageVersion}`,
    `Commit: ${shortHead}`,
    "",
    "Files:",
    "- ai-factory-starter.exe",
    "- app/",
    "",
    "Usage examples:",
    "  .\\ai-factory-starter.exe --help",
    "  .\\ai-factory-starter.exe --version",
    "  .\\ai-factory-starter.exe init demo-workspace",
    "",
    "Keep the exe and app directory together."
  ].join("\r\n");
}

async function maybeRemoveWindowsSignature(executablePath) {
  try {
    await run("signtool", ["remove", "/s", executablePath], {
      timeout: 120000
    });
  } catch {
    // Skip if signtool is unavailable or the binary is unsigned.
  }
}

async function buildWindowsExe(releaseDirectory) {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-factory-sea-"));
  const seaLauncherPath = path.join(tempDirectory, "sea-launcher.cjs");
  const seaConfigPath = path.join(tempDirectory, "sea-config.json");
  const seaBlobPath = path.join(tempDirectory, "sea-prep.blob");
  const executablePath = path.join(releaseDirectory, "ai-factory-starter.exe");

  try {
    await writeFile(seaLauncherPath, renderSeaLauncher(), "utf8");
    await writeFile(
      seaConfigPath,
      `${JSON.stringify(
        {
          main: seaLauncherPath,
          output: seaBlobPath,
          disableExperimentalSEAWarning: true,
          useSnapshot: false,
          useCodeCache: false
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await run(process.execPath, ["--experimental-sea-config", seaConfigPath], {
      timeout: 300000
    });
    await copyFile(process.execPath, executablePath);
    await maybeRemoveWindowsSignature(executablePath);
    await runPostject(
      [
        executablePath,
        "NODE_SEA_BLOB",
        seaBlobPath,
        "--sentinel-fuse",
        sentinelFuse
      ],
      {
        timeout: 300000
      }
    );

    return executablePath;
  } finally {
    await removeIfExists(tempDirectory);
  }
}

async function createReleaseArchive(outputRoot, releaseDirectory) {
  const archivePath = `${releaseDirectory}.zip`;
  await removeIfExists(archivePath);

  try {
    await run("tar", ["-a", "-cf", path.basename(archivePath), path.basename(releaseDirectory)], {
      cwd: outputRoot,
      timeout: 300000
    });
  } catch {
    const command = [
      `Compress-Archive -LiteralPath '${releaseDirectory.replace(/'/g, "''")}' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`
    ].join("\n");
    await run("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: outputRoot,
      timeout: 300000
    });
  }

  return archivePath;
}

async function verifyWindowsExe(executablePath, releaseDirectory) {
  const { stdout: helpOutput } = await run(executablePath, ["--help"], {
    cwd: releaseDirectory,
    timeout: 120000
  });

  if (!/Usage:/i.test(helpOutput)) {
    throw new Error("The built exe did not print help output.");
  }

  const { stdout: versionOutput } = await run(executablePath, ["--version"], {
    cwd: releaseDirectory,
    timeout: 120000
  });

  if (!versionOutput.trim()) {
    throw new Error("The built exe did not print a version.");
  }

  const initWorkspace = path.join(releaseDirectory, "exe-smoke-workspace");
  await removeIfExists(initWorkspace);
  try {
    await run(executablePath, ["init", initWorkspace], {
      cwd: releaseDirectory,
      timeout: 120000
    });
    await stat(path.join(initWorkspace, "config", "factory.config.json"));
    await stat(path.join(initWorkspace, "AGENTS.md"));

    const validateSpecPath = path.join(releaseDirectory, "app", "examples", "project-spec.valid.json");
    const { stdout: validateOutput } = await run(executablePath, ["validate", validateSpecPath], {
      cwd: releaseDirectory,
      timeout: 120000
    });

    if (!/Spec validation passed/i.test(validateOutput)) {
      throw new Error("The built exe could not validate the packaged example spec.");
    }
  } finally {
    await removeIfExists(initWorkspace);
  }
}

async function writeManifest(outputRoot, payload) {
  const manifestPath = path.join(outputRoot, "release-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return manifestPath;
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("release-windows-exe.mjs only supports Windows builds.");
  }

  const options = parseArgs(process.argv.slice(2));
  const releaseStamp = compactTimestamp();
  const { stdout: headStdout } = await run("git", ["rev-parse", "--short", "HEAD"]);
  const { stdout: branchStdout } = await run("git", ["branch", "--show-current"]);
  const head = headStdout.trim();
  const branch = branchStdout.trim() || "detached-head";
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const outputRoot = path.join(options.outputDir, `${releaseStamp}-${head}`);

  await ensureDirectory(outputRoot);

  const backupArtifacts = await createBackups(outputRoot, releaseStamp, head);

  if (options.backupOnly) {
    const manifestPath = await writeManifest(outputRoot, {
      generatedAt: new Date().toISOString(),
      branch,
      commit: head,
      backupOnly: true,
      backupArtifacts
    });

    console.log(`Backup bundle: ${backupArtifacts.bundlePath}`);
    console.log(`Source ZIP: ${backupArtifacts.sourceZipPath}`);
    console.log(`Release manifest: ${manifestPath}`);
    return;
  }

  const packageArtifacts = await createPackageTarball(outputRoot);
  const releaseDirectory = path.join(outputRoot, `ai-factory-starter-win-x64-${head}`);

  await removeIfExists(releaseDirectory);
  await ensureDirectory(releaseDirectory);

  const appDirectory = await extractPackageTarball(packageArtifacts.tarballPath, releaseDirectory);
  const executablePath = await buildWindowsExe(releaseDirectory);
  await writeFile(
    path.join(releaseDirectory, "README.txt"),
    renderReleaseReadme(packageJson.version, head),
    "utf8"
  );
  await verifyWindowsExe(executablePath, releaseDirectory);
  const releaseArchivePath = await createReleaseArchive(outputRoot, releaseDirectory);
  const manifestPath = await writeManifest(outputRoot, {
    generatedAt: new Date().toISOString(),
    branch,
    commit: head,
    packageVersion: packageJson.version,
    backupArtifacts,
    packageArtifacts,
    releaseDirectory,
    releaseArchivePath,
    executablePath,
    appDirectory
  });

  console.log(`Backup bundle: ${backupArtifacts.bundlePath}`);
  console.log(`Source ZIP: ${backupArtifacts.sourceZipPath}`);
  console.log(`Package tarball: ${packageArtifacts.tarballPath}`);
  console.log(`Windows release directory: ${releaseDirectory}`);
  console.log(`Windows exe: ${executablePath}`);
  console.log(`Windows release ZIP: ${releaseArchivePath}`);
  console.log(`Release manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
