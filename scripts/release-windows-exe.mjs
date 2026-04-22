import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { validateZipArchiveEntryNames } from "../src/lib/zip-archive.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const npmCliPath =
  process.env.npm_execpath?.trim() ||
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const postjectCliPath = path.join(projectRoot, "node_modules", "postject", "dist", "cli.js");
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const transientSourceBackupTopLevelSegments = new Set([
  ".git",
  "node_modules",
  "release-artifacts",
  "reports",
  "review-bundles",
  "runs",
  "tmp"
]);

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

function normalizeRelativePath(relativePath) {
  return String(relativePath).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function isGeneratedReleaseRunSegment(segment) {
  return /^\d{8}-\d{6}-[0-9a-f]{7,40}$/i.test(segment);
}

function isGeneratedReleaseArtifactName(segment) {
  return (
    /^ai-factory-starter-win-(x64|arm64|x86)-[0-9a-f]{7,40}$/i.test(segment) ||
    /^ai-factory-starter-win-(x64|arm64|x86)-[0-9a-f]{7,40}\.zip$/i.test(segment)
  );
}

function isGeneratedReleaseOutputPath(normalizedPath) {
  const segments = normalizeRelativePath(normalizedPath).split("/").filter(Boolean);
  const releaseRunIndex = segments.findIndex(isGeneratedReleaseRunSegment);

  if (releaseRunIndex < 0 || releaseRunIndex === segments.length - 1) {
    return false;
  }

  const firstChildSegment = segments[releaseRunIndex + 1];
  return (
    firstChildSegment === "backups" ||
    firstChildSegment === "packages" ||
    firstChildSegment === "release-manifest.json" ||
    isGeneratedReleaseArtifactName(firstChildSegment)
  );
}

function isSiblingGeneratedReleaseOutputPath(normalizedPath, normalizedOutputPath) {
  const outputTopLevelSegment = normalizeRelativePath(normalizedOutputPath).split("/").filter(Boolean)[0];
  const pathTopLevelSegment = normalizeRelativePath(normalizedPath).split("/").filter(Boolean)[0];

  if (!outputTopLevelSegment || pathTopLevelSegment !== outputTopLevelSegment) {
    return false;
  }

  return isGeneratedReleaseOutputPath(normalizedPath);
}

function isNestedProjectPath(relativePath) {
  if (!relativePath) {
    return false;
  }

  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export function getWindowsArchitectureMetadata(arch = process.arch) {
  switch (arch) {
    case "x64":
      return {
        nodeArchitecture: "x64",
        windowsTarget: "win-x64"
      };
    case "arm64":
      return {
        nodeArchitecture: "arm64",
        windowsTarget: "win-arm64"
      };
    case "ia32":
      return {
        nodeArchitecture: "ia32",
        windowsTarget: "win-x86"
      };
    default:
      throw new Error(`Unsupported Windows architecture for release packaging: ${arch}`);
  }
}

export function createWindowsReleaseNames(shortHead, arch = process.arch) {
  const architecture = getWindowsArchitectureMetadata(arch);
  const releaseDirectoryName = `ai-factory-starter-${architecture.windowsTarget}-${shortHead}`;

  return {
    ...architecture,
    releaseDirectoryName,
    releaseArchiveFileName: `${releaseDirectoryName}.zip`
  };
}

export function shouldExcludeFromSourceBackup(relativePath, nestedOutputRelativePath = null) {
  const normalizedPath = normalizeRelativePath(relativePath);

  if (!normalizedPath || normalizedPath === ".") {
    return false;
  }

  const topLevelSegment = normalizedPath.split("/")[0];

  if (transientSourceBackupTopLevelSegments.has(topLevelSegment)) {
    return true;
  }

  if (!nestedOutputRelativePath) {
    return false;
  }

  const normalizedOutputPath = normalizeRelativePath(nestedOutputRelativePath);
  return (
    normalizedPath === normalizedOutputPath ||
    normalizedPath.startsWith(`${normalizedOutputPath}/`) ||
    isSiblingGeneratedReleaseOutputPath(normalizedPath, normalizedOutputPath)
  );
}

export async function reserveReleaseOutputRoot(baseOutputDir, releaseStamp, shortHead) {
  const resolvedBaseOutputDir = path.resolve(baseOutputDir);
  const outputRootBaseName = `${releaseStamp}-${shortHead}`;

  await ensureDirectory(resolvedBaseOutputDir);

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const candidatePath = path.join(resolvedBaseOutputDir, `${outputRootBaseName}${suffix}`);

    try {
      await mkdir(candidatePath, { recursive: false });
      return candidatePath;
    } catch (error) {
      if (error?.code === "EEXIST") {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Could not reserve a unique release output directory under ${resolvedBaseOutputDir}.`);
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

async function createGitBundle(bundlePath, repoRootPath = projectRoot) {
  await run("git", ["bundle", "create", bundlePath, "--all"], {
    cwd: repoRootPath
  });
}

export async function collectSourceBackupFiles(
  projectRootPath = projectRoot,
  outputRootPath = path.join(projectRootPath, "release-artifacts")
) {
  const resolvedProjectRoot = path.resolve(projectRootPath);
  const resolvedOutputRoot = path.resolve(outputRootPath);
  const relativeOutputPath = path.relative(resolvedProjectRoot, resolvedOutputRoot);
  const nestedOutputRelativePath = isNestedProjectPath(relativeOutputPath)
    ? normalizeRelativePath(relativeOutputPath)
    : null;
  const files = [];

  async function walkDirectory(directoryPath) {
    const entries = await readdir(directoryPath, {
      withFileTypes: true
    });

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(resolvedProjectRoot, absolutePath);

      if (shouldExcludeFromSourceBackup(relativePath, nestedOutputRelativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walkDirectory(absolutePath);
        continue;
      }

      if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: normalizeRelativePath(relativePath)
        });
      }
    }
  }

  await walkDirectory(resolvedProjectRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

export async function stageSourceBackupSnapshot(
  snapshotRoot,
  projectRootPath = projectRoot,
  outputRootPath = path.join(projectRootPath, "release-artifacts")
) {
  const resolvedSnapshotRoot = path.resolve(snapshotRoot);
  const files = await collectSourceBackupFiles(projectRootPath, outputRootPath);

  await ensureDirectory(resolvedSnapshotRoot);

  for (const file of files) {
    const destinationPath = path.join(resolvedSnapshotRoot, file.relativePath);
    await ensureDirectory(path.dirname(destinationPath));
    await copyFile(file.absolutePath, destinationPath);
  }

  return {
    snapshotRoot: resolvedSnapshotRoot,
    files
  };
}

export async function createZipArchiveFromDirectory(sourceDirectory, archivePath) {
  await removeIfExists(archivePath);

  if (process.platform !== "win32") {
    await run("zip", ["-qr", archivePath, path.basename(sourceDirectory)], {
      cwd: path.dirname(sourceDirectory),
      timeout: 300000
    });
    await validateZipArchiveEntryNames(archivePath);
    return archivePath;
  }

  try {
    await run("tar", ["-a", "-cf", archivePath, path.basename(sourceDirectory)], {
      cwd: path.dirname(sourceDirectory),
      timeout: 300000
    });
    await validateZipArchiveEntryNames(archivePath);
  } catch {
    const command = [
      `Compress-Archive -LiteralPath '${sourceDirectory.replace(/'/g, "''")}' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`
    ].join("\n");
    await run("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: path.dirname(sourceDirectory),
      timeout: 300000
    });
    await validateZipArchiveEntryNames(archivePath);
  }

  return archivePath;
}

