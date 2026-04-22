import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateZipArchiveEntryNames } from "../src/lib/zip-archive.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zipLocalFileHeaderSignature = 0x04034b50;
const zipCentralDirectorySignature = 0x02014b50;
const zipEndOfCentralDirectorySignature = 0x06054b50;
const crc32Table = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

function compactTimestamp(timestamp = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    timestamp.getFullYear(),
    pad(timestamp.getMonth() + 1),
    pad(timestamp.getDate())
  ].join("") + "-" + [
    pad(timestamp.getHours()),
    pad(timestamp.getMinutes()),
    pad(timestamp.getSeconds())
  ].join("");
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
  return targetPath;
}

async function readJson(targetPath) {
  return JSON.parse((await readFile(targetPath, "utf8")).replace(/^\uFEFF/, ""));
}

function normalizePosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function computeCrc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

async function findLatestReviewBundleDirectory(rootDirectory) {
  const entries = await readdir(rootDirectory, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("review-bundle-")) {
      continue;
    }

    const fullPath = path.join(rootDirectory, entry.name);
    const entryStats = await stat(fullPath);
    candidates.push({
      fullPath,
      mtimeMs: entryStats.mtimeMs
    });
  }

  invariant(candidates.length > 0, `No review-bundle-* directory found under ${rootDirectory}`);

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].fullPath;
}

