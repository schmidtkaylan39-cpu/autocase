import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { writeJson } from "../src/lib/fs-utils.mjs";
import { createReviewBundle } from "../src/lib/review-bundle.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function listRelativeFiles(rootDirectory, currentDirectory = rootDirectory) {
  const entries = await readdir(currentDirectory, {
    withFileTypes: true
  });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(rootDirectory, absolutePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(path.relative(rootDirectory, absolutePath).split(path.sep).join("/"));
    }
  }

  return files.sort();
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

  if (endOfCentralDirectoryOffset === -1) {
    throw new Error("ZIP end-of-central-directory record was not found.");
  }

  const centralDirectorySize = zipBuffer.readUInt32LE(endOfCentralDirectoryOffset + 12);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(endOfCentralDirectoryOffset + 16);
  const entries = [];
  let cursor = centralDirectoryOffset;

  while (cursor < centralDirectoryOffset + centralDirectorySize) {
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
    let content = compressedContent;

    if (entry.compressionMethod === 8) {
      content = inflateRawSync(compressedContent);
    } else if (entry.compressionMethod !== 0) {
      throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
    }

    return {
      name: entry.name,
      text: content.toString("utf8")
    };
  });
}

function isAbsoluteBundlePath(candidatePath) {
  return typeof candidatePath === "string" && (path.isAbsolute(candidatePath) || path.win32.isAbsolute(candidatePath));
}

function assertValidationResultsUseBundleSafePaths(validationResults) {
  assert.equal(validationResults.cwd, "repo");

  for (const result of validationResults.results) {
    const expectedEvidenceStrength =
      Array.isArray(result.evidence) && result.evidence.length > 0 ? "artifact" : "record-only";
    assert.equal(
      result.evidenceStrength,
      expectedEvidenceStrength,
      `Unexpected evidenceStrength for ${result.command}`
    );
    assert.equal(typeof result.evidenceSummary, "string");
    assert.ok(result.evidenceSummary.trim().length > 0);

    for (const evidencePath of Array.isArray(result.evidence) ? result.evidence : []) {
      assert.equal(isAbsoluteBundlePath(evidencePath), false, `Evidence path must be bundle-relative: ${evidencePath}`);
      assert.doesNotMatch(evidencePath, /^\.\.(?:\/|\\)/, `Evidence path must stay inside the bundle: ${evidencePath}`);
    }
  }
}

function assertExternalReviewerMetadataText(reviewBrief, reviewPrompt) {
  assert.match(
    reviewBrief,
    /metadata\/validation-results\.json.*carries `evidenceStrength` and `evidenceSummary` for each result/i
  );
  assert.match(
    reviewBrief,
    /self-check results retain per-command logs under `repo\/reports\/validation-evidence\/`/i
  );
  assert.match(
    reviewPrompt,
    /Treat `metadata\/validation-results\.json` as self-describing validation metadata: use each result's `evidenceStrength` and `evidenceSummary` fields/i
  );
  assert.match(
    reviewPrompt,
    /Canonical self-check bundles now retain a per-command log under `repo\/reports\/validation-evidence\/`/i
  );
  assert.match(
    reviewBrief,
    /if you want to rerun commands such as `npm test` or `npm run validate:workflows`, install devDependencies first with `npm ci` from `repo\/`/i
  );
  assert.match(
    reviewPrompt,
    /if you want to rerun repo-level validations from `repo\/`, run `npm ci` first so devDependencies are available/i
  );
}

async function assertBundleEvidencePathsExist(bundleDirectory, validationResults) {
  for (const result of validationResults.results) {
    for (const evidencePath of Array.isArray(result.evidence) ? result.evidence : []) {
      await stat(path.join(bundleDirectory, evidencePath));
    }
  }
}

function assertArchiveEvidencePathsExist(zipEntries, bundleRootName, validationResults) {
  for (const result of validationResults.results) {
    for (const evidencePath of Array.isArray(result.evidence) ? result.evidence : []) {
      assert.ok(
        zipEntries.some((entry) => entry.name === `${bundleRootName}/${evidencePath}`),
        `Missing archived evidence entry for ${evidencePath}`
      );
    }
  }
}

