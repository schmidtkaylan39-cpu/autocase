import { execFile } from "node:child_process";
import { access, cp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import {
  buildPowerShellCommandArgs,
  getPowerShellInvocation,
  toPowerShellSingleQuotedLiteral
} from "./powershell.mjs";

const execFileAsync = promisify(execFile);
const excludedDirectoryNames = new Set([".git", "node_modules", "review-bundles"]);

function compactTimestamp(timestamp = new Date().toISOString()) {
  const [datePart, timePart] = timestamp.split("T");
  const compactDate = datePart.replace(/-/g, "");
  const compactTime = (timePart ?? "000000").replace(/[:.Z]/g, "").slice(0, 6);
  return `${compactDate}-${compactTime}`;
}

function safePathLabel(filePath) {
  return filePath.split(path.sep).join("/");
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalJson(filePath) {
  if (!(await fileExists(filePath))) {
    return null;
  }

  try {
    return await readJson(filePath);
  } catch {
    return null;
  }
}

async function runOptionalGit(sourceDir, args) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: sourceDir,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });

    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function collectGitMetadata(sourceDir) {
  const [branch, head, shortHead, statusShort, remotes, recentCommits] = await Promise.all([
    runOptionalGit(sourceDir, ["branch", "--show-current"]),
    runOptionalGit(sourceDir, ["rev-parse", "HEAD"]),
    runOptionalGit(sourceDir, ["rev-parse", "--short", "HEAD"]),
    runOptionalGit(sourceDir, ["status", "--short"]),
    runOptionalGit(sourceDir, ["remote", "-v"]),
    runOptionalGit(sourceDir, ["log", "-5", "--oneline", "--decorate"])
  ]);

  if (!branch && !head && !statusShort && !remotes && !recentCommits) {
    return null;
  }

  return {
    branch: branch || null,
    head: head || null,
    shortHead: shortHead || null,
    clean: !statusShort,
    statusShort: statusShort || "",
    remotes: remotes || "",
    recentCommits: recentCommits || ""
  };
}

