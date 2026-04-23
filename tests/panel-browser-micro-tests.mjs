import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runPanelBrowserMicroCheck } from "../scripts/panel-browser-micro-check.mjs";

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
  await runTest("panel browser micro check exercises page helpers and UI log capture in a real browser when available", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-browser-micro-test-"));

    try {
      const summary = await runPanelBrowserMicroCheck({
        outputRoot,
        headless: true,
        requireBrowser: false,
        browserStartupMs: 15_000
      });

      if (summary.skipped) {
        assert.equal(summary.harnessPassed, true);
        assert.match(String(summary.error ?? ""), /browser executable was not found/i);
        return;
      }

      assert.equal(summary.harnessPassed, true);
      assert.equal(summary.feasibleNow, true);
      assert.equal(summary.pageReadiness?.callApiType, "function");
      assert.equal(summary.pageReadiness?.hasHorizontalOverflow, false);
      assert.equal(summary.uiState?.hasHorizontalOverflow, false);
      assert.equal(summary.helperState?.renderHumanStatusCardType, "function");
      assert.match(String(summary.uiState?.assistantMirrorText ?? ""), /我幫你整理成這樣|我理解的是/);
      assert.match(String(summary.uiState?.humanStatusText ?? ""), /面板操作/);
      assert.match(String(summary.uiState?.latestLogEntryText ?? ""), /Quick start completed/);
      assert.equal(
        summary.checks.every((check) => check.passed),
        true
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  console.log("Panel browser micro tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
