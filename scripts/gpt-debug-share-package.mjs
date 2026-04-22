import { execFile } from "node:child_process";
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readJson, writeJson } from "../src/lib/fs-utils.mjs";
import { validateZipArchiveEntryNames } from "../src/lib/zip-archive.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDir = path.join(projectRoot, "review-bundles");
const defaultPromptDir = path.join(projectRoot, "reports", "gpt-debug");
const mirrorEntries = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "src",
  "scripts",
  "tests",
  "docs",
  "config",
  "prompts",
  "templates",
  "examples"
];
const requiredMetadataFiles = [
  "bundle-manifest.json",
  "external-ai-review-brief.md"
];

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

function toPortableRelativePath(basePath, targetPath) {
  return path.relative(basePath, targetPath).replace(/\\/g, "/");
}

async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

async function readOptionalJson(targetPath) {
  if (!(await fileExists(targetPath))) {
    return null;
  }

  return readJson(targetPath);
}

async function findLatestNamedDirectory(rootDirectory, prefix) {
  const entries = await readdir(rootDirectory, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }

    const fullPath = path.join(rootDirectory, entry.name);
    const entryStats = await stat(fullPath);
    candidates.push({
      fullPath,
      mtimeMs: entryStats.mtimeMs
    });
  }

  invariant(candidates.length > 0, `No ${prefix}* directory found under ${rootDirectory}`);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].fullPath;
}

async function findLatestFile(rootDirectory, predicate) {
  const candidates = [];

  async function walk(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !predicate(fullPath, entry.name)) {
        continue;
      }

      const entryStats = await stat(fullPath);
      candidates.push({
        fullPath,
        mtimeMs: entryStats.mtimeMs
      });
    }
  }

  await walk(rootDirectory);
  invariant(candidates.length > 0, `No matching file found under ${rootDirectory}`);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].fullPath;
}

async function resolveLatestPromptPath() {
  return findLatestFile(defaultPromptDir, (_fullPath, entryName) => entryName.endsWith(".md"));
}

async function resolveLatestPanelSmokeSummaryPath() {
  const latestRunDirectory = await findLatestNamedDirectory(
    path.join(projectRoot, "reports", "panel-smoke"),
    "panel-one-click-"
  );
  return path.join(latestRunDirectory, "panel-smoke-summary.json");
}

async function resolveLatestBrowserSmokeSummaryPath() {
  const reportsRoot = path.join(projectRoot, "reports", "panel-browser-smoke");

  if (await fileExists(reportsRoot)) {
    return findLatestFile(
      reportsRoot,
      (_fullPath, entryName) => entryName === "panel-browser-smoke-summary.json"
    );
  }

  return findLatestFile(
    path.join(projectRoot, "tmp"),
    (fullPath, entryName) =>
      entryName === "panel-browser-smoke-summary.json" &&
      fullPath.includes(`${path.sep}panel-browser-smoke-run`)
  );
}

