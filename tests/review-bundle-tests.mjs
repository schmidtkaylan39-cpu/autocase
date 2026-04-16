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

async function main() {
  await runTest("review bundle creates manifest, brief, and filtered repo snapshot", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-review-bundle-"));
    const sourceDir = path.join(tempRoot, "source");
    const outputDir = path.join(tempRoot, "output");

    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await mkdir(path.join(sourceDir, "docs"), { recursive: true });
    await mkdir(path.join(sourceDir, "reports"), { recursive: true });
    await mkdir(path.join(sourceDir, "runs", "demo-run"), { recursive: true });
    await mkdir(path.join(sourceDir, ".git"), { recursive: true });
    await mkdir(path.join(sourceDir, "node_modules", "left-pad"), { recursive: true });
    await mkdir(path.join(sourceDir, "review-bundles", "old-bundle"), { recursive: true });

    await writeJson(path.join(sourceDir, "package.json"), {
      name: "bundle-fixture",
      version: "1.2.3"
    });
    await writeFile(path.join(sourceDir, "README.md"), "# Fixture\n", "utf8");
    await writeFile(path.join(sourceDir, "src", "index.mjs"), "export const demo = true;\n", "utf8");
    await writeFile(path.join(sourceDir, "docs", "notes.md"), "notes\n", "utf8");
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
    await stat(path.join(result.metadataDirectory, "source-file-list.txt"));

    await stat(path.join(result.bundleSourceDirectory, "README.md"));
    await stat(path.join(result.bundleSourceDirectory, "src", "index.mjs"));
    await stat(path.join(result.bundleSourceDirectory, "reports", "runtime-doctor.json"));
    await stat(path.join(result.bundleSourceDirectory, "runs", "demo-run", "run-state.json"));
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
    const sourceFileList = await readFile(path.join(result.metadataDirectory, "source-file-list.txt"), "utf8");
    const bundleFiles = await listRelativeFiles(result.bundleDirectory);

    assert.equal(manifest.package.name, "bundle-fixture");
    assert.equal(manifest.package.version, "1.2.3");
    assert.equal(manifest.archive.format, "directory");
    assert.equal(manifest.paths.patchNotesPath, "metadata/patch-notes.md");
    assert.equal(manifest.paths.reviewPromptPath, "metadata/external-ai-review-prompt.md");
    assert.equal(manifest.evidence.qualityBurnin.roundsPassed, 2);
    assert.equal(manifest.evidence.runs[0]?.runId, "demo-run");
    assert.match(reviewBrief, /External AI Review Brief/);
    assert.match(reviewPrompt, /External AI Review Prompt/);
    assert.match(reviewPrompt, /metadata\/patch-notes\.md/);
    assert.match(reviewPrompt, /repo\/docs\/dispatch\.md/);
    assert.match(reviewPrompt, /repo\/docs\/runtime-doctor\.md/);
    assert.match(reviewPrompt, /State-transition correctness/);
    assert.match(reviewBrief, /repo\/src\/lib\/dispatch\.mjs/);
    assert.match(reviewBrief, /metadata\/patch-notes\.md/);
    assert.match(patchNotes, /# Patch Notes/);
    assert.match(patchNotes, /Included Review Context/);
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
    await writeJson(path.join(sourceDir, "package.json"), {
      name: "bundle-archive-fixture",
      version: "9.9.9"
    });
    await writeFile(path.join(sourceDir, "README.md"), "# Archive Fixture\n", "utf8");
    await writeFile(path.join(sourceDir, "src", "index.mjs"), "export const archive = true;\n", "utf8");

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
      const manifestEntry = zipEntries.find((entry) => entry.name.endsWith("/metadata/bundle-manifest.json"));
      const briefEntry = zipEntries.find((entry) =>
        entry.name.endsWith("/metadata/external-ai-review-brief.md")
      );
      const patchNotesEntry = zipEntries.find((entry) => entry.name.endsWith("/metadata/patch-notes.md"));

      assert.ok(manifestEntry);
      assert.ok(briefEntry);
      assert.ok(patchNotesEntry);
      assert.ok(zipEntries.every((entry) => !entry.name.includes("\\")));

      const archivedManifest = JSON.parse(manifestEntry.text);
      assert.equal(archivedManifest.archive.format, "zip");
      assert.equal(archivedManifest.paths.patchNotesPath, "metadata/patch-notes.md");
      assert.ok(typeof archivedManifest.archive.path === "string" && archivedManifest.archive.path.length > 0);
      assert.match(briefEntry.text, /Archive:\s+(?!directory only).+/i);
      assert.match(patchNotesEntry.text, /# Patch Notes/);
    }
  });

  console.log("Review bundle tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