async function main() {
  await runTest("review bundle creates manifest, brief, and filtered repo snapshot", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-review-bundle-"));
    const sourceDir = path.join(tempRoot, "source");
    const outputDir = path.join(tempRoot, "output");

    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await mkdir(path.join(sourceDir, "docs"), { recursive: true });
    await mkdir(path.join(sourceDir, "prompts"), { recursive: true });
    await mkdir(path.join(sourceDir, "reports"), { recursive: true });
    await mkdir(path.join(sourceDir, "artifacts", "clarification"), { recursive: true });
    await mkdir(path.join(sourceDir, "runs", "demo-run"), { recursive: true });
    await mkdir(path.join(sourceDir, "templates"), { recursive: true });
    await mkdir(path.join(sourceDir, ".git"), { recursive: true });
    await mkdir(path.join(sourceDir, "node_modules", "left-pad"), { recursive: true });
    await mkdir(path.join(sourceDir, "review-bundles", "old-bundle"), { recursive: true });

    await writeJson(path.join(sourceDir, "package.json"), {
      name: "bundle-fixture",
      version: "1.2.3"
    });
    await writeFile(path.join(sourceDir, "AGENTS.md"), "# Fixture Agents\n", "utf8");
    await writeFile(path.join(sourceDir, "README.md"), "# Fixture\n", "utf8");
    await writeFile(path.join(sourceDir, "src", "index.mjs"), "export const demo = true;\n", "utf8");
    await writeJson(path.join(sourceDir, "artifacts", "clarification", "intake-spec.json"), {
      requestId: "fixture-request",
      title: "Fixture clarification",
      originalRequest: "Help me automate this report",
      clarifiedGoal: "Clarify the report automation scope before planning.",
      successCriteria: [
        {
          text: "A clear success definition is recorded before planning starts.",
          status: "defined"
        }
      ],
      nonGoals: ["Do not execute changes before confirmation."],
      inScope: ["Clarification artifacts"],
      outOfScope: ["Execution work"],
      requiredInputs: [],
      requiredAccountsAndPermissions: [],
      externalDependencies: [],
      constraints: [],
      risks: [],
      automationAssessment: {
        canFullyAutomate: false,
        automationLevel: "partial",
        estimatedAutomatablePercent: 25,
        humanStepsRequired: ["Confirm the clarified goal."],
        blockers: [],
        rationale: ["Human confirmation is required before planning."]
      },
      openQuestions: [],
      clarificationStatus: "confirmed",
      recommendedNextStep: "planning-ready",
      approvalRequired: false,
      confirmedByUser: true,
      lastUpdatedAt: "2026-04-16T00:00:00.000Z"
    });
    await writeFile(
      path.join(sourceDir, "artifacts", "clarification", "intake-summary.md"),
      "# Intake Summary\n",
      "utf8"
    );
    await writeFile(path.join(sourceDir, "docs", "notes.md"), "notes\n", "utf8");
    await writeFile(path.join(sourceDir, "docs", "artifact-contract.md"), "# Artifact Contract\n", "utf8");
    await writeFile(path.join(sourceDir, "docs", "handoffs.md"), "# Handoffs\n", "utf8");
    await writeFile(path.join(sourceDir, "docs", "proposal-contract.md"), "# Proposal Contract\n", "utf8");
    await writeFile(path.join(sourceDir, "docs", "failure-feedback.md"), "# Failure Feedback\n", "utf8");
    await writeFile(path.join(sourceDir, "prompts", "planner.md"), "# Planner Prompt\n", "utf8");
    await writeFile(path.join(sourceDir, "prompts", "reviewer.md"), "# Reviewer Prompt\n", "utf8");
    await writeFile(path.join(sourceDir, "prompts", "executor.md"), "# Executor Prompt\n", "utf8");
    await writeFile(path.join(sourceDir, "prompts", "verifier.md"), "# Verifier Prompt\n", "utf8");
    await writeFile(path.join(sourceDir, "prompts", "orchestrator.md"), "# Orchestrator Prompt\n", "utf8");
    await writeFile(path.join(sourceDir, "templates", "findings.template.md"), "# Findings\n", "utf8");
    await writeFile(path.join(sourceDir, "templates", "patch-notes.template.md"), "# Patch Notes\n", "utf8");
    await writeFile(path.join(sourceDir, "templates", "codex-prompt.template.md"), "# Codex Prompt\n", "utf8");
    await writeJson(path.join(sourceDir, "templates", "proposal-artifact.template.json"), {
      objective: "demo proposal"
    });
    await writeJson(path.join(sourceDir, "templates", "failure-feedback.template.json"), {
      category: "verification_failed"
    });
    await writeJson(path.join(sourceDir, "templates", "validation-results.template.json"), {
      results: []
    });
    await writeFile(path.join(sourceDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(path.join(sourceDir, "node_modules", "left-pad", "index.js"), "module.exports = {};\n", "utf8");
    await writeFile(path.join(sourceDir, "review-bundles", "old-bundle", "stale.txt"), "stale\n", "utf8");

    await writeJson(path.join(sourceDir, "reports", "runtime-doctor.json"), {
      checks: [
        { id: "openclaw", installed: true, ok: true },
        { id: "codex", installed: true, ok: true }
      ]
    });
    await writeJson(path.join(sourceDir, "reports", "release-burnin-summary.json"), {
      finishedAt: "2026-04-16T00:00:00.000Z",
      durationMs: 1234,
      config: {
        preset: "quality",
        roundsRequested: 2
      },
      totals: {
        roundsExecuted: 2,
        roundsPassed: 2,
        roundsFailed: 0,
        stepsFailed: 0
      }
    });
    await writeFile(path.join(sourceDir, "reports", "test-output.log"), "tests passed\n", "utf8");
    await mkdir(path.join(sourceDir, "reports", "validation-evidence"), { recursive: true });
    await writeFile(path.join(sourceDir, "reports", "validation-evidence", "build.log"), "build ok\n", "utf8");
    await writeFile(path.join(sourceDir, "reports", "validation-evidence", "test.log"), "test ok\n", "utf8");
    const canonicalValidationResults = {
      generatedAt: "2026-04-16T01:23:45.000Z",
      cwd: sourceDir,
      results: [
        {
          command: "npm run build",
          status: "passed",
          startedAt: "2026-04-16T01:00:00.000Z",
          finishedAt: "2026-04-16T01:00:02.000Z",
          durationMs: 2000,
          evidenceStrength: "artifact",
          evidenceSummary: "Includes a retained self-check command log.",
          evidence: ["reports/validation-evidence/build.log"]
        },
        {
          command: "npm test",
          status: "passed",
          startedAt: "2026-04-16T01:00:03.000Z",
          finishedAt: "2026-04-16T01:00:13.000Z",
          durationMs: 10000,
          evidenceStrength: "artifact",
          evidenceSummary: "Includes a retained self-check command log plus command-specific artifacts.",
          evidence: ["reports/validation-evidence/test.log", "reports/test-output.log"]
        }
      ]
    };
    const bundledValidationResults = {
      ...canonicalValidationResults,
      cwd: "repo",
      results: [
        {
          ...canonicalValidationResults.results[0],
          evidence: ["repo/reports/validation-evidence/build.log"]
        },
        {
          ...canonicalValidationResults.results[1],
          evidence: ["repo/reports/validation-evidence/test.log", "repo/reports/test-output.log"]
        }
      ]
    };
    await writeJson(path.join(sourceDir, "reports", "validation-results.json"), canonicalValidationResults);
    await writeJson(path.join(sourceDir, "runs", "demo-run", "run-state.json"), {
      runId: "demo-run",
      projectName: "Fixture Project",
      status: "in_progress",
      taskLedger: [
        { id: "planning-brief", status: "completed" },
        { id: "implement-one", status: "ready" },
        { id: "review-one", status: "pending" }
      ]
    });
    await writeFile(path.join(sourceDir, "runs", "demo-run", "report.md"), "# Demo Run\n", "utf8");

    const result = await createReviewBundle({
      sourceDir,
      outputDir,
      bundleName: "fixture-bundle",
      archive: false
    });

    await stat(result.bundleDirectory);
    await stat(result.bundleSourceDirectory);
    await stat(result.metadataDirectory);
    await stat(result.manifestPath);
    await stat(result.reviewBriefPath);
    await stat(result.reviewPromptPath);
    await stat(result.patchNotesPath);
    await stat(result.validationResultsPath);
    await stat(path.join(result.metadataDirectory, "source-file-list.txt"));

    await stat(path.join(result.bundleSourceDirectory, "AGENTS.md"));
    await stat(path.join(result.bundleSourceDirectory, "README.md"));
    await stat(path.join(result.bundleSourceDirectory, "src", "index.mjs"));
    await stat(path.join(result.bundleSourceDirectory, "artifacts", "clarification", "intake-spec.json"));
    await stat(path.join(result.bundleSourceDirectory, "artifacts", "clarification", "intake-summary.md"));
    await stat(path.join(result.bundleSourceDirectory, "reports", "runtime-doctor.json"));
    await stat(path.join(result.bundleSourceDirectory, "runs", "demo-run", "run-state.json"));
    await stat(path.join(result.bundleSourceDirectory, "docs", "artifact-contract.md"));
    await stat(path.join(result.bundleSourceDirectory, "prompts", "planner.md"));
    await stat(path.join(result.bundleSourceDirectory, "prompts", "reviewer.md"));
    await stat(path.join(result.bundleSourceDirectory, "prompts", "executor.md"));
    await stat(path.join(result.bundleSourceDirectory, "prompts", "verifier.md"));
    await stat(path.join(result.bundleSourceDirectory, "prompts", "orchestrator.md"));
    await stat(path.join(result.bundleSourceDirectory, "templates", "findings.template.md"));
    await stat(path.join(result.bundleSourceDirectory, "templates", "patch-notes.template.md"));
    await stat(path.join(result.bundleSourceDirectory, "templates", "codex-prompt.template.md"));
    await stat(path.join(result.bundleSourceDirectory, "templates", "proposal-artifact.template.json"));
    await stat(path.join(result.bundleSourceDirectory, "templates", "failure-feedback.template.json"));
    await stat(path.join(result.bundleSourceDirectory, "templates", "validation-results.template.json"));
    await assert.rejects(() => stat(path.join(result.bundleSourceDirectory, ".git", "HEAD")));
    await assert.rejects(
      () => stat(path.join(result.bundleSourceDirectory, "node_modules", "left-pad", "index.js"))
    );
    await assert.rejects(
      () => stat(path.join(result.bundleSourceDirectory, "review-bundles", "old-bundle", "stale.txt"))
    );

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const reviewBrief = await readFile(result.reviewBriefPath, "utf8");
    const reviewPrompt = await readFile(result.reviewPromptPath, "utf8");
    const patchNotes = await readFile(result.patchNotesPath, "utf8");
    const validationResults = JSON.parse(await readFile(result.validationResultsPath, "utf8"));
    const canonicalValidationResultsInBundle = JSON.parse(
      await readFile(path.join(result.bundleSourceDirectory, "reports", "validation-results.json"), "utf8")
    );
    const sourceFileList = await readFile(path.join(result.metadataDirectory, "source-file-list.txt"), "utf8");
    const bundleFiles = await listRelativeFiles(result.bundleDirectory);

    assert.equal(manifest.package.name, "bundle-fixture");
    assert.equal(manifest.package.version, "1.2.3");
    assert.equal(manifest.archive.format, "directory");
    assert.equal(manifest.paths.patchNotesPath, "metadata/patch-notes.md");
    assert.equal(manifest.paths.validationResultsPath, "metadata/validation-results.json");
    assert.equal(manifest.paths.reviewPromptPath, "metadata/external-ai-review-prompt.md");
    assert.equal(manifest.evidence.qualityBurnin.roundsPassed, 2);
    assert.equal(manifest.evidence.runs[0]?.runId, "demo-run");
    assert.match(reviewBrief, /External AI Review Brief/);
    assert.match(reviewPrompt, /External AI Review Prompt/);
    assert.match(reviewPrompt, /repo\/AGENTS\.md/);
    assert.match(reviewPrompt, /metadata\/validation-results\.json/);
    assert.match(reviewPrompt, /metadata\/patch-notes\.md/);
    assert.match(reviewPrompt, /repo\/docs\/dispatch\.md/);
    assert.match(reviewPrompt, /repo\/docs\/handoffs\.md/);
    assert.match(reviewPrompt, /repo\/docs\/artifact-contract\.md/);
    assert.match(reviewPrompt, /repo\/docs\/runtime-doctor\.md/);
    assert.match(reviewPrompt, /repo\/docs\/proposal-contract\.md/);
    assert.match(reviewPrompt, /repo\/docs\/failure-feedback\.md/);
    assert.match(reviewPrompt, /repo\/prompts\/planner\.md/);
    assert.match(reviewPrompt, /repo\/prompts\/reviewer\.md/);
    assert.match(reviewPrompt, /repo\/prompts\/executor\.md/);
    assert.match(reviewPrompt, /repo\/prompts\/verifier\.md/);
    assert.match(reviewPrompt, /repo\/prompts\/orchestrator\.md/);
    assert.match(reviewPrompt, /repo\/templates\/findings\.template\.md/);
    assert.match(reviewPrompt, /repo\/templates\/patch-notes\.template\.md/);
    assert.match(reviewPrompt, /repo\/templates\/codex-prompt\.template\.md/);
    assert.match(reviewPrompt, /repo\/templates\/proposal-artifact\.template\.json/);
    assert.match(reviewPrompt, /repo\/templates\/failure-feedback\.template\.json/);
    assert.match(reviewPrompt, /repo\/templates\/validation-results\.template\.json/);
    assert.match(reviewPrompt, /State-transition correctness/);
    assert.match(reviewBrief, /repo\/AGENTS\.md/);
    assert.match(reviewBrief, /repo\/src\/lib\/dispatch\.mjs/);
    assert.match(reviewBrief, /metadata\/validation-results\.json/);
    assert.match(reviewBrief, /metadata\/patch-notes\.md/);
    assert.match(reviewBrief, /repo\/docs\/handoffs\.md/);
    assert.match(reviewBrief, /repo\/docs\/artifact-contract\.md/);
    assert.match(reviewBrief, /repo\/prompts\/planner\.md/);
    assert.match(reviewBrief, /repo\/prompts\/reviewer\.md/);
    assert.match(reviewBrief, /repo\/prompts\/executor\.md/);
    assert.match(reviewBrief, /repo\/prompts\/verifier\.md/);
    assert.match(reviewBrief, /repo\/prompts\/orchestrator\.md/);
    assert.match(reviewBrief, /repo\/templates\/findings\.template\.md/);
    assert.match(reviewBrief, /repo\/templates\/patch-notes\.template\.md/);
    assert.match(reviewBrief, /repo\/templates\/codex-prompt\.template\.md/);
    assert.match(reviewBrief, /repo\/templates\/proposal-artifact\.template\.json/);
    assert.match(reviewBrief, /repo\/templates\/failure-feedback\.template\.json/);
    assert.match(reviewBrief, /repo\/templates\/validation-results\.template\.json/);
    assertExternalReviewerMetadataText(reviewBrief, reviewPrompt);
    assert.match(patchNotes, /# Patch Notes/);
    assert.match(patchNotes, /Included Review Context/);
    assert.deepEqual(validationResults, bundledValidationResults);
    assertValidationResultsUseBundleSafePaths(validationResults);
    assert.deepEqual(canonicalValidationResultsInBundle, canonicalValidationResults);
    await assertBundleEvidencePathsExist(result.bundleDirectory, validationResults);
    assert.match(sourceFileList, /metadata\/validation-results\.json/);
    assert.match(sourceFileList, /repo\/artifacts\/clarification\/intake-spec\.json/);
    assert.match(sourceFileList, /repo\/artifacts\/clarification\/intake-summary\.md/);
    assert.match(sourceFileList, /repo\/reports\/validation-results\.json/);
    assert.match(sourceFileList, /repo\/reports\/validation-evidence\/build\.log/);
    assert.match(sourceFileList, /repo\/reports\/validation-evidence\/test\.log/);
    assert.match(sourceFileList, /repo\/reports\/test-output\.log/);
    assert.match(sourceFileList, /repo\/README\.md/);
    assert.match(sourceFileList, /repo\/src\/index\.mjs/);
    assert.equal(manifest.inventory.fileCount, bundleFiles.length);
    assert.deepEqual(sourceFileList.trim().split(/\r?\n/).sort(), bundleFiles);
    assert.doesNotMatch(sourceFileList, /node_modules/);
    assert.doesNotMatch(sourceFileList, /review-bundles\/old-bundle/);
    assert.equal(result.archivePath, null);
  });

  await runTest("review bundle archive succeeds for Windows-style paths with spaces and symbols", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-review-bundle-archive-"));
    const sourceDir = path.join(tempRoot, "source $bundle & data");
    const outputDir = path.join(tempRoot, "output $bundle & data");

    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await mkdir(path.join(sourceDir, "reports"), { recursive: true });
    await writeJson(path.join(sourceDir, "package.json"), {
      name: "bundle-archive-fixture",
      version: "9.9.9"
    });
    await writeFile(path.join(sourceDir, "README.md"), "# Archive Fixture\n", "utf8");
    await writeFile(path.join(sourceDir, "src", "index.mjs"), "export const archive = true;\n", "utf8");
    await writeFile(path.join(sourceDir, "reports", "archive-proof.log"), "archive ok\n", "utf8");
    await writeJson(path.join(sourceDir, "reports", "validation-results.json"), {
      generatedAt: "2026-04-16T02:00:00.000Z",
      cwd: sourceDir,
      results: [
        {
          command: "npm test",
          status: "passed",
          startedAt: "2026-04-16T02:00:00.000Z",
          finishedAt: "2026-04-16T02:00:01.000Z",
          durationMs: 1000,
          evidenceStrength: "artifact",
          evidenceSummary: "Includes a retained self-check command log plus command-specific artifacts.",
          evidence: ["reports/validation-evidence/test.log", "reports/archive-proof.log"]
        }
      ]
    });
    await mkdir(path.join(sourceDir, "reports", "validation-evidence"), { recursive: true });
    await writeFile(path.join(sourceDir, "reports", "validation-evidence", "test.log"), "archive test ok\n", "utf8");

    const result = await createReviewBundle({
      sourceDir,
      outputDir,
      bundleName: "fixture archive $bundle & data",
      archive: true
    });

    assert.match(result.archiveFormat, /zip|tar\.gz/);
    assert.ok(typeof result.archivePath === "string" && result.archivePath.length > 0);
    await stat(result.archivePath);

    if (result.archiveFormat === "zip") {
      const zipEntries = parseZipEntries(await readFile(result.archivePath));
      const bundleRootName = path.basename(result.bundleDirectory);
      const manifestEntry = zipEntries.find((entry) => entry.name.endsWith("/metadata/bundle-manifest.json"));
      const briefEntry = zipEntries.find((entry) =>
        entry.name.endsWith("/metadata/external-ai-review-brief.md")
      );
      const patchNotesEntry = zipEntries.find((entry) => entry.name.endsWith("/metadata/patch-notes.md"));
      const validationResultsEntry = zipEntries.find((entry) =>
        entry.name.endsWith("/metadata/validation-results.json")
      );

      assert.ok(manifestEntry);
      assert.ok(briefEntry);
      assert.ok(patchNotesEntry);
      assert.ok(validationResultsEntry);
      assert.ok(zipEntries.every((entry) => !entry.name.includes("\\")));

      const archivedManifest = JSON.parse(manifestEntry.text);
      assert.equal(archivedManifest.archive.format, "zip");
      assert.equal(archivedManifest.paths.patchNotesPath, "metadata/patch-notes.md");
      assert.ok(typeof archivedManifest.archive.path === "string" && archivedManifest.archive.path.length > 0);
      assert.match(briefEntry.text, /Archive:\s+(?!directory only).+/i);
      assertExternalReviewerMetadataText(briefEntry.text, zipEntries.find((entry) =>
        entry.name.endsWith("/metadata/external-ai-review-prompt.md")
      )?.text ?? "");
      assert.match(patchNotesEntry.text, /# Patch Notes/);
      const archivedValidationResults = JSON.parse(validationResultsEntry.text);
      assert.ok(Array.isArray(archivedValidationResults.results));
      assertValidationResultsUseBundleSafePaths(archivedValidationResults);
      assert.deepEqual(archivedValidationResults.results[0]?.evidence, [
        "repo/reports/validation-evidence/test.log",
        "repo/reports/archive-proof.log"
      ]);
      assertArchiveEvidencePathsExist(zipEntries, bundleRootName, archivedValidationResults);
    }
  });

  await runTest("review bundle metadata stays reviewer-readable from the bundle root", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-review-bundle-metadata-"));
    const sourceDir = path.join(tempRoot, "source");
    const outputDir = path.join(tempRoot, "output");

    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await mkdir(path.join(sourceDir, "reports"), { recursive: true });
    await writeJson(path.join(sourceDir, "package.json"), {
      name: "bundle-metadata-fixture",
      version: "0.2.0"
    });
    await writeFile(path.join(sourceDir, "README.md"), "# Metadata Fixture\n", "utf8");
    await writeFile(path.join(sourceDir, "src", "index.mjs"), "export const metadata = true;\n", "utf8");
    await writeJson(path.join(sourceDir, "reports", "validation-results.json"), {
      generatedAt: "2026-04-16T03:00:00.000Z",
      cwd: sourceDir,
      results: [
        {
          command: "npm run doctor",
          status: "passed",
          startedAt: "2026-04-16T03:00:00.000Z",
          finishedAt: "2026-04-16T03:00:01.000Z",
          durationMs: 1000,
          evidenceStrength: "record-only",
          evidenceSummary: "No retained artifacts were captured; use status and timing metadata only.",
          evidence: []
        }
      ]
    });

    const result = await createReviewBundle({
      sourceDir,
      outputDir,
      bundleName: "fixture-metadata-view",
      archive: false
    });
    const bundleRoot = result.bundleDirectory;
    const reviewBrief = await readFile(path.join(bundleRoot, "metadata", "external-ai-review-brief.md"), "utf8");
    const reviewPrompt = await readFile(path.join(bundleRoot, "metadata", "external-ai-review-prompt.md"), "utf8");
    const validationResults = JSON.parse(
      await readFile(path.join(bundleRoot, "metadata", "validation-results.json"), "utf8")
    );

    assertExternalReviewerMetadataText(reviewBrief, reviewPrompt);
    assertValidationResultsUseBundleSafePaths(validationResults);
  });

  await runTest("review bundle falls back to directory metadata when archive creation fails", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-review-bundle-fallback-"));
    const sourceDir = path.join(tempRoot, "source");
    const outputDir = path.join(tempRoot, "output");
    const previousPowerShellCommand = process.env.AI_FACTORY_POWERSHELL_COMMAND;
    const previousPath = process.env.PATH;
    const missingBinDir = path.join(tempRoot, "missing-bin");

    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await mkdir(missingBinDir, { recursive: true });
    await writeJson(path.join(sourceDir, "package.json"), {
      name: "bundle-fallback-fixture",
      version: "0.0.1"
    });
    await writeFile(path.join(sourceDir, "README.md"), "# Fallback Fixture\n", "utf8");
    await writeFile(path.join(sourceDir, "src", "index.mjs"), "export const fallback = true;\n", "utf8");

    process.env.AI_FACTORY_POWERSHELL_COMMAND = "definitely-missing-powershell-for-test";
    process.env.PATH = missingBinDir;

    try {
      const result = await createReviewBundle({
        sourceDir,
        outputDir,
        bundleName: "fixture-fallback",
        archive: true
      });

      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
      const reviewBrief = await readFile(result.reviewBriefPath, "utf8");

      assert.equal(result.archiveFormat, "directory");
      assert.equal(result.archivePath, null);
      assert.equal(manifest.archive.format, "directory");
      assert.equal(manifest.archive.path, null);
      assert.match(reviewBrief, /Archive:\s+directory only/i);
      await assert.rejects(() => stat(path.join(outputDir, "fixture-fallback.zip")));
    } finally {
      if (previousPowerShellCommand === undefined) {
        delete process.env.AI_FACTORY_POWERSHELL_COMMAND;
      } else {
        process.env.AI_FACTORY_POWERSHELL_COMMAND = previousPowerShellCommand;
      }

      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  console.log("Review bundle tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
