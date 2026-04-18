import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultExternalReviewerRerunChecks = [
  "npm ci",
  "npm test",
  "npm run validate:workflows",
  "npm run pack:check"
];

function parseAssetArgument(value) {
  const separator = "::";
  const separatorIndex = value.indexOf(separator);

  if (separatorIndex <= 0 || separatorIndex === value.length - separator.length) {
    throw new Error(
      'Asset entries must use the "<localPath>::<downloadUrl>" format.'
    );
  }

  return {
    filePath: path.resolve(value.slice(0, separatorIndex)),
    downloadUrl: value.slice(separatorIndex + separator.length).trim()
  };
}

export function parseArgs(argv) {
  const options = {
    tag: null,
    releaseUrl: null,
    publishedAt: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    releaseManifestPath: null,
    validationResultsPath: path.join(projectRoot, "reports", "validation-results.json"),
    releaseNotesPath: null,
    outputPath: null,
    externalReviewerSummary: null,
    externalReviewerChecks: [],
    assetEntries: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    switch (arg) {
      case "--tag":
        options.tag = value;
        index += 1;
        break;
      case "--release-url":
        options.releaseUrl = value;
        index += 1;
        break;
      case "--published-at":
        options.publishedAt = value;
        index += 1;
        break;
      case "--timezone":
        options.timezone = value;
        index += 1;
        break;
      case "--release-manifest":
        options.releaseManifestPath = path.resolve(value);
        index += 1;
        break;
      case "--validation-results":
        options.validationResultsPath = path.resolve(value);
        index += 1;
        break;
      case "--release-notes":
        options.releaseNotesPath = path.resolve(value);
        index += 1;
        break;
      case "--external-reviewer-summary":
        options.externalReviewerSummary = value;
        index += 1;
        break;
      case "--external-reviewer-check":
        options.externalReviewerChecks.push(value);
        index += 1;
        break;
      case "--output":
        options.outputPath = path.resolve(value);
        index += 1;
        break;
      case "--asset":
        options.assetEntries.push(parseAssetArgument(value));
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.tag) {
    throw new Error("Missing required --tag value.");
  }

  if (!options.releaseUrl) {
    throw new Error("Missing required --release-url value.");
  }

  if (!options.publishedAt) {
    throw new Error("Missing required --published-at value.");
  }

  if (!options.releaseManifestPath) {
    throw new Error("Missing required --release-manifest value.");
  }

  if (options.assetEntries.length === 0) {
    throw new Error("Provide at least one --asset entry.");
  }

  options.releaseNotesPath ??= path.join(projectRoot, "docs", "releases", `${options.tag}.md`);
  options.outputPath ??= path.join(projectRoot, "docs", "releases", `${options.tag}.evidence.json`);

  return options;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function tryNormalizeProjectRelativePath(filePath) {
  const relativePath = path.relative(projectRoot, path.resolve(filePath));

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return relativePath.split(path.sep).join("/");
}

function describeArtifactPath(filePath) {
  const normalizedProjectPath = tryNormalizeProjectRelativePath(filePath);

  if (normalizedProjectPath) {
    return normalizedProjectPath;
  }

  const resolvedPath = path.resolve(filePath);
  const desktopRoot = path.join(os.homedir(), "Desktop");
  const desktopRelativePath = path.relative(desktopRoot, resolvedPath);

  if (!desktopRelativePath.startsWith("..") && !path.isAbsolute(desktopRelativePath)) {
    return path.posix.join("desktop", desktopRelativePath.split(path.sep).join("/"));
  }

  const homeRelativePath = path.relative(os.homedir(), resolvedPath);

  if (!homeRelativePath.startsWith("..") && !path.isAbsolute(homeRelativePath)) {
    return path.posix.join("home", homeRelativePath.split(path.sep).join("/"));
  }

  return resolvedPath.replace(/\\/g, "/");
}

function isRepoTrackedArtifactPath(filePath) {
  return (
    typeof filePath === "string" &&
    filePath.length > 0 &&
    !filePath.startsWith("desktop/") &&
    !filePath.startsWith("home/") &&
    !/^[A-Za-z]:\//.test(filePath)
  );
}

async function resolveGitCommit(commitish) {
  if (!commitish) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", commitish], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function computeSha256(filePath) {
  const hash = createHash("sha256");

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });

  return hash.digest("hex");
}

function inferAssetKind(assetName) {
  if (/release-manifest\.json$/i.test(assetName)) {
    return "release-manifest";
  }

  if (/\.tgz$/i.test(assetName)) {
    return "package-tarball";
  }

  if (/^ai-factory-starter-win-(x64|arm64|x86)-.+\.zip$/i.test(assetName)) {
    return "windows-release-zip";
  }

  return "supplemental";
}

export function summarizeValidationResults(validationResults, validationResultsPath = null) {
  if (!validationResults || !Array.isArray(validationResults.results)) {
    return {
      sourceArtifactPath: validationResultsPath,
      sourceArtifactTrackedInRepo: isRepoTrackedArtifactPath(validationResultsPath),
      allPassed: null,
      resultCount: 0,
      commands: []
    };
  }

  return {
    sourceArtifactPath: validationResultsPath,
    sourceArtifactTrackedInRepo: isRepoTrackedArtifactPath(validationResultsPath),
    allPassed: validationResults.results.every((result) => result.status === "passed"),
    resultCount: validationResults.results.length,
    commands: validationResults.results.map((result) => ({
      command: result.command,
      status: result.status,
      evidenceStrength: result.evidenceStrength ?? null
    }))
  };
}

