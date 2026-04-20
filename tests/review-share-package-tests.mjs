import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createReviewSharePackage } from "../scripts/review-share-package.mjs";
import { readZipEntriesFromFile } from "../src/lib/zip-archive.mjs";

async function writeJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

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
  await runTest("review share package rejects implicit acceptance summary selection", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-review-share-reject-"));
    const bundleDir = path.join(tempDir, "review-bundles", "review-bundle-20260420-142916-ab977ce");
    const metadataDir = path.join(bundleDir, "metadata");
    const acceptanceDir = path.join(tempDir, "reports", "acceptance", "live-roundtrip-20260420-165237");
    const bundleZipPath = `${bundleDir}.zip`;

    await mkdir(metadataDir, { recursive: true });
    await mkdir(acceptanceDir, { recursive: true });
    await writeJson(path.join(metadataDir, "bundle-manifest.json"), {
      bundleName: "review-bundle-20260420-142916-ab977ce",
      git: {
        head: "ab977ce1234567890",
        shortHead: "ab977ce",
        clean: true
      }
    });
    await writeFile(path.join(metadataDir, "external-ai-review-prompt.md"), "# prompt\n", "utf8");
    await writeFile(path.join(metadataDir, "external-ai-review-brief.md"), "# brief\n", "utf8");
    await writeFile(bundleZipPath, "fake zip\n", "utf8");
    await writeJson(path.join(acceptanceDir, "acceptance-summary.json"), {
      status: "passed"
    });

    await assert.rejects(
      () =>
        createReviewSharePackage({
          bundleDir,
          outputDir: path.join(tempDir, "review-bundles"),
          packageName: "gpt-review-share-test",
          archive: false
        }),
      /Acceptance summary must be provided explicitly/i
    );
  });

  await runTest("review share package keeps bundle and acceptance evidence from one snapshot", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-review-share-"));
    const bundleDir = path.join(tempDir, "review-bundles", "review-bundle-20260420-142916-ab977ce");
    const metadataDir = path.join(bundleDir, "metadata");
    const acceptanceDir = path.join(tempDir, "reports", "acceptance", "live-roundtrip-20260420-141301");
    const bundleZipPath = `${bundleDir}.zip`;

    await mkdir(metadataDir, { recursive: true });
    await mkdir(acceptanceDir, { recursive: true });
    await writeJson(path.join(metadataDir, "bundle-manifest.json"), {
      bundleName: "review-bundle-20260420-142916-ab977ce",
      git: {
        head: "ab977ce1234567890",
        shortHead: "ab977ce",
        clean: true
      }
    });
    await writeFile(path.join(metadataDir, "external-ai-review-prompt.md"), "# prompt\n", "utf8");
    await writeFile(path.join(metadataDir, "external-ai-review-brief.md"), "# brief\n", "utf8");
    await writeJson(path.join(metadataDir, "validation-results.json"), {
      results: []
    });
    await writeFile(bundleZipPath, "fake zip\n", "utf8");
    await writeJson(path.join(acceptanceDir, "acceptance-summary.json"), {
      status: "passed",
      achievedSuccesses: 1,
      requiredSuccesses: 1
    });
    await writeFile(path.join(acceptanceDir, "acceptance-summary.md"), "# acceptance\n", "utf8");

    const result = await createReviewSharePackage({
      bundleDir,
      acceptanceSummaryPath: path.join(acceptanceDir, "acceptance-summary.json"),
      outputDir: path.join(tempDir, "review-bundles"),
      packageName: "gpt-review-share-test",
      archive: false
    });

    const shareManifest = JSON.parse(await readFile(result.shareManifestPath, "utf8"));
    const copiedAcceptanceSummary = JSON.parse(await readFile(result.acceptanceSummaryOutputPath, "utf8"));
    const copiedPrompt = await readFile(
      path.join(result.packageDirectory, "bundle", "external-ai-review-prompt.md"),
      "utf8"
    );
    const copiedBundleZip = await readFile(result.bundleZipOutputPath, "utf8");

    assert.equal(shareManifest.bundleName, "review-bundle-20260420-142916-ab977ce");
    assert.equal(shareManifest.shortCommit, "ab977ce");
    assert.ok(shareManifest.sourcePaths.bundleDirectory.endsWith("/review-bundle-20260420-142916-ab977ce"));
    assert.ok(
      shareManifest.sourcePaths.acceptanceSummaryPath.endsWith(
        "/reports/acceptance/live-roundtrip-20260420-141301/acceptance-summary.json"
      )
    );
    assert.equal(copiedAcceptanceSummary.status, "passed");
    assert.equal(copiedPrompt.trim(), "# prompt");
    assert.equal(copiedBundleZip.trim(), "fake zip");
    assert.equal(result.archivePath, null);
  });

  await runTest("review share package archives keep portable ZIP entry names", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-review-share-archive-"));
    const bundleDir = path.join(tempDir, "review-bundles", "review-bundle-20260420-142916-ab977ce");
    const metadataDir = path.join(bundleDir, "metadata");
    const acceptanceDir = path.join(tempDir, "reports", "acceptance", "live-roundtrip-20260420-141301");
    const bundleZipPath = `${bundleDir}.zip`;

    await mkdir(metadataDir, { recursive: true });
    await mkdir(acceptanceDir, { recursive: true });
    await writeJson(path.join(metadataDir, "bundle-manifest.json"), {
      bundleName: "review-bundle-20260420-142916-ab977ce",
      git: {
        head: "ab977ce1234567890",
        shortHead: "ab977ce",
        clean: true
      }
    });
    await writeFile(path.join(metadataDir, "external-ai-review-prompt.md"), "# prompt\n", "utf8");
    await writeFile(path.join(metadataDir, "external-ai-review-brief.md"), "# brief\n", "utf8");
    await writeJson(path.join(metadataDir, "validation-results.json"), {
      results: []
    });
    await writeFile(bundleZipPath, "fake zip\n", "utf8");
    await writeJson(path.join(acceptanceDir, "acceptance-summary.json"), {
      status: "passed",
      achievedSuccesses: 1,
      requiredSuccesses: 1
    });
    await writeFile(path.join(acceptanceDir, "acceptance-summary.md"), "# acceptance\n", "utf8");

    const result = await createReviewSharePackage({
      bundleDir,
      acceptanceSummaryPath: path.join(acceptanceDir, "acceptance-summary.json"),
      outputDir: path.join(tempDir, "review-bundles"),
      packageName: "gpt-review-share-archive",
      archive: true
    });
    const zipEntries = await readZipEntriesFromFile(result.archivePath);

    assert.ok(zipEntries.some((entry) => entry.name === "gpt-review-share-archive/README.md"));
    assert.ok(
      zipEntries.some((entry) => entry.name === "gpt-review-share-archive/acceptance/acceptance-summary.json")
    );
    assert.ok(zipEntries.every((entry) => !entry.name.includes("\\")));
  });

  console.log("Review share package tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
