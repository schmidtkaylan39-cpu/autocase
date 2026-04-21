import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGptDebugSharePackage,
  extractNodeScriptTargets,
  validateMirroredRepoSurface
} from "../scripts/gpt-debug-share-package.mjs";
import { readZipEntriesFromFile } from "../src/lib/zip-archive.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeJson(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toPortablePath(targetPath) {
  return targetPath.replace(/\\/g, "/");
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
  await runTest("gpt debug share package extracts node script targets from package metadata", async () => {
    const targets = extractNodeScriptTargets({
      scripts: {
        test: "node tests/all-tests.mjs",
        smoke: "node scripts/panel-browser-smoke.mjs --require-completed",
        chain: "node src/index.mjs doctor"
      }
    });

    assert.deepEqual(targets, [
      "scripts/panel-browser-smoke.mjs",
      "src/index.mjs",
      "tests/all-tests.mjs"
    ]);
  });

  await runTest("gpt debug share package mirrors a self-consistent outer repo surface", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-gpt-debug-share-"));
    const bundleDir = path.join(tempDir, "review-bundles", "review-bundle-test");
    const metadataDir = path.join(bundleDir, "metadata");
    const panelSummaryPath = path.join(tempDir, "reports", "panel-smoke", "panel-one-click-test", "panel-smoke-summary.json");
    const browserSummaryPath = path.join(tempDir, "tmp", "panel-browser-smoke-run-full-test", "panel-browser-smoke-test", "panel-browser-smoke-summary.json");
    const promptPath = path.join(tempDir, "reports", "gpt-debug", "prompt.md");

    await mkdir(metadataDir, { recursive: true });
    await writeJson(path.join(metadataDir, "bundle-manifest.json"), {
      git: {
        branch: "codex/test-share-package",
        shortHead: "abc1234"
      }
    });
    await writeFile(path.join(metadataDir, "external-ai-review-brief.md"), "# brief\n", "utf8");
    await writeJson(path.join(tempDir, "reports", "validation-results.json"), {
      results: []
    });
    await writeJson(panelSummaryPath, {
      finalRunStatus: "completed"
    });
    await writeJson(browserSummaryPath, {
      finalRunStatus: "completed"
    });
    await mkdir(path.dirname(promptPath), { recursive: true });
    await writeFile(promptPath, "# prompt\n", "utf8");

    const result = await createGptDebugSharePackage({
      sourceDir: projectRoot,
      outputDir: path.join(tempDir, "out"),
      bundleDir,
      panelSummaryPath,
      browserSummaryPath,
      promptPath,
      packageName: "gpt-debug-share-test",
      archive: true
    });

    const validation = await validateMirroredRepoSurface(result.repoDirectory);
    const mirroredPackageJson = JSON.parse(await readFile(path.join(result.repoDirectory, "package.json"), "utf8"));
    const shareManifest = JSON.parse(await readFile(result.shareManifestPath, "utf8"));
    const promptText = await readFile(result.promptPath, "utf8");
    const zipEntries = await readZipEntriesFromFile(result.archivePath);
    const panelSummaryCopyPath = path.join(
      result.packageDirectory,
      "acceptance",
      "panel-smoke",
      "panel-one-click-test",
      "panel-smoke-summary.json"
    );
    const browserSummaryCopyPath = path.join(
      result.packageDirectory,
      "acceptance",
      "browser-smoke",
      "panel-browser-smoke-test",
      "panel-browser-smoke-summary.json"
    );

    assert.ok(validation.panelModulePath.endsWith(path.join("src", "lib", "panel.mjs")));
    assert.ok(validation.browserSmokeScriptPath.endsWith(path.join("scripts", "panel-browser-smoke.mjs")));

    for (const scriptTarget of extractNodeScriptTargets(mirroredPackageJson)) {
      const mirroredTargetPath = path.join(result.repoDirectory, scriptTarget);
      await readFile(mirroredTargetPath, "utf8");
    }

    assert.ok(await readFile(path.join(result.repoDirectory, "tests", "all-tests.mjs"), "utf8"));
    assert.deepEqual(shareManifest.includedEvidence, {
      panelSummaryDirectory: "acceptance/panel-smoke/panel-one-click-test",
      browserSummaryDirectory: "acceptance/browser-smoke/panel-browser-smoke-test"
    });
    assert.equal(shareManifest.basedOnBranch, "codex/test-share-package");
    assert.equal(
      toPortablePath(path.resolve(result.packageDirectory, shareManifest.includedEvidence.panelSummaryDirectory)),
      toPortablePath(path.dirname(panelSummaryCopyPath))
    );
    assert.equal(
      toPortablePath(path.resolve(result.packageDirectory, shareManifest.includedEvidence.browserSummaryDirectory)),
      toPortablePath(path.dirname(browserSummaryCopyPath))
    );
    assert.deepEqual(
      JSON.parse(await readFile(panelSummaryCopyPath, "utf8")),
      { finalRunStatus: "completed" }
    );
    assert.deepEqual(
      JSON.parse(await readFile(browserSummaryCopyPath, "utf8")),
      { finalRunStatus: "completed" }
    );
    assert.match(promptText, /acceptance\/panel-smoke\/panel-one-click-test\/panel-smoke-summary\.json/);
    assert.match(promptText, /acceptance\/browser-smoke\/panel-browser-smoke-test\/panel-browser-smoke-summary\.json/);
    assert.doesNotMatch(promptText, /repo\/reports\/panel-smoke\//);
    assert.doesNotMatch(promptText, /repo\/tmp\/panel-browser-smoke-run-full/);
    assert.ok(zipEntries.some((entry) => entry.name === "gpt-debug-share-test/repo/tests/all-tests.mjs"));
    assert.ok(zipEntries.some((entry) => entry.name === "gpt-debug-share-test/repo/src/lib/fs-utils.mjs"));
    assert.ok(zipEntries.some((entry) => entry.name === "gpt-debug-share-test/acceptance/panel-smoke/panel-one-click-test/panel-smoke-summary.json"));
    assert.ok(zipEntries.some((entry) => entry.name === "gpt-debug-share-test/acceptance/browser-smoke/panel-browser-smoke-test/panel-browser-smoke-summary.json"));
    assert.ok(zipEntries.every((entry) => !entry.name.includes("\\")));
  });

  console.log("GPT debug share package tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