function buildLocalChecks(validationSummary) {
  const localChecks = [];

  for (const commandRecord of Array.isArray(validationSummary?.commands) ? validationSummary.commands : []) {
    if (typeof commandRecord?.command === "string" && commandRecord.command.length > 0) {
      localChecks.push(commandRecord.command);
    }
  }

  if (validationSummary?.sourceArtifactPath) {
    localChecks.push("npm run selfcheck");
  }

  return [...new Set(localChecks)];
}

export function buildReleasePublishEvidence({
  tag,
  releaseUrl,
  publishedAt,
  timezone,
  packageJson,
  releaseManifestPath,
  releaseNotesPath,
  releaseManifest,
  fullCommit,
  validationSummary,
  assetRecords,
  externalReviewerSummary = null,
  externalReviewerRerunChecks = defaultExternalReviewerRerunChecks
}) {
  const shortCommit = releaseManifest?.commit ?? (fullCommit ? fullCommit.slice(0, 7) : null);

  return {
    schemaVersion: "1.0.0",
    release: {
      version: packageJson?.version ?? null,
      tag,
      commit: shortCommit,
      releasedAt: publishedAt,
      timezone: timezone ?? null,
      releaseUrl
    },
    provenance: {
      packageName: packageJson?.name ?? null,
      packageVersion: packageJson?.version ?? null,
      gitBranch: releaseManifest?.branch ?? null,
      gitCommitFull: fullCommit ?? releaseManifest?.commit ?? null,
      sourceManifestGeneratedAt: releaseManifest?.generatedAt ?? null,
      sourceManifestPath: releaseManifestPath,
      releaseNotesPath,
      evidenceScriptPath: "scripts/release-publish-evidence.mjs",
      notes: [
        "This evidence artifact is lightweight and tracks published release facts only.",
        "Use release-manifest.json plus release assets for deep binary-level forensics."
      ]
    },
    windowsRelease: {
      nodeArchitecture: releaseManifest?.nodeArchitecture ?? null,
      windowsTarget: releaseManifest?.windowsTarget ?? null,
      releaseDirectoryName: releaseManifest?.releaseDirectoryName ?? null,
      releaseArchiveFileName: releaseManifest?.releaseArchiveFileName ?? null
    },
    validationSummary,
    assets: assetRecords,
    verification: {
      localChecks: buildLocalChecks(validationSummary),
      externalReviewerRerunChecks:
        Array.isArray(externalReviewerRerunChecks) && externalReviewerRerunChecks.length > 0
          ? externalReviewerRerunChecks
          : defaultExternalReviewerRerunChecks,
      externalReviewerSummary
    },
    rerunPrerequisite: "From bundle repo/: run npm ci before rerunning repo-level validation commands."
  };
}

async function collectAssetRecords(assetEntries) {
  const assetRecords = [];

  for (const assetEntry of assetEntries) {
    const assetStats = await stat(assetEntry.filePath);
    const assetName = path.basename(assetEntry.filePath);
    assetRecords.push({
      name: assetName,
      kind: inferAssetKind(assetName),
      sizeBytes: assetStats.size,
      sha256: await computeSha256(assetEntry.filePath),
      downloadUrl: assetEntry.downloadUrl
    });
  }

  return assetRecords;
}

export async function createReleasePublishEvidence({
  tag,
  releaseUrl,
  publishedAt,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
  releaseManifestPath,
  validationResultsPath = path.join(projectRoot, "reports", "validation-results.json"),
  releaseNotesPath = path.join(projectRoot, "docs", "releases", `${tag}.md`),
  outputPath = path.join(projectRoot, "docs", "releases", `${tag}.evidence.json`),
  externalReviewerSummary = null,
  externalReviewerChecks = defaultExternalReviewerRerunChecks,
  assetEntries
}) {
  const [packageJson, releaseManifest] = await Promise.all([
    readJson(path.join(projectRoot, "package.json")),
    readJson(releaseManifestPath)
  ]);

  const normalizedValidationResultsPath = await fileExists(validationResultsPath)
    ? describeArtifactPath(validationResultsPath)
    : null;
  const validationResults = normalizedValidationResultsPath ? await readJson(validationResultsPath) : null;
  const fullCommit = await resolveGitCommit(releaseManifest?.commit);
  const assetRecords = await collectAssetRecords(assetEntries);

  const evidence = buildReleasePublishEvidence({
    tag,
    releaseUrl,
    publishedAt,
    timezone,
    packageJson,
    releaseManifestPath: describeArtifactPath(releaseManifestPath),
    releaseNotesPath: describeArtifactPath(releaseNotesPath),
    releaseManifest,
    fullCommit,
    validationSummary: summarizeValidationResults(validationResults, normalizedValidationResultsPath),
    assetRecords,
    externalReviewerSummary,
    externalReviewerRerunChecks: externalReviewerChecks
  });

  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    outputPath,
    evidence
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await createReleasePublishEvidence(options);
  console.log(`Release publish evidence: ${result.outputPath}`);
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
