import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReleasePublishEvidence,
  parseArgs,
  summarizeValidationResults
} from "../scripts/release-publish-evidence.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");
const evidencePath = path.join(projectRoot, "docs", "releases", "v0.1.1.evidence.json");

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function loadEvidence() {
  const text = await readFile(evidencePath, "utf8");
  return JSON.parse(text);
}

async function main() {
  await runTest("release evidence builder emits a coherent schema", async () => {
    const validationSummary = summarizeValidationResults(
      {
        results: [
          {
            command: "npm test",
            status: "passed",
            evidenceStrength: "artifact"
          }
        ]
      },
      "reports/validation-results.json"
    );

    const evidence = buildReleasePublishEvidence({
      tag: "v9.9.9",
      releaseUrl: "https://example.test/releases/tag/v9.9.9",
      publishedAt: "2026-04-18T03:36:02Z",
      timezone: "Asia/Shanghai",
      packageJson: {
        name: "ai-factory-starter",
        version: "9.9.9"
      },
      releaseManifestPath: "desktop/release-candidates/v9.9.9/release-manifest.json",
      releaseNotesPath: "docs/releases/v9.9.9.md",
      releaseManifest: {
        generatedAt: "2026-04-18T02:31:46.439Z",
        branch: "main",
        commit: "abc1234",
        nodeArchitecture: "x64",
        windowsTarget: "win-x64",
        releaseDirectoryName: "ai-factory-starter-win-x64-abc1234",
        releaseArchiveFileName: "ai-factory-starter-win-x64-abc1234.zip"
      },
      fullCommit: "abc1234567890def",
      validationSummary,
      assetRecords: [
        {
          name: "ai-factory-starter-win-x64-abc1234.zip",
          kind: "windows-release-zip",
          sizeBytes: 123,
          sha256: "a".repeat(64),
          downloadUrl: "https://example.test/releases/download/v9.9.9/ai-factory-starter-win-x64-abc1234.zip"
        }
      ],
      externalReviewerSummary: "No concrete bug found.",
      externalReviewerRerunChecks: ["npm ci", "npm test"]
    });

    assert.equal(evidence.schemaVersion, "1.0.0");
    assert.equal(evidence.release.version, "9.9.9");
    assert.equal(evidence.release.tag, "v9.9.9");
    assert.equal(evidence.release.commit, "abc1234");
    assert.equal(evidence.release.timezone, "Asia/Shanghai");
    assert.equal(evidence.provenance.sourceManifestPath, "desktop/release-candidates/v9.9.9/release-manifest.json");
    assert.equal(evidence.provenance.releaseNotesPath, "docs/releases/v9.9.9.md");
    assert.equal(evidence.validationSummary.sourceArtifactTrackedInRepo, true);
    assert.deepEqual(evidence.verification.localChecks, ["npm test", "npm run selfcheck"]);
    assert.deepEqual(evidence.verification.externalReviewerRerunChecks, ["npm ci", "npm test"]);
    assert.equal(evidence.verification.externalReviewerSummary, "No concrete bug found.");
    assert.match(evidence.rerunPrerequisite, /npm ci/i);
  });

  await runTest("release evidence cli parsing accepts reviewer metadata and assets", async () => {
    const options = parseArgs([
      "--tag",
      "v0.1.1",
      "--release-url",
      "https://github.com/example/releases/tag/v0.1.1",
      "--published-at",
      "2026-04-18T03:36:02Z",
      "--timezone",
      "Asia/Shanghai",
      "--release-manifest",
      "reports/release-manifest.json",
      "--external-reviewer-summary",
      "No concrete bug found.",
      "--external-reviewer-check",
      "npm ci",
      "--external-reviewer-check",
      "npm test",
      "--asset",
      "dist/release.zip::https://github.com/example/releases/download/v0.1.1/release.zip"
    ]);

    assert.equal(options.tag, "v0.1.1");
    assert.equal(options.timezone, "Asia/Shanghai");
    assert.equal(options.externalReviewerSummary, "No concrete bug found.");
    assert.deepEqual(options.externalReviewerChecks, ["npm ci", "npm test"]);
    assert.equal(options.assetEntries.length, 1);
    assert.match(options.outputPath, /docs[\\/]+releases[\\/]+v0\.1\.1\.evidence\.json$/);
  });

  await runTest("release evidence includes required release identity fields", async () => {
    const evidence = await loadEvidence();

    assert.equal(evidence.schemaVersion, "1.0.0");
    assert.equal(evidence.release.version, "0.1.1");
    assert.equal(evidence.release.tag, "v0.1.1");
    assert.equal(evidence.release.commit, "9201fe0");
    assert.match(evidence.release.releasedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(evidence.release.timezone, "Asia/Shanghai");
    assert.equal(
      evidence.release.releaseUrl,
      "https://github.com/schmidtkaylan39-cpu/autocase/releases/tag/v0.1.1"
    );
  });

  await runTest("release evidence asset metadata is complete and valid", async () => {
    const evidence = await loadEvidence();
    const requiredAssetNames = new Set([
      "ai-factory-starter-win-x64-9201fe0.zip",
      "ai-factory-starter-0.1.1.tgz",
      "release-manifest.json"
    ]);
    const seenAssetNames = new Set();

    assert.ok(Array.isArray(evidence.assets));
    assert.ok(evidence.assets.length >= requiredAssetNames.size);

    for (const asset of evidence.assets) {
      assert.equal(typeof asset.name, "string");
      assert.equal(typeof asset.downloadUrl, "string");
      assert.equal(typeof asset.sizeBytes, "number");
      assert.equal(typeof asset.sha256, "string");
      assert.ok(asset.sizeBytes > 0);
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      assert.match(
        asset.downloadUrl,
        /^https:\/\/github\.com\/schmidtkaylan39-cpu\/autocase\/releases\/download\/v0\.1\.1\//
      );
      assert.ok(!seenAssetNames.has(asset.name), `Duplicate asset name: ${asset.name}`);
      seenAssetNames.add(asset.name);
    }

    for (const assetName of requiredAssetNames) {
      assert.ok(seenAssetNames.has(assetName), `Missing required asset metadata: ${assetName}`);
    }
  });

  await runTest("release evidence includes verification and rerun prerequisite fields", async () => {
    const evidence = await loadEvidence();

    assert.ok(Array.isArray(evidence.verification.localChecks));
    assert.ok(Array.isArray(evidence.verification.externalReviewerRerunChecks));
    assert.ok(evidence.validationSummary);
    assert.equal(evidence.validationSummary.sourceArtifactPath, "reports/validation-results.json");
    assert.equal(evidence.validationSummary.sourceArtifactTrackedInRepo, true);
    assert.equal(evidence.validationSummary.allPassed, true);
    assert.ok(evidence.validationSummary.resultCount >= 1);
    assert.ok(evidence.verification.localChecks.includes("npm run selfcheck"));
    assert.ok(evidence.verification.externalReviewerRerunChecks.includes("npm ci"));
    assert.equal(typeof evidence.verification.externalReviewerSummary, "string");
    assert.equal(typeof evidence.rerunPrerequisite, "string");
    assert.match(evidence.rerunPrerequisite, /npm ci/i);
  });

  console.log("Release publish evidence tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
