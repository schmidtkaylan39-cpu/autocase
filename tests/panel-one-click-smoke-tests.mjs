import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isMainModule,
  parseArgs,
  verifyGeneratedSummaryArtifact
} from "../scripts/panel-one-click-smoke.mjs";

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
  await runTest("panel one-click smoke stays import-safe for focused tests", async () => {
    assert.equal(isMainModule(), false);
  });

  await runTest("panel one-click smoke parses harness options", async () => {
    const options = parseArgs([
      "--output-root",
      "tmp/panel-one-click-smoke-tests",
      "--watchdog-ms",
      "1234",
      "--poll-interval-ms",
      "250",
      "--max-rounds",
      "2",
      "--request-file",
      "docs/request.txt"
    ]);

    assert.equal(options.outputRoot.endsWith(path.join("tmp", "panel-one-click-smoke-tests")), true);
    assert.equal(options.watchdogMs, 1234);
    assert.equal(options.pollIntervalMs, 250);
    assert.equal(options.maxRounds, 2);
    assert.equal(options.requestFile.endsWith(path.join("docs", "request.txt")), true);
    assert.equal(options.requestText, null);
  });

  await runTest("panel one-click smoke verifies generated summary requirements", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-one-click-smoke-"));
    const generatedDirectory = path.join(workspaceRoot, "artifacts", "generated");

    await mkdir(generatedDirectory, { recursive: true });
    await writeFile(
      path.join(generatedDirectory, "summary.md"),
      [
        "# Combined Notes",
        "",
        "Brief token: BRIEF-PANEL-SMOKE-20260421-A",
        "Details token: DETAIL-PANEL-SMOKE-20260421-B",
        "",
        "\u4e2d\u6587\u6458\u8981\uff1a\u5df2\u6574\u5408\u4e24\u4e2a\u672c\u5730\u8f93\u5165\u6587\u4ef6\u3002"
      ].join("\n"),
      "utf8"
    );

    const verification = await verifyGeneratedSummaryArtifact(workspaceRoot);

    assert.equal(verification.passed, true);
    assert.equal(verification.checks.every((check) => check.passed), true);
  });

  await runTest("panel one-click smoke reports missing generated summary", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-one-click-smoke-missing-"));
    const verification = await verifyGeneratedSummaryArtifact(workspaceRoot);

    assert.equal(verification.passed, false);
    assert.equal(verification.checks[0]?.id, "summary-exists");
    assert.equal(verification.checks[0]?.passed, false);
  });

  console.log("Panel one-click smoke tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