async function createZipArchive(bundleDirectory, archivePath) {
  const files = [];
  const resolvedBundleDirectory = path.resolve(bundleDirectory);
  const entryRoot = path.basename(resolvedBundleDirectory);

  async function walk(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      files.push({
        absolutePath,
        entryName: `${entryRoot}/${normalizePosixPath(path.relative(resolvedBundleDirectory, absolutePath))}`
      });
    }
  }

  await walk(resolvedBundleDirectory);

  const localSections = [];
  const centralDirectorySections = [];
  let localOffset = 0;

  for (const file of files) {
    const fileNameBuffer = Buffer.from(file.entryName, "utf8");
    const contentBuffer = await readFile(file.absolutePath);
    const crc32 = computeCrc32(contentBuffer);
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(zipLocalFileHeaderSignature, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(contentBuffer.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(fileNameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localSections.push(localHeader, fileNameBuffer, contentBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(zipCentralDirectorySignature, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc32, 16);
    centralHeader.writeUInt32LE(contentBuffer.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(fileNameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralDirectorySections.push(centralHeader, fileNameBuffer);
    localOffset += localHeader.length + fileNameBuffer.length + contentBuffer.length;
  }

  const centralDirectoryBuffer = Buffer.concat(centralDirectorySections);
  const endOfCentralDirectory = Buffer.alloc(22);

  endOfCentralDirectory.writeUInt32LE(zipEndOfCentralDirectorySignature, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(files.length, 8);
  endOfCentralDirectory.writeUInt16LE(files.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryBuffer.length, 12);
  endOfCentralDirectory.writeUInt32LE(localOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  await writeFile(
    archivePath,
    Buffer.concat([...localSections, centralDirectoryBuffer, endOfCentralDirectory])
  );
  await validateZipArchiveEntryNames(archivePath);
}

function renderPackageReadme({
  bundleName,
  commit,
  acceptanceSummaryPath,
  archiveFileName
}) {
  return [
    "# GPT Review Share Package",
    "",
    `- Bundle: ${bundleName}`,
    `- Commit: ${commit ?? "unknown"}`,
    `- Package archive: ${archiveFileName ?? "(directory only)"}`,
    `- Acceptance summary: ${acceptanceSummaryPath}`,
    "",
    "This package is intentionally assembled from one snapshot only.",
    "",
    "Included:",
    "- `bundle/` metadata from the same generated review bundle",
    "- the exact review bundle zip",
    "- the matching acceptance summary json/md",
    "- a share-manifest.json that records the source paths",
    "",
    "Use the included prompt together with the included zip."
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    bundleDir: null,
    acceptanceSummaryPath: null,
    outputDir: path.join(projectRoot, "review-bundles"),
    packageName: null,
    archive: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = argv[index + 1];

    switch (arg) {
      case "--bundle-dir":
        options.bundleDir = path.resolve(nextValue);
        index += 1;
        break;
      case "--acceptance-summary":
        options.acceptanceSummaryPath = path.resolve(nextValue);
        index += 1;
        break;
      case "--output-dir":
        options.outputDir = path.resolve(nextValue);
        index += 1;
        break;
      case "--package-name":
        options.packageName = nextValue;
        index += 1;
        break;
      case "--no-archive":
        options.archive = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export async function createReviewSharePackage({
  bundleDir = null,
  acceptanceSummaryPath = null,
  outputDir = path.join(projectRoot, "review-bundles"),
  packageName = null,
  archive = true
} = {}) {
  const resolvedBundleDir =
    bundleDir !== null ? path.resolve(bundleDir) : await findLatestReviewBundleDirectory(outputDir);
  invariant(
    typeof acceptanceSummaryPath === "string" && acceptanceSummaryPath.trim().length > 0,
    [
      "Acceptance summary must be provided explicitly for review-share-package.",
      "Use --acceptance-summary <path-to-acceptance-summary.json> so the share package cannot mix unrelated snapshots."
    ].join("\n")
  );
  const resolvedAcceptanceSummaryPath = path.resolve(acceptanceSummaryPath);
  const bundleBaseName = path.basename(resolvedBundleDir);
  const bundleZipPath = `${resolvedBundleDir}.zip`;
  const bundleMetadataDir = path.join(resolvedBundleDir, "metadata");
  const bundleManifestPath = path.join(bundleMetadataDir, "bundle-manifest.json");
  const reviewPromptPath = path.join(bundleMetadataDir, "external-ai-review-prompt.md");
  const reviewBriefPath = path.join(bundleMetadataDir, "external-ai-review-brief.md");
  const validationResultsPath = path.join(bundleMetadataDir, "validation-results.json");
  const acceptanceSummaryMarkdownPath = resolvedAcceptanceSummaryPath.replace(/\.json$/i, ".md");

  invariant(await fileExists(resolvedBundleDir), `Review bundle directory does not exist: ${resolvedBundleDir}`);
  invariant(await fileExists(bundleZipPath), `Review bundle archive does not exist: ${bundleZipPath}`);
  invariant(await fileExists(bundleManifestPath), `Review bundle manifest does not exist: ${bundleManifestPath}`);
  invariant(await fileExists(reviewPromptPath), `Review prompt does not exist: ${reviewPromptPath}`);
  invariant(await fileExists(reviewBriefPath), `Review brief does not exist: ${reviewBriefPath}`);
  invariant(
    await fileExists(resolvedAcceptanceSummaryPath),
    `Acceptance summary does not exist: ${resolvedAcceptanceSummaryPath}`
  );

  const manifest = await readJson(bundleManifestPath);
  const effectivePackageName =
    packageName ?? `gpt-review-share-${compactTimestamp()}-${manifest.git?.shortHead ?? bundleBaseName}`;
  const packageDirectory = path.join(outputDir, effectivePackageName);
  const archivePath = `${packageDirectory}.zip`;
  const metadataOutputDir = path.join(packageDirectory, "bundle");
  const acceptanceOutputDir = path.join(packageDirectory, "acceptance");
  const bundleZipOutputPath = path.join(packageDirectory, path.basename(bundleZipPath));
  const shareManifestPath = path.join(packageDirectory, "share-manifest.json");
  const readmePath = path.join(packageDirectory, "README.md");

  await rm(packageDirectory, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await ensureDirectory(metadataOutputDir);
  await ensureDirectory(acceptanceOutputDir);

  await Promise.all([
    copyFile(bundleManifestPath, path.join(metadataOutputDir, "bundle-manifest.json")),
    copyFile(reviewPromptPath, path.join(metadataOutputDir, "external-ai-review-prompt.md")),
    copyFile(reviewBriefPath, path.join(metadataOutputDir, "external-ai-review-brief.md")),
    copyFile(validationResultsPath, path.join(metadataOutputDir, "validation-results.json")).catch(() => undefined),
    copyFile(resolvedAcceptanceSummaryPath, path.join(acceptanceOutputDir, "acceptance-summary.json")),
    copyFile(bundleZipPath, bundleZipOutputPath)
  ]);

  if (await fileExists(acceptanceSummaryMarkdownPath)) {
    await copyFile(acceptanceSummaryMarkdownPath, path.join(acceptanceOutputDir, "acceptance-summary.md"));
  }

  const shareManifest = {
    generatedAt: new Date().toISOString(),
    bundleName: manifest.bundleName ?? bundleBaseName,
    commit: manifest.git?.head ?? null,
    shortCommit: manifest.git?.shortHead ?? null,
    cleanWorktreeAtBundleTime: manifest.git?.clean ?? null,
    sourcePaths: {
      bundleDirectory: normalizePosixPath(resolvedBundleDir),
      bundleZipPath: normalizePosixPath(bundleZipPath),
      acceptanceSummaryPath: normalizePosixPath(resolvedAcceptanceSummaryPath),
      acceptanceSummaryMarkdownPath: (await fileExists(acceptanceSummaryMarkdownPath))
        ? normalizePosixPath(acceptanceSummaryMarkdownPath)
        : null
    },
    includedFiles: {
      bundleZip: path.basename(bundleZipOutputPath),
      bundleManifest: "bundle/bundle-manifest.json",
      reviewPrompt: "bundle/external-ai-review-prompt.md",
      reviewBrief: "bundle/external-ai-review-brief.md",
      validationResults: (await fileExists(path.join(metadataOutputDir, "validation-results.json")))
        ? "bundle/validation-results.json"
        : null,
      acceptanceSummary: "acceptance/acceptance-summary.json",
      acceptanceSummaryMarkdown: (await fileExists(path.join(acceptanceOutputDir, "acceptance-summary.md")))
        ? "acceptance/acceptance-summary.md"
        : null
    },
    notes: [
      "This share package intentionally groups bundle metadata and acceptance evidence from one snapshot.",
      "Use the included prompt together with the included review bundle zip."
    ]
  };

  await writeFile(shareManifestPath, `${JSON.stringify(shareManifest, null, 2)}\n`, "utf8");
  await writeFile(
    readmePath,
    `${renderPackageReadme({
      bundleName: shareManifest.bundleName,
      commit: shareManifest.shortCommit ?? shareManifest.commit,
      acceptanceSummaryPath: shareManifest.includedFiles.acceptanceSummary,
      archiveFileName: path.basename(archivePath)
    })}\n`,
    "utf8"
  );

  if (archive) {
    await createZipArchive(packageDirectory, archivePath);
  }

  return {
    packageDirectory,
    archivePath: archive ? archivePath : null,
    shareManifestPath,
    bundleZipOutputPath,
    acceptanceSummaryOutputPath: path.join(acceptanceOutputDir, "acceptance-summary.json")
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await createReviewSharePackage(options);
  console.log(`Review share directory: ${result.packageDirectory}`);
  console.log(`Review share manifest: ${result.shareManifestPath}`);
  if (result.archivePath) {
    console.log(`Review share archive: ${result.archivePath}`);
  }
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