export function createReleaseManifestPayload({
  generatedAt = new Date().toISOString(),
  branch,
  commit,
  backupOnly = false,
  backupArtifacts,
  packageVersion = null,
  packageArtifacts = null,
  releaseArtifacts = null
}) {
  const payload = {
    generatedAt,
    branch,
    commit,
    backupOnly,
    backupArtifacts
  };

  if (packageVersion) {
    payload.packageVersion = packageVersion;
  }

  if (packageArtifacts) {
    payload.packageArtifacts = packageArtifacts;
  }

  if (releaseArtifacts) {
    Object.assign(payload, releaseArtifacts);
  }

  return payload;
}

export async function createBackups(
  outputRoot,
  releaseStamp,
  shortHead,
  {
    projectRootPath = projectRoot,
    gitBundleCreator = createGitBundle
  } = {}
) {
  const resolvedProjectRoot = path.resolve(projectRootPath);
  const backupsDirectory = path.join(outputRoot, "backups");
  const bundlePath = path.join(backupsDirectory, `ai-factory-starter-${releaseStamp}-${shortHead}.git.bundle`);
  const sourceZipPath = path.join(backupsDirectory, `ai-factory-starter-${releaseStamp}-${shortHead}-source.zip`);

  await ensureDirectory(backupsDirectory);
  await removeIfExists(bundlePath);
  await removeIfExists(sourceZipPath);

  await gitBundleCreator(bundlePath, resolvedProjectRoot);
  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-factory-source-backup-"));
  const snapshotDirectory = path.join(stagingDirectory, `ai-factory-starter-${releaseStamp}-${shortHead}-source`);
  try {
    await stageSourceBackupSnapshot(snapshotDirectory, resolvedProjectRoot, outputRoot);
    await createZipArchiveFromDirectory(snapshotDirectory, sourceZipPath);
  } finally {
    await removeIfExists(stagingDirectory);
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

async function createReleaseArchive(releaseDirectory, archivePath) {
  return createZipArchiveFromDirectory(releaseDirectory, archivePath);
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
  const windowsReleaseNames = createWindowsReleaseNames(head);
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const outputRoot = await reserveReleaseOutputRoot(options.outputDir, releaseStamp, head);

  const backupArtifacts = await createBackups(outputRoot, releaseStamp, head);

  if (options.backupOnly) {
    const manifestPath = await writeManifest(
      outputRoot,
      createReleaseManifestPayload({
        branch,
        commit: head,
        backupOnly: true,
        backupArtifacts
      })
    );

    console.log(`Backup bundle: ${backupArtifacts.bundlePath}`);
    console.log(`Source ZIP: ${backupArtifacts.sourceZipPath}`);
    console.log(`Release manifest: ${manifestPath}`);
    return;
  }

  const packageArtifacts = await createPackageTarball(outputRoot);
  const releaseDirectory = path.join(outputRoot, windowsReleaseNames.releaseDirectoryName);
  const releaseArchivePath = path.join(outputRoot, windowsReleaseNames.releaseArchiveFileName);

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
  await createReleaseArchive(releaseDirectory, releaseArchivePath);
  const manifestPath = await writeManifest(
    outputRoot,
    createReleaseManifestPayload({
      branch,
      commit: head,
      backupArtifacts,
      packageVersion: packageJson.version,
      packageArtifacts,
      releaseArtifacts: {
        nodeArchitecture: windowsReleaseNames.nodeArchitecture,
        windowsTarget: windowsReleaseNames.windowsTarget,
        releaseDirectoryName: windowsReleaseNames.releaseDirectoryName,
        releaseArchiveFileName: windowsReleaseNames.releaseArchiveFileName,
        releaseDirectory,
        releaseArchivePath,
        executablePath,
        appDirectory
      }
    })
  );

  console.log(`Backup bundle: ${backupArtifacts.bundlePath}`);
  console.log(`Source ZIP: ${backupArtifacts.sourceZipPath}`);
  console.log(`Package tarball: ${packageArtifacts.tarballPath}`);
  console.log(`Windows release directory: ${releaseDirectory}`);
  console.log(`Windows exe: ${executablePath}`);
  console.log(`Windows release ZIP: ${releaseArchivePath}`);
  console.log(`Release manifest: ${manifestPath}`);
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