async function listRelativeFiles(rootDirectory, currentDirectory = rootDirectory) {
  const entries = await readdir(currentDirectory, {
    withFileTypes: true
  });
  const relativeFiles = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(currentDirectory, entry.name);

    if (entry.isDirectory()) {
      relativeFiles.push(...(await listRelativeFiles(rootDirectory, absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    relativeFiles.push(safePathLabel(path.relative(rootDirectory, absolutePath)));
  }

  return relativeFiles;
}

function summarizeDoctorReport(report) {
  if (!report || !Array.isArray(report.checks)) {
    return null;
  }

  return report.checks.map((check) => ({
    id: check.id,
    ok: check.ok,
    installed: check.installed
  }));
}

function summarizeBurninReport(report) {
  if (!report || typeof report !== "object") {
    return null;
  }

  return {
    finishedAt: report.finishedAt ?? null,
    preset: report.config?.preset ?? null,
    roundsRequested: report.config?.roundsRequested ?? null,
    roundsExecuted: report.totals?.roundsExecuted ?? null,
    roundsPassed: report.totals?.roundsPassed ?? null,
    roundsFailed: report.totals?.roundsFailed ?? null,
    stepsFailed: report.totals?.stepsFailed ?? null,
    durationMs: report.durationMs ?? null
  };
}

async function collectRunsMetadata(sourceDir) {
  const runsDirectory = path.join(sourceDir, "runs");

  if (!(await fileExists(runsDirectory))) {
    return [];
  }

  const directoryEntries = await readdir(runsDirectory, {
    withFileTypes: true
  });
  const runs = [];

  for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runDirectory = path.join(runsDirectory, entry.name);
    const runState = await readOptionalJson(path.join(runDirectory, "run-state.json"));

    if (!runState || !Array.isArray(runState.taskLedger)) {
      continue;
    }

    runs.push({
      runId: runState.runId ?? entry.name,
      projectName: runState.projectName ?? null,
      status: runState.status ?? null,
      reportPath: safePathLabel(path.join("repo", "runs", entry.name, "report.md")),
      runStatePath: safePathLabel(path.join("repo", "runs", entry.name, "run-state.json")),
      totals: {
        totalTasks: runState.taskLedger.length,
        readyTasks: runState.taskLedger.filter((task) => task.status === "ready").length,
        waitingRetryTasks: runState.taskLedger.filter((task) => task.status === "waiting_retry").length,
        completedTasks: runState.taskLedger.filter((task) => task.status === "completed").length,
        blockedTasks: runState.taskLedger.filter((task) => task.status === "blocked").length,
        failedTasks: runState.taskLedger.filter((task) => task.status === "failed").length
      }
    });
  }

  return runs;
}

async function collectEvidenceSummary(sourceDir) {
  const reportsDirectory = path.join(sourceDir, "reports");
  const reportFiles = (await fileExists(reportsDirectory))
    ? await listRelativeFiles(reportsDirectory)
    : [];

  const [runtimeDoctor, qualityBurnin, exampleBurnin] = await Promise.all([
    readOptionalJson(path.join(reportsDirectory, "runtime-doctor.json")),
    readOptionalJson(path.join(reportsDirectory, "release-burnin-summary.json")),
    readOptionalJson(path.join(reportsDirectory, "example-smoke-burnin-summary.json"))
  ]);

  return {
    reportFiles: reportFiles.map((relativePath) => safePathLabel(path.join("repo", "reports", relativePath))),
    runtimeDoctor: summarizeDoctorReport(runtimeDoctor),
    qualityBurnin: summarizeBurninReport(qualityBurnin),
    exampleBurnin: summarizeBurninReport(exampleBurnin),
    runs: await collectRunsMetadata(sourceDir)
  };
}

function shouldExcludeEntry(entryPath, sourceDir, outputRootInSourceTree) {
  const resolvedPath = path.resolve(entryPath);
  const relativePath = path.relative(sourceDir, resolvedPath);

  if (relativePath.startsWith("..")) {
    return true;
  }

  if (outputRootInSourceTree) {
    const outputPrefix = `${outputRootInSourceTree}${path.sep}`;
    if (resolvedPath === outputRootInSourceTree || resolvedPath.startsWith(outputPrefix)) {
      return true;
    }
  }

  if (!relativePath || relativePath === ".") {
    return false;
  }

  return relativePath
    .split(path.sep)
    .some((segment) => excludedDirectoryNames.has(segment));
}

function renderReviewBrief(manifest) {
  const git = manifest.git;
  const evidence = manifest.evidence;
  const archiveLabel = manifest.archive?.path ?? "directory only";
  const runLines =
    evidence.runs.length > 0
      ? evidence.runs.map(
          (run) =>
            `- ${run.runId}: status=${run.status}, completed=${run.totals.completedTasks}, ready=${run.totals.readyTasks}, blocked=${run.totals.blockedTasks}, waiting_retry=${run.totals.waitingRetryTasks}`
        )
      : ["- No run-state snapshots were included."];
  const doctorLines = Array.isArray(evidence.runtimeDoctor)
    ? evidence.runtimeDoctor.map((check) => `- ${check.id}: ${check.ok ? "ready" : "not ready"}`)
    : ["- No runtime doctor summary was found."];

  return [
    "# External AI Review Brief",
    "",
    `- Bundle: ${manifest.bundleName}`,
    `- Generated at: ${manifest.generatedAt}`,
    `- Package: ${manifest.package.name ?? "unknown"}@${manifest.package.version ?? "unknown"}`,
    `- Archive: ${archiveLabel}`,
    `- Files copied: ${manifest.inventory.fileCount}`,
    "",
    "## Repo Snapshot",
    `- Branch: ${git?.branch ?? "unknown"}`,
    `- Commit: ${git?.head ?? "unknown"}`,
    `- Clean worktree at bundle time: ${git ? (git.clean ? "yes" : "no") : "unknown"}`,
    "",
    "## High-Value Review Targets",
    "- `repo/src/lib/commands.mjs`: task state transitions across `result`, `retry`, `tick`, and `handoff`",
    "- `repo/src/lib/dispatch.mjs`: launcher execution, result-artifact validation, and run-state sync",
    "- `repo/src/lib/model-policy.mjs`: model auto-switching and escalation rules",
    "- `repo/src/lib/run-state.mjs`: dependency unlock logic and retry promotion behavior",
    "- `repo/src/lib/runtime-registry.mjs`: routing fallbacks and role-to-runtime selection",
    "- `repo/src/lib/doctor.mjs` and `repo/src/lib/powershell.mjs`: runtime probing and cross-platform shell behavior",
    "- `repo/src/lib/review-bundle.mjs`: packaging logic, archive behavior, and metadata accuracy",
    "- `repo/tests/run-tests.mjs`, `repo/tests/cli-entry-tests.mjs`, `repo/tests/review-bundle-tests.mjs`, and `repo/scripts/e2e-smoke.mjs`: expected behavior and coverage gaps",
    "",
    "## Suggested Review Questions",
    "- Are there state transitions that can silently lose information or unlock tasks too early?",
    "- Can malformed or missing artifacts leave the repo in a misleadingly healthy state?",
    "- Are there Windows/Linux behavior differences in launchers, archive generation, or runtime checks?",
    "- Does the review-bundle export omit anything another model would need for a thorough bug hunt?",
    "- Are retry-window and hybrid-runtime flows robust under repeated failures or partially written artifacts?",
    "",
    "## Included Evidence",
    ...doctorLines,
    ...(evidence.qualityBurnin
      ? [
          `- Quality burn-in: ${evidence.qualityBurnin.roundsPassed}/${evidence.qualityBurnin.roundsExecuted} rounds passed, stepsFailed=${evidence.qualityBurnin.stepsFailed}`
        ]
      : ["- No quality burn-in summary was found."]),
    ...(evidence.exampleBurnin
      ? [
          `- Example burn-in: ${evidence.exampleBurnin.roundsPassed}/${evidence.exampleBurnin.roundsExecuted} rounds passed, stepsFailed=${evidence.exampleBurnin.stepsFailed}`
        ]
      : ["- No example burn-in summary was found."]),
    "",
    "## Included Runs",
    ...runLines,
    "",
    "## Important Files",
    "- `metadata/bundle-manifest.json`",
    "- `metadata/git-status.txt`",
    "- `metadata/git-log.txt`",
    "- `metadata/source-file-list.txt`",
    "- `repo/README.md`",
    "- `repo/CONTRIBUTING.md`",
    "- `repo/docs/architecture.md`",
    "- `repo/docs/model-routing.md`",
    "- `repo/docs/release-readiness.md`",
    "",
    "## Review Output Expectations",
    "- prioritize concrete bugs, regressions, and missing validations over summaries",
    "- include file paths and the smallest convincing explanation for each finding",
    "- call out residual risks even if no definite bug is found"
  ].join("\n");
}

function renderReviewPrompt() {
  return [
    "# External AI Review Prompt",
    "",
    "Use the attached repository bundle as a bug-hunting and risk-review package.",
    "",
    "You are reviewing a local CLI project called `ai-factory-starter`.",
    "",
    "Read these files first:",
    "",
    "- `metadata/bundle-manifest.json`",
    "- `metadata/external-ai-review-brief.md`",
    "- `repo/README.md`",
    "- `repo/docs/architecture.md`",
    "- `repo/docs/model-routing.md`",
    "- `repo/docs/release-readiness.md`",
    "",
    "Then review the codebase under `repo/`.",
    "",
    "Priority areas:",
    "",
    "1. State-transition correctness",
    "   Focus on `repo/src/lib/commands.mjs`, `repo/src/lib/run-state.mjs`, and `repo/src/lib/dispatch.mjs`.",
    "2. Hybrid/manual follow-up safety",
    "   Focus on `result`, `retry`, `tick`, `handoff`, and dispatch result syncing.",
    "3. Cross-platform behavior",
    "   Focus on PowerShell invocation, archive generation, CLI behavior, and Windows/Linux compatibility.",
    "4. Model-routing correctness",
    "   Focus on `repo/src/lib/model-policy.mjs`, handoff descriptors, and escalation behavior.",
    "5. Review-bundle completeness",
    "   Check whether this package omits anything another reviewer would need to find bugs efficiently.",
    "6. Test gaps",
    "   Look for missing negative cases, flaky flows, or under-covered execution paths.",
    "",
    "What to optimize for:",
    "",
    "- real bugs",
    "- behavioral regressions",
    "- inconsistent docs vs. implementation",
    "- unsafe assumptions",
    "- missing validation",
    "- edge cases that could silently corrupt run-state or reports",
    "",
    "Output requirements:",
    "",
    "- Start with findings immediately. Do not begin with a summary.",
    "- Order findings by severity.",
    "- For each finding include:",
    "  - severity",
    "  - file path",
    "  - concise explanation",
    "  - why it matters",
    "  - suggested fix",
    "- If no concrete bug is found, explicitly say so and then list residual risks and testing gaps.",
    "",
    "Important constraints:",
    "",
    "- Be skeptical and precise.",
    "- Prefer concrete code-level issues over general advice.",
    "- Do not spend most of the response summarizing the project.",
    "- Do not assume the included tests prove correctness."
  ].join("\n");
}

async function writeGitArtifacts(metadataDirectory, gitMetadata) {
  if (!gitMetadata) {
    return;
  }

  await writeFile(
    path.join(metadataDirectory, "git-status.txt"),
    `${gitMetadata.statusShort || "(clean)"}\n`,
    "utf8"
  );
  await writeFile(
    path.join(metadataDirectory, "git-log.txt"),
    `${gitMetadata.recentCommits || "(no git log available)"}\n`,
    "utf8"
  );
  await writeFile(
    path.join(metadataDirectory, "git-remotes.txt"),
    `${gitMetadata.remotes || "(no remotes configured)"}\n`,
    "utf8"
  );
}

async function createArchive(bundleDirectory, destinationBasePath) {
  if (process.platform === "win32") {
    const archivePath = `${destinationBasePath}.zip`;
    const runtime = getPowerShellInvocation();
    const command = [
      "Add-Type -AssemblyName System.IO.Compression",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `$sourceDir = ${toPowerShellSingleQuotedLiteral(bundleDirectory)}`,
      `$archivePath = ${toPowerShellSingleQuotedLiteral(archivePath)}`,
      `$entryRoot = ${toPowerShellSingleQuotedLiteral(path.basename(bundleDirectory))}`,
      "$sourceRoot = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $sourceDir).ProviderPath).TrimEnd('\\')",
      "$sourceRootUri = New-Object System.Uri(($sourceRoot + '\\'))",
      "if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }",
      "$zip = [System.IO.Compression.ZipFile]::Open($archivePath, [System.IO.Compression.ZipArchiveMode]::Create)",
      "try {",
      "  Get-ChildItem -LiteralPath $sourceDir -Recurse -File | ForEach-Object {",
      "    $filePath = [System.IO.Path]::GetFullPath($_.FullName)",
      "    $fileUri = New-Object System.Uri($filePath)",
      "    $relative = [System.Uri]::UnescapeDataString($sourceRootUri.MakeRelativeUri($fileUri).ToString())",
      "    $entryName = ($entryRoot + '/' + $relative).Replace('\\\\', '/')",
      "    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName) | Out-Null",
      "  }",
      "} finally {",
      "  $zip.Dispose()",
      "}"
    ].join("\n");

    await execFileAsync(runtime.command, buildPowerShellCommandArgs(command), {
      encoding: "utf8",
      windowsHide: runtime.windowsHide,
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024
    });

    return {
      archivePath,
      archiveFormat: "zip"
    };
  }

  try {
    const archivePath = `${destinationBasePath}.zip`;
    await execFileAsync("zip", ["-qr", archivePath, path.basename(bundleDirectory)], {
      cwd: path.dirname(bundleDirectory),
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024
    });

    return {
      archivePath,
      archiveFormat: "zip"
    };
  } catch {
    try {
      const archivePath = `${destinationBasePath}.tar.gz`;
      await execFileAsync("tar", ["-czf", archivePath, path.basename(bundleDirectory)], {
        cwd: path.dirname(bundleDirectory),
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024
      });

      return {
        archivePath,
        archiveFormat: "tar.gz"
      };
    } catch {
      return {
        archivePath: null,
        archiveFormat: "directory"
      };
    }
  }
}

/**
 * @param {{
 *   sourceDir?: string,
 *   outputDir?: string,
 *   bundleName?: string,
 *   archive?: boolean
 * }} [options]
 */
export async function createReviewBundle({
  sourceDir = process.cwd(),
  outputDir = "review-bundles",
  bundleName = undefined,
  archive = true
} = {}) {
  const resolvedSourceDir = path.resolve(sourceDir);
  const resolvedOutputDir = path.isAbsolute(outputDir)
    ? outputDir
    : path.resolve(resolvedSourceDir, outputDir);
  const effectiveBundleName = bundleName || `review-bundle-${compactTimestamp()}`;
  const bundleDirectory = path.join(resolvedOutputDir, effectiveBundleName);
  const bundleSourceDirectory = path.join(bundleDirectory, "repo");
  const metadataDirectory = path.join(bundleDirectory, "metadata");
  const outputRootInSourceTree =
    resolvedOutputDir === resolvedSourceDir || resolvedOutputDir.startsWith(`${resolvedSourceDir}${path.sep}`)
      ? resolvedOutputDir
      : null;

  if (await fileExists(bundleDirectory)) {
    await rm(bundleDirectory, { recursive: true, force: true });
  }

  await ensureDirectory(metadataDirectory);
  await ensureDirectory(bundleSourceDirectory);

  const sourceEntries = await readdir(resolvedSourceDir, {
    withFileTypes: true
  });

  for (const entry of sourceEntries) {
    const sourceEntryPath = path.join(resolvedSourceDir, entry.name);

    if (shouldExcludeEntry(sourceEntryPath, resolvedSourceDir, outputRootInSourceTree)) {
      continue;
    }

    await cp(sourceEntryPath, path.join(bundleSourceDirectory, entry.name), {
      recursive: true,
      filter: (fromPath) =>
        !shouldExcludeEntry(fromPath, resolvedSourceDir, outputRootInSourceTree)
    });
  }

  const [packageJson, gitMetadata, evidenceSummary] = await Promise.all([
    readOptionalJson(path.join(resolvedSourceDir, "package.json")),
    collectGitMetadata(resolvedSourceDir),
    collectEvidenceSummary(resolvedSourceDir)
  ]);
  const manifestPath = path.join(metadataDirectory, "bundle-manifest.json");
  const reviewBriefPath = path.join(metadataDirectory, "external-ai-review-brief.md");
  const reviewPromptPath = path.join(metadataDirectory, "external-ai-review-prompt.md");
  const sourceFileListPath = path.join(metadataDirectory, "source-file-list.txt");
  const topLevelEntries = await readdir(bundleSourceDirectory);

  await writeGitArtifacts(metadataDirectory, gitMetadata);
  await writeFile(reviewPromptPath, `${renderReviewPrompt()}\n`, "utf8");

  const baseManifest = {
    generatedAt: new Date().toISOString(),
    bundleName: effectiveBundleName,
    package: {
      name: packageJson?.name ?? null,
      version: packageJson?.version ?? null
    },
    git: gitMetadata,
    evidence: evidenceSummary,
    paths: {
      repoRoot: "repo",
      manifestPath: "metadata/bundle-manifest.json",
      reviewBriefPath: "metadata/external-ai-review-brief.md",
      reviewPromptPath: "metadata/external-ai-review-prompt.md",
      gitStatusPath: gitMetadata ? "metadata/git-status.txt" : null,
      gitLogPath: gitMetadata ? "metadata/git-log.txt" : null,
      gitRemotesPath: gitMetadata ? "metadata/git-remotes.txt" : null
    }
  };

  const writeBundleMetadata = async (manifest) => {
    await writeJson(manifestPath, manifest);
    await writeFile(reviewBriefPath, `${renderReviewBrief(manifest)}\n`, "utf8");
  };

  await writeBundleMetadata({
    ...baseManifest,
    inventory: {
      fileCount: 0,
      topLevelEntries,
      sourceFileListPath: "metadata/source-file-list.txt"
    },
    archive: {
      format: "directory",
      path: null
    }
  });
  await writeFile(sourceFileListPath, "", "utf8");

  const copiedFiles = await listRelativeFiles(bundleDirectory);
  await writeFile(sourceFileListPath, `${copiedFiles.join("\n")}\n`, "utf8");

  const buildManifest = (archiveInfo) => ({
    ...baseManifest,
    inventory: {
      fileCount: copiedFiles.length,
      topLevelEntries,
      sourceFileListPath: "metadata/source-file-list.txt"
    },
    archive: archiveInfo
  });

  let archiveResult = {
    archivePath: null,
    archiveFormat: "directory"
  };

  let finalManifest = buildManifest({
    format: "directory",
    path: null
  });

  await writeBundleMetadata(finalManifest);

  if (archive) {
    archiveResult = await createArchive(bundleDirectory, bundleDirectory);
    finalManifest = buildManifest({
      format: archiveResult.archiveFormat,
      path: archiveResult.archivePath
        ? safePathLabel(path.relative(bundleDirectory, archiveResult.archivePath))
        : null
    });
    await writeBundleMetadata(finalManifest);

    if (archiveResult.archivePath) {
      archiveResult = await createArchive(bundleDirectory, bundleDirectory);
      finalManifest = buildManifest({
        format: archiveResult.archiveFormat,
        path: safePathLabel(path.relative(bundleDirectory, archiveResult.archivePath))
      });
      await writeBundleMetadata(finalManifest);
    }
  }

  return {
    bundleDirectory,
    bundleSourceDirectory,
    metadataDirectory,
    manifestPath,
    reviewBriefPath,
    reviewPromptPath,
    archivePath: archiveResult.archivePath,
    archiveFormat: archiveResult.archiveFormat,
    fileCount: copiedFiles.length
  };
}
