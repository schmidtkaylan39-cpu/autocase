import assert from "node:assert/strict";
import path from "node:path";

import {
  extractConfirmationTokenFromPrompt,
  isMainModule,
  listCandidateBrowserPaths,
  parseArgs
} from "../scripts/panel-browser-smoke.mjs";

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
  await runTest("panel browser smoke stays import-safe for focused tests", async () => {
    assert.equal(isMainModule(), false);
  });

  await runTest("panel browser smoke parses headed mode and maxRounds=0", async () => {
    const options = parseArgs([
      "--output-root",
      "tmp/panel-browser-smoke-tests",
      "--browser",
      "C:\\Browsers\\chrome.exe",
      "--browser-startup-ms",
      "3210",
      "--watchdog-ms",
      "6543",
      "--poll-interval-ms",
      "777",
      "--max-rounds",
      "0",
      "--request-file",
      "docs/request.txt",
      "--headed",
      "--require-completed"
    ]);

    assert.equal(options.outputRoot.endsWith(path.join("tmp", "panel-browser-smoke-tests")), true);
    assert.equal(options.browserPath, path.resolve("C:\\Browsers\\chrome.exe"));
    assert.equal(options.browserStartupMs, 3210);
    assert.equal(options.watchdogMs, 6543);
    assert.equal(options.pollIntervalMs, 777);
    assert.equal(options.maxRounds, 0);
    assert.equal(options.requestFile.endsWith(path.join("docs", "request.txt")), true);
    assert.equal(options.requestText, null);
    assert.equal(options.headless, false);
    assert.equal(options.requireCompleted, true);
  });

  await runTest("panel browser smoke extracts the confirmation token from prompt text", async () => {
    const promptText = [
      "Please review this before execution.",
      "",
      "Start: Local workspace already contains the input files.",
      "End: Create artifacts/generated/summary.md.",
      "",
      "Type exactly: 我確認起點與終點"
    ].join("\n");

    assert.equal(extractConfirmationTokenFromPrompt(promptText), "我確認起點與終點");
  });

  await runTest("panel browser smoke exposes Windows Chrome and Edge candidates", async () => {
    const candidates = listCandidateBrowserPaths("win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LocalAppData: "C:\\Users\\Tester\\AppData\\Local"
    });

    assert.equal(
      candidates.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
      true
    );
    assert.equal(
      candidates.includes("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"),
      true
    );
  });

  console.log("Panel browser smoke tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
