import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    const sourceFileList = await readFile(path.join(result.metadataDirectory, "source-file-list.txt"), "utf8");

    assert.equal(manifest.package.name, "bundle-fixture");
    assert.equal(manifest.package.version, "1.2.3");
    assert.equal(manifest.archive.format, "directory");
    assert.equal(manifest.evidence.qualityBurnin.roundsPassed, 2);
    assert.equal(manifest.evidence.runs[0]?.runId, "demo-run");
    assert.match(reviewBrief, /External AI Review Brief/);
    assert.match(reviewBrief, /repo\/src\/lib\/dispatch\.mjs/);
    assert.match(sourceFileList, /repo\/README\.md/);
    assert.match(sourceFileList, /repo\/src\/index\.mjs/);
    assert.doesNotMatch(sourceFileList, /node_modules/);
    assert.doesNotMatch(sourceFileList, /review-bundles\/old-bundle/);
    assert.equal(result.archivePath, null);
  });

  console.log("Review bundle tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