function parseArgs(argv) {
  const options = {
    sourceDir: projectRoot,
    outputDir: defaultOutputDir,
    bundleDir: null,
    panelSummaryPath: null,
    browserSummaryPath: null,
    promptPath: null,
    packageName: null,
    archive: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = argv[index + 1];

    switch (arg) {
      case "--source-dir":
        options.sourceDir = path.resolve(nextValue);
        index += 1;
        break;
      case "--output-dir":
        options.outputDir = path.resolve(nextValue);
        index += 1;
        break;
      case "--bundle-dir":
        options.bundleDir = path.resolve(nextValue);
        index += 1;
        break;
      case "--panel-summary":
        options.panelSummaryPath = path.resolve(nextValue);
        index += 1;
        break;
      case "--browser-summary":
        options.browserSummaryPath = path.resolve(nextValue);
        index += 1;
        break;
      case "--prompt":
        options.promptPath = path.resolve(nextValue);
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

export function extractNodeScriptTargets(packageMetadata) {
  const targets = new Set();
  const scripts = packageMetadata?.scripts ?? {};

  for (const command of Object.values(scripts)) {
    if (typeof command !== "string") {
      continue;
    }

    const matches = command.matchAll(/\bnode\s+([^\s"'`]+\.mjs)\b/g);

    for (const match of matches) {
      if (match[1]) {
        targets.add(match[1]);
      }
    }
  }

  return [...targets].sort();
}

export async function validateMirroredRepoSurface(repoRoot) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  invariant(await fileExists(packageJsonPath), `Missing mirrored package.json: ${packageJsonPath}`);
  const packageMetadata = await readJson(packageJsonPath);
  const missingScriptTargets = [];

  for (const target of extractNodeScriptTargets(packageMetadata)) {
    const targetPath = path.join(repoRoot, target);

    if (!(await fileExists(targetPath))) {
      missingScriptTargets.push(target);
    }
  }

  invariant(
    missingScriptTargets.length === 0,
    `Mirrored repo is missing package.json script targets: ${missingScriptTargets.join(", ")}`
  );

  const panelModulePath = path.join(repoRoot, "src", "lib", "panel.mjs");
  invariant(await fileExists(panelModulePath), `Missing mirrored panel module: ${panelModulePath}`);
  await import(pathToFileURL(panelModulePath).href);

  const browserSmokeScriptPath = path.join(repoRoot, "scripts", "panel-browser-smoke.mjs");
  invariant(await fileExists(browserSmokeScriptPath), `Missing mirrored browser smoke script: ${browserSmokeScriptPath}`);
  await import(pathToFileURL(browserSmokeScriptPath).href);

  return {
    packageJsonPath,
    panelModulePath,
    browserSmokeScriptPath
  };
}

async function copyIfPresent(sourcePath, destinationPath) {
  if (!(await fileExists(sourcePath))) {
    return false;
  }

  await ensureDirectory(path.dirname(destinationPath));
  await cp(sourcePath, destinationPath, { recursive: true });
  return true;
}

async function createZipArchive(packageDirectory, archivePath) {
  if (process.platform === "win32") {
    await execFileAsync("tar", ["-a", "-cf", path.basename(archivePath), path.basename(packageDirectory)], {
      cwd: path.dirname(packageDirectory),
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
  } else {
    await execFileAsync("zip", ["-qr", archivePath, path.basename(packageDirectory)], {
      cwd: path.dirname(packageDirectory),
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024
    });
  }

  await validateZipArchiveEntryNames(archivePath);
}

async function copyMetadata(bundleDir, metadataDirectory, sourceDir) {
  const metadataSourceDirectory = path.join(bundleDir, "metadata");
  invariant(await fileExists(metadataSourceDirectory), `Bundle metadata directory does not exist: ${metadataSourceDirectory}`);

  for (const fileName of requiredMetadataFiles) {
    const sourcePath = path.join(metadataSourceDirectory, fileName);
    invariant(await fileExists(sourcePath), `Required bundle metadata file is missing: ${sourcePath}`);
    await copyIfPresent(sourcePath, path.join(metadataDirectory, fileName));
  }

  const validationResultsSourcePath =
    (await fileExists(path.join(sourceDir, "reports", "validation-results.json")))
      ? path.join(sourceDir, "reports", "validation-results.json")
      : path.join(metadataSourceDirectory, "validation-results.json");

  if (await fileExists(validationResultsSourcePath)) {
    await copyIfPresent(validationResultsSourcePath, path.join(metadataDirectory, "validation-results.json"));
  }
}

function renderReadme({ packageName, shortCommit, panelSummaryRelativePath, browserSummaryRelativePath }) {
  return [
    "# GPT Debug Share Package (Slim)",
    "",
    `- Package: ${packageName}`,
    `- Commit: ${shortCommit ?? "unknown"}`,
    `- Panel smoke summary: ${panelSummaryRelativePath}`,
    `- Browser smoke summary: ${browserSummaryRelativePath}`,
    "",
    "This is a compact external-debug package for the panel one-click human UI flow.",
    "",
    "Contract:",
    "- `repo/` is a complete mirrored code surface for source, scripts, tests, docs, and prompts.",
    "- `repo/` is validated so `package.json` node-script targets exist and `src/lib/panel.mjs` imports cleanly.",
    "- panel/browser acceptance artifacts are copied under `acceptance/` so external evidence stays inside the package surface.",
    "- retained artifacts are intentionally focused on the latest panel/browser evidence rather than full repo history.",
    "",
    "Use `GPT-DEBUG-PROMPT.md` together with this package."
  ].join("\n");
}

function renderPromptText(basePromptText, { panelEvidence, browserEvidence }) {
  const lines = String(basePromptText ?? "")
    .split(/\r?\n/g)
    .filter(
      (line) =>
        !line.includes("repo/reports/panel-smoke/") &&
        !line.includes("repo/tmp/panel-browser-smoke-run-full")
    );
  const anchor = "- `repo/tests/panel-browser-smoke-tests.mjs`";
  const anchorIndex = lines.indexOf(anchor);
  const evidenceLines = [
    `- \`${panelEvidence.relativePath}/panel-smoke-summary.json\``,
    `- \`${browserEvidence.relativePath}/panel-browser-smoke-summary.json\``,
    `- \`${browserEvidence.relativePath}/artifact-verification.json\``,
    `- \`${browserEvidence.relativePath}/autonomous-summary.json\``
  ];

  if (anchorIndex >= 0) {
    lines.splice(anchorIndex + 1, 0, ...evidenceLines);
  } else {
    lines.push("", "Read these acceptance artifacts too:", ...evidenceLines);
  }

  return `${lines.join("\n")}\n`;
}

async function resolveBundleDir(bundleDir, outputDir) {
  if (bundleDir) {
    return path.resolve(bundleDir);
  }

  return findLatestNamedDirectory(outputDir, "review-bundle-");
}

async function readBundleGitMetadata(bundleDir) {
  const manifestPath = path.join(bundleDir, "metadata", "bundle-manifest.json");
  const manifest = await readOptionalJson(manifestPath);
  return {
    branch: manifest?.git?.branch ?? null,
    shortCommit: manifest?.git?.shortHead ?? manifest?.git?.head ?? null
  };
}

async function copyEvidenceDirectory(summaryPath, packageDirectory, evidenceKind) {
  const sourceDirectory = path.dirname(summaryPath);
  const destinationDirectory = path.join(
    packageDirectory,
    "acceptance",
    evidenceKind,
    path.basename(sourceDirectory)
  );

  await copyIfPresent(sourceDirectory, destinationDirectory);

  return {
    sourceDirectory,
    destinationDirectory,
    relativePath: toPortableRelativePath(packageDirectory, destinationDirectory)
  };
}

/**
 * @param {{
 *   sourceDir?: string,
 *   outputDir?: string,
 *   bundleDir?: string | null,
 *   panelSummaryPath?: string | null,
 *   browserSummaryPath?: string | null,
 *   promptPath?: string | null,
 *   packageName?: string | null,
 *   archive?: boolean
 * }} [options]
 */
export async function createGptDebugSharePackage({
  sourceDir = projectRoot,
  outputDir = defaultOutputDir,
  bundleDir = null,
  panelSummaryPath = null,
  browserSummaryPath = null,
  promptPath = null,
  packageName = null,
  archive = true
} = {}) {
  const resolvedSourceDir = path.resolve(sourceDir);
  const resolvedOutputDir = path.resolve(outputDir);
  const resolvedBundleDir = await resolveBundleDir(bundleDir, resolvedOutputDir);
  const resolvedPanelSummaryPath = panelSummaryPath
    ? path.resolve(panelSummaryPath)
    : await resolveLatestPanelSmokeSummaryPath();
  const resolvedBrowserSummaryPath = browserSummaryPath
    ? path.resolve(browserSummaryPath)
    : await resolveLatestBrowserSmokeSummaryPath();
  const resolvedPromptPath = promptPath
    ? path.resolve(promptPath)
    : await resolveLatestPromptPath();
  const { branch, shortCommit } = await readBundleGitMetadata(resolvedBundleDir);
  const effectivePackageName =
    packageName ?? `gpt-debug-share-panel-human-ui-slim-${compactTimestamp()}-${shortCommit ?? "snapshot"}`;
  const packageDirectory = path.join(resolvedOutputDir, effectivePackageName);
  const archivePath = `${packageDirectory}.zip`;
  const metadataDirectory = path.join(packageDirectory, "metadata");
  const repoDirectory = path.join(packageDirectory, "repo");
  const promptFileName = "GPT-DEBUG-PROMPT.md";

  invariant(await fileExists(resolvedPanelSummaryPath), `Panel smoke summary does not exist: ${resolvedPanelSummaryPath}`);
  invariant(await fileExists(resolvedBrowserSummaryPath), `Browser smoke summary does not exist: ${resolvedBrowserSummaryPath}`);
  invariant(await fileExists(resolvedPromptPath), `GPT debug prompt does not exist: ${resolvedPromptPath}`);

  await rm(packageDirectory, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await ensureDirectory(metadataDirectory);
  await ensureDirectory(repoDirectory);

  for (const entry of mirrorEntries) {
    await copyIfPresent(path.join(resolvedSourceDir, entry), path.join(repoDirectory, entry));
  }

  await copyMetadata(resolvedBundleDir, metadataDirectory, resolvedSourceDir);
  const panelEvidence = await copyEvidenceDirectory(
    resolvedPanelSummaryPath,
    packageDirectory,
    "panel-smoke"
  );
  const browserEvidence = await copyEvidenceDirectory(
    resolvedBrowserSummaryPath,
    packageDirectory,
    "browser-smoke"
  );
  const promptText = await readFile(resolvedPromptPath, "utf8");
  await writeFile(
    path.join(packageDirectory, promptFileName),
    renderPromptText(promptText, {
      panelEvidence,
      browserEvidence
    }),
    "utf8"
  );

  const validation = await validateMirroredRepoSurface(repoDirectory);
  const shareManifest = {
    generatedAt: new Date().toISOString(),
    packageName: effectivePackageName,
    basedOnBranch: branch,
    basedOnCommit: shortCommit,
    bundleDirectory: resolvedBundleDir.replace(/\\/g, "/"),
    promptFile: promptFileName,
    includedEvidence: {
      panelSummaryDirectory: panelEvidence.relativePath,
      browserSummaryDirectory: browserEvidence.relativePath
    },
    validation
  };

  await writeJson(path.join(packageDirectory, "share-manifest.json"), shareManifest);
  await writeFile(
    path.join(packageDirectory, "README.md"),
    `${renderReadme({
      packageName: effectivePackageName,
      shortCommit,
      panelSummaryRelativePath: shareManifest.includedEvidence.panelSummaryDirectory,
      browserSummaryRelativePath: shareManifest.includedEvidence.browserSummaryDirectory
    })}\n`,
    "utf8"
  );

  if (archive) {
    await createZipArchive(packageDirectory, archivePath);
  }

  return {
    packageDirectory,
    archivePath: archive ? archivePath : null,
    promptPath: path.join(packageDirectory, promptFileName),
    shareManifestPath: path.join(packageDirectory, "share-manifest.json"),
    repoDirectory
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await createGptDebugSharePackage(options);
  console.log(`GPT debug share directory: ${result.packageDirectory}`);
  console.log(`GPT debug share manifest: ${result.shareManifestPath}`);
  console.log(`GPT debug prompt: ${result.promptPath}`);

  if (result.archivePath) {
    console.log(`GPT debug share archive: ${result.archivePath}`);
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
