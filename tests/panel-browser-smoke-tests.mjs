import assert from "node:assert/strict";
import path from "node:path";

import {
  buildBrowserRunConsistencyVerification,
  buildMaxRoundsPreparationEvidence,
  buildPageReadinessEvidence,
  buildStatusPillCompletionVerification,
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
    assert.equal(candidates.every((candidate) => !candidate.includes("/")), true);
  });

  await runTest("panel browser smoke uses deterministic Windows fallback paths off-host", async () => {
    const candidates = listCandidateBrowserPaths("win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)"
    });

    assert.equal(
      candidates.includes("C:\\Users\\Default\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
      true
    );
    assert.equal(candidates.every((candidate) => !candidate.includes("/")), true);
    assert.equal(candidates.every((candidate) => !candidate.startsWith("\\home\\")), true);
  });

  await runTest("panel browser smoke requires matching completed evidence in strict mode", async () => {
    const verification = buildBrowserRunConsistencyVerification({
      runId: "panel-browser-001",
      statusAfter: {
        overview: {
          latestRun: {
            summary: {
              runId: "panel-browser-001",
              status: "completed"
            }
          }
        }
      },
      runState: {
        runId: "panel-browser-001",
        status: "completed"
      },
      autonomousSummary: {
        runId: "panel-browser-001",
        finalStatus: "completed"
      },
      requireCompleted: true
    });

    assert.equal(verification.passed, true);
    assert.equal(verification.checks.every((check) => check.passed), true);
  });

  await runTest("panel browser smoke fails closed when autonomous summary is missing in strict mode", async () => {
    const verification = buildBrowserRunConsistencyVerification({
      runId: "panel-browser-002",
      statusAfter: {
        overview: {
          latestRun: {
            summary: {
              runId: "panel-browser-002",
              status: "completed"
            }
          }
        }
      },
      runState: {
        runId: "panel-browser-002",
        status: "completed"
      },
      autonomousSummary: null,
      requireCompleted: true
    });

    assert.equal(verification.passed, false);
    assert.equal(
      verification.checks.some((check) => check.id === "autonomous-summary-exists" && check.passed === false),
      true
    );
  });

  await runTest("panel browser smoke treats completed status pills as terminal in strict mode", async () => {
    const verification = buildStatusPillCompletionVerification("需求狀態：已建立 | 執行狀態：已完成");

    assert.equal(verification.passed, true);
    assert.deepEqual(verification.matchedCompletedMarkers, ["已完成"]);
    assert.deepEqual(verification.matchedIncompleteMarkers, []);
  });

  await runTest("panel browser smoke rejects stale status pills after backend completion", async () => {
    const verification = buildStatusPillCompletionVerification("需求狀態：已建立 | 執行狀態：等待重試");

    assert.equal(verification.passed, false);
    assert.equal(verification.matchedIncompleteMarkers.includes("等待重試"), true);
  });

  await runTest("panel browser smoke captures page maxRounds defaults before harness overrides", async () => {
    const evidence = buildMaxRoundsPreparationEvidence({
      pageDefaultMaxRounds: "8",
      preparedMaxRounds: "20",
      requestedMaxRounds: "20"
    });

    assert.equal(evidence.capturedPageDefault, true);
    assert.equal(evidence.overrideApplied, true);
    assert.equal(evidence.pageDefaultMaxRounds, "8");
    assert.equal(evidence.preparedMaxRounds, "20");
    assert.equal(evidence.requestedMaxRounds, "20");
  });

  await runTest("panel browser smoke preserves initial page readiness in summary and base artifact", async () => {
    const initialPageReadiness = {
      readyState: "complete",
      statusPillText: "進行中",
      logBoxText: "Waiting for quick start"
    };
    const finalPageReadiness = {
      readyState: "complete",
      statusPillText: "已完成",
      logBoxText: "Quick start completed"
    };
    const evidence = buildPageReadinessEvidence({
      initialPageReadiness,
      finalPageReadiness
    });

    assert.deepEqual(evidence.pageReadiness, initialPageReadiness);
    assert.deepEqual(evidence.finalPageReadiness, finalPageReadiness);
    assert.deepEqual(
      evidence.artifacts.map((artifact) => artifact.fileName),
      ["page-readiness.json", "page-readiness.initial.json", "page-readiness.final.json"]
    );
    assert.equal(
      evidence.artifacts.find((artifact) => artifact.fileName === "page-readiness.json")?.value?.statusPillText,
      "進行中"
    );
    assert.equal(
      evidence.artifacts.find((artifact) => artifact.fileName === "page-readiness.final.json")?.value?.statusPillText,
      "已完成"
    );
  });

  await runTest("panel browser smoke does not backfill final readiness into the initial summary slot", async () => {
    const finalPageReadiness = {
      readyState: "complete",
      statusPillText: "已完成",
      logBoxText: "Quick start completed"
    };
    const evidence = buildPageReadinessEvidence({
      initialPageReadiness: null,
      finalPageReadiness
    });

    assert.equal(evidence.pageReadiness, null);
    assert.deepEqual(evidence.finalPageReadiness, finalPageReadiness);
    assert.deepEqual(
      evidence.artifacts.map((artifact) => artifact.fileName),
      ["page-readiness.final.json"]
    );
  });

  console.log("Panel browser smoke tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
