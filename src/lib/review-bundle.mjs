import { execFile } from "node:child_process";
import { access, cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
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
  return filePath.replace(/\\/g, "/").split(path.sep).join("/");
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

function buildValidationResultsArtifact(bundleName, evidenceSummary, generatedAt = new Date().toISOString()) {
  const reportFiles = Array.isArray(evidenceSummary?.reportFiles) ? evidenceSummary.reportFiles : [];
  const includeEvidence = (...suffixes) =>
    reportFiles.filter((reportPath) => suffixes.some((suffix) => reportPath.endsWith(suffix)));

  const results = [];

  if (Array.isArray(evidenceSummary?.runtimeDoctor) && evidenceSummary.runtimeDoctor.length > 0) {
    results.push({
      command: "npm run doctor",
      status: evidenceSummary.runtimeDoctor.every((check) => check.ok) ? "passed" : "failed",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      evidence: includeEvidence("/runtime-doctor.json", "/runtime-doctor.md")
    });
  }

  if (evidenceSummary?.qualityBurnin) {
    results.push({
      command: "npm run burnin",
      status:
        evidenceSummary.qualityBurnin.roundsFailed === 0 && evidenceSummary.qualityBurnin.stepsFailed === 0
          ? "passed"
          : "failed",
      startedAt: null,
      finishedAt: evidenceSummary.qualityBurnin.finishedAt ?? null,
      durationMs: evidenceSummary.qualityBurnin.durationMs ?? null,
      evidence: includeEvidence(
        "/release-burnin-summary.json",
        "/release-burnin-final-debug.json",
        "/release-burnin-matrix-ready.json",
        "/release-burnin-crossplatform-check.json"
      )
    });
  }

  if (evidenceSummary?.exampleBurnin) {
    results.push({
      command: "npm run burnin:example",
      status:
        evidenceSummary.exampleBurnin.roundsFailed === 0 && evidenceSummary.exampleBurnin.stepsFailed === 0
          ? "passed"
          : "failed",
      startedAt: null,
      finishedAt: evidenceSummary.exampleBurnin.finishedAt ?? null,
      durationMs: evidenceSummary.exampleBurnin.durationMs ?? null,
      evidence: includeEvidence(
        "/example-smoke-burnin-summary.json",
        "/example-smoke-burnin-matrix-ready.log",
        "/example-smoke-burnin.log"
      )
    });
  }

  return {
    round: bundleName,
    generatedAt,
    results,
    notes: [
      "This bundle includes machine-readable validation evidence only for checks with captured artifacts.",
      "Additional claimed validations should be corroborated by patch-notes or external CI logs when present."
    ]
  };
}

function isCanonicalValidationResultsArtifact(candidate) {
  return Boolean(candidate) && Array.isArray(candidate.results);
}

function isAbsoluteFilePath(filePath) {
  return path.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
}

function rewriteEvidencePathForBundle(evidencePath, sourceDir) {
  if (typeof evidencePath !== "string") {
    return evidencePath;
  }

  const trimmedPath = evidencePath.trim();
  if (!trimmedPath) {
    return trimmedPath;
  }

  if (isAbsoluteFilePath(trimmedPath)) {
    const relativePath = path.relative(sourceDir, trimmedPath);

    if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return safePathLabel(path.join("repo", relativePath));
    }

    return safePathLabel(trimmedPath);
  }

  const normalizedPath = safePathLabel(trimmedPath).replace(/^\.\//, "");
  if (
    normalizedPath.startsWith("repo/") ||
    normalizedPath.startsWith("metadata/") ||
    normalizedPath.startsWith("../")
  ) {
    return normalizedPath;
  }

  return safePathLabel(path.join("repo", normalizedPath));
}

function rewriteValidationResultsForBundle(validationResults, sourceDir) {
  return {
    ...validationResults,
    results: validationResults.results.map((result) => ({
      ...result,
      evidence: Array.isArray(result?.evidence)
        ? result.evidence.map((evidencePath) => rewriteEvidencePathForBundle(evidencePath, sourceDir))
        : []
    }))
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
    "- `repo/docs/artifact-contract.md`: expected round outputs and workflow-phase handoff contract",
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
    "- `metadata/validation-results.json`",
    "- `metadata/patch-notes.md`",
    "- `metadata/git-status.txt`",
    "- `metadata/git-log.txt`",
    "- `metadata/source-file-list.txt`",
    "- `repo/AGENTS.md`",
    "- `repo/README.md`",
    "- `repo/CONTRIBUTING.md`",
    "- `repo/docs/architecture.md`",
    "- `repo/docs/dispatch.md`",
    "- `repo/docs/handoffs.md`",
    "- `repo/docs/artifact-contract.md`",
    "- `repo/docs/proposal-contract.md`",
    "- `repo/docs/failure-feedback.md`",
    "- `repo/docs/model-routing.md`",
    "- `repo/docs/release-readiness.md`",
    "- `repo/docs/runtime-doctor.md`",
    "- `repo/prompts/planner.md`",
    "- `repo/prompts/reviewer.md`",
    "- `repo/prompts/executor.md`",
    "- `repo/prompts/verifier.md`",
    "- `repo/prompts/orchestrator.md`",
    "- `repo/templates/findings.template.md`",
    "- `repo/templates/patch-notes.template.md`",
    "- `repo/templates/codex-prompt.template.md`",
    "- `repo/templates/proposal-artifact.template.json`",
    "- `repo/templates/failure-feedback.template.json`",
    "- `repo/templates/validation-results.template.json`",
    "",
    "## Review Output Expectations",
    "- prioritize concrete bugs, regressions, and missing validations over summaries",
    "- include file paths and the smallest convincing explanation for each finding",
    "- call out residual risks even if no definite bug is found"
  ].join("\n");
}

function renderPatchNotes(manifest) {
  const recentCommits =
    typeof manifest.git?.recentCommits === "string" && manifest.git.recentCommits.trim().length > 0
      ? manifest.git.recentCommits.trim().split(/\r?\n/).map((line) => `- ${line}`)
      : ["- No recent git history was available when the bundle was generated."];
  const reportFiles =
    Array.isArray(manifest.evidence?.reportFiles) && manifest.evidence.reportFiles.length > 0
      ? manifest.evidence.reportFiles.map((reportPath) => `- ${reportPath}`)
      : ["- No report files were captured in this bundle."];

  return [
    "# Patch Notes",
    "",
    `- Bundle: ${manifest.bundleName}`,
    `- Generated at: ${manifest.generatedAt}`,
    `- Commit: ${manifest.git?.shortHead ?? manifest.git?.head ?? "unknown"}`,
    "",
    "## Included Review Context",
    "- This bundle is intended for follow-up bug review and patch validation.",
    "- Use the bundle manifest and review brief as the canonical inventory of included evidence.",
    "- Significant rounds should be interpreted through the documented artifact contract: findings, patch-notes, codex-prompt, review-bundle, and validation-results.",
    "- Cross-platform launcher behavior is expected to be `.ps1` on Windows and `.sh` on non-Windows runtimes.",
    "",
    "## Recent Commits",
    ...recentCommits,
    "",
    "## Included Evidence Files",
    ...reportFiles
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
    "- `metadata/validation-results.json`",
    "- `metadata/patch-notes.md`",
    "- `repo/AGENTS.md`",
    "- `repo/README.md`",
    "- `repo/docs/architecture.md`",
    "- `repo/docs/dispatch.md`",
    "- `repo/docs/handoffs.md`",
    "- `repo/docs/artifact-contract.md`",
    "- `repo/docs/proposal-contract.md`",
    "- `repo/docs/failure-feedback.md`",
    "- `repo/docs/model-routing.md`",
    "- `repo/docs/release-readiness.md`",
    "- `repo/docs/runtime-doctor.md`",
    "- `repo/prompts/planner.md`",
    "- `repo/prompts/reviewer.md`",
    "- `repo/prompts/executor.md`",
    "- `repo/prompts/verifier.md`",
    "- `repo/prompts/orchestrator.md`",
    "- `repo/templates/findings.template.md`",
    "- `repo/templates/patch-notes.template.md`",
    "- `repo/templates/codex-prompt.template.md`",
    "- `repo/templates/proposal-artifact.template.json`",
    "- `repo/templates/failure-feedback.template.json`",
    "- `repo/templates/validation-results.template.json`",
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
    "   Focus on launcher generation/execution, doctor readiness checks, archive generation, CLI behavior, and Windows/Linux compatibility.",
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

function parseZipEntries(zipBuffer) {
  const endOfCentralDirectorySignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const localFileHeaderSignature = 0x04034b50;

  let endOfCentralDirectoryOffset = -1;

  for (let offset = zipBuffer.length - 22; offset >= 0; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === endOfCentralDirectorySignature) {
      endOfCentralDirectoryOffset = offset;
      break;
    }
  }

  if (endOfCentralDirectoryOffset < 0) {
    throw new Error("Invalid ZIP archive: missing end of central directory record.");
  }

  const centralDirectorySize = zipBuffer.readUInt32LE(endOfCentralDirectoryOffset + 12);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(endOfCentralDirectoryOffset + 16);
  const entries = [];
  let cursor = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (cursor < end) {
    if (zipBuffer.readUInt32LE(cursor) !== centralDirectorySignature) {
      throw new Error("Invalid ZIP central directory entry.");
    }

    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const fileNameLength = zipBuffer.readUInt16LE(cursor + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(cursor + 30);
    const commentLength = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;

    entries.push({
      name: zipBuffer.toString("utf8", nameStart, nameEnd),
      compressionMethod,
      compressedSize,
      localHeaderOffset
    });

    cursor = nameEnd + extraFieldLength + commentLength;
  }

  return entries.map((entry) => {
    if (zipBuffer.readUInt32LE(entry.localHeaderOffset) !== localFileHeaderSignature) {
      throw new Error("Invalid ZIP local file header.");
    }

    const fileNameLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(entry.localHeaderOffset + 28);
    const contentStart = entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
    const compressedContent = zipBuffer.subarray(contentStart, contentStart + entry.compressedSize);
    let contentBuffer;

    if (entry.compressionMethod === 8) {
      contentBuffer = inflateRawSync(compressedContent);
    } else if (entry.compressionMethod === 0) {
      contentBuffer = compressedContent;
    } else {
      throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
    }

    return {
      name: entry.name,
      contentBuffer
    };
  });
}

async function validateZipArchiveEntryNames(archivePath) {
  const zipEntries = parseZipEntries(await readFile(archivePath));
  const invalidEntry = zipEntries.find((entry) => entry.name.includes("\\"));

  if (invalidEntry) {
    throw new Error(`ZIP archive contains backslash path separators: ${invalidEntry.name}`);
  }

  return zipEntries;
}

async function detectArchiveFormat() {
  if (process.platform === "win32") {
    return "zip";
  }

  try {
    await execFileAsync("zip", ["-v"], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    return "zip";
  } catch {
    try {
      await execFileAsync("tar", ["--version"], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024
      });
      return "tar.gz";
    } catch {
      return "directory";
    }
  }
}

async function createZipArchive(bundleDirectory, destinationBasePath) {
  const archivePath = `${destinationBasePath}.zip`;

  if (process.platform === "win32") {
    const archiveDirectory = path.dirname(bundleDirectory);
    const archiveName = path.basename(archivePath);
    const bundleName = path.basename(bundleDirectory);

    try {
      await execFileAsync("tar", ["-a", "-cf", archiveName, bundleName], {
        cwd: archiveDirectory,
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
      });
      await validateZipArchiveEntryNames(archivePath);

      return {
        archivePath,
        archiveFormat: "zip"
      };
    } catch {
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
      await validateZipArchiveEntryNames(archivePath);

      return {
        archivePath,
        archiveFormat: "zip"
      };
    }
  }

  await execFileAsync("zip", ["-qr", archivePath, path.basename(bundleDirectory)], {
    cwd: path.dirname(bundleDirectory),
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024
  });
  await validateZipArchiveEntryNames(archivePath);

  return {
    archivePath,
    archiveFormat: "zip"
  };
}

async function createTarArchive(bundleDirectory, destinationBasePath) {
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
}

async function createArchive(bundleDirectory, destinationBasePath, preferredFormat = null) {
  const archiveFormat = preferredFormat ?? (await detectArchiveFormat());

  if (archiveFormat === "zip") {
    return createZipArchive(bundleDirectory, destinationBasePath);
  }

  if (archiveFormat === "tar.gz") {
    return createTarArchive(bundleDirectory, destinationBasePath);
  }

  return {
    archivePath: null,
    archiveFormat: "directory"
  };
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
  const patchNotesPath = path.join(metadataDirectory, "patch-notes.md");
  const validationResultsPath = path.join(metadataDirectory, "validation-results.json");
  const sourceFileListPath = path.join(metadataDirectory, "source-file-list.txt");
  const topLevelEntries = await readdir(bundleSourceDirectory);

  await writeGitArtifacts(metadataDirectory, gitMetadata);
  await writeFile(reviewPromptPath, `${renderReviewPrompt()}\n`, "utf8");
  const canonicalValidationResults = await readOptionalJson(
    path.join(resolvedSourceDir, "reports", "validation-results.json")
  );
  const validationResults = isCanonicalValidationResultsArtifact(canonicalValidationResults)
    ? rewriteValidationResultsForBundle(canonicalValidationResults, resolvedSourceDir)
    : buildValidationResultsArtifact(effectiveBundleName, evidenceSummary);
  await writeJson(validationResultsPath, validationResults);

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
      validationResultsPath: "metadata/validation-results.json",
      patchNotesPath: "metadata/patch-notes.md",
      gitStatusPath: gitMetadata ? "metadata/git-status.txt" : null,
      gitLogPath: gitMetadata ? "metadata/git-log.txt" : null,
      gitRemotesPath: gitMetadata ? "metadata/git-remotes.txt" : null
    }
  };

  const writeBundleMetadata = async (manifest) => {
    await writeJson(manifestPath, manifest);
    await writeFile(reviewBriefPath, `${renderReviewBrief(manifest)}\n`, "utf8");
    await writeFile(patchNotesPath, `${renderPatchNotes(manifest)}\n`, "utf8");
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
  let plannedArchiveFormat = "directory";

  if (archive) {
    plannedArchiveFormat = await detectArchiveFormat();
    archiveResult =
      plannedArchiveFormat === "directory"
        ? {
            archivePath: null,
            archiveFormat: "directory"
          }
        : {
            archivePath: `${bundleDirectory}.${plannedArchiveFormat === "zip" ? "zip" : "tar.gz"}`,
            archiveFormat: plannedArchiveFormat
          };
  }

  let finalManifest = buildManifest(
    archiveResult.archiveFormat === "directory"
      ? {
          format: "directory",
          path: null
        }
      : {
          format: archiveResult.archiveFormat,
          path: safePathLabel(path.relative(bundleDirectory, archiveResult.archivePath))
        }
  );

  await writeBundleMetadata(finalManifest);

  if (archive && archiveResult.archiveFormat !== "directory") {
    try {
      archiveResult = await createArchive(bundleDirectory, bundleDirectory, plannedArchiveFormat);
    } catch {
      archiveResult = {
        archivePath: null,
        archiveFormat: "directory"
      };
      finalManifest = buildManifest({
        format: "directory",
        path: null
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
    patchNotesPath,
    validationResultsPath,
    archivePath: archiveResult.archivePath,
    archiveFormat: archiveResult.archiveFormat,
    fileCount: copiedFiles.length
  };
}
