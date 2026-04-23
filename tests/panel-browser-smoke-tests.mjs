import assert from "node:assert/strict";
import path from "node:path";

import {
  buildBrowserRunConsistencyVerification,
  buildMaxRoundsPreparationEvidence,
  buildPageReadinessEvidence,
  buildStatusPillCompletionVerification,
  buildUiStateCaptureExpression,
  buildVerification,
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

  await runTest("panel browser smoke analyze-only verification does not require run artifacts", async () => {
    const verification = buildVerification({
      browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      browserWebSocketUrl: "ws://127.0.0.1:9222/devtools/page/test",
      analysisOnly: true,
      requireCompleted: false,
      preparedFields: {
        pageDefaultMaxRounds: "8",
        maxRounds: "0",
        requestedMaxRounds: "0"
      },
      runState: null,
      autonomousSummary: null,
      specSnapshotExists: false,
      uiState: {
        humanStatusText: "目前判定：未達 ready for human",
        humanStatusHint: "先完成 release-ready gate。",
        previewSummaryText: "目前在跟你互動的是：GPT 起點：data/brief.txt 終點：artifacts/generated/summary.md",
        startCheckSummaryText: "會讀 data/brief.txt，輸出 artifacts/generated/summary.md，不改原檔。",
        startCheckHidden: false,
        logBoxText: "等待操作..."
      },
      statusAfter: {
        overview: {
          humanReadiness: {
            readyForHuman: false,
            blockers: ["release-ready gate not completed"]
          }
        }
      },
      consistencyVerification: null,
      artifactVerification: null,
      runId: "panel-browser-001"
    });

    assert.equal(verification.passed, true);
    assert.equal(
      verification.checks.some((check) => check.id === "run-state-created"),
      false
    );
    assert.equal(
      verification.checks.some((check) => check.id === "preview-summary-rendered" && check.passed),
      true
    );
    assert.equal(
      verification.checks.some((check) => check.id === "start-check-rendered" && check.passed),
      true
    );
  });

  await runTest("panel browser smoke analyze-only verification fails closed when preview cards do not render", async () => {
    const verification = buildVerification({
      browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      browserWebSocketUrl: "ws://127.0.0.1:9222/devtools/page/test",
      analysisOnly: true,
      requireCompleted: false,
      preparedFields: {
        pageDefaultMaxRounds: "8",
        maxRounds: "0",
        requestedMaxRounds: "0"
      },
      runState: null,
      autonomousSummary: null,
      specSnapshotExists: false,
      uiState: {
        humanStatusText: "目前判定：未達 ready for human",
        humanStatusHint: "先完成 release-ready gate。",
        previewSummaryText: "尚未分析。建議先確認工作區，再按「分析起點/終點」。",
        startCheckSummaryText: "尚未分析，還沒有開始前檢查內容。",
        startCheckHidden: true,
        logBoxText: "等待操作..."
      },
      statusAfter: {
        overview: {
          humanReadiness: {
            readyForHuman: false,
            blockers: ["release-ready gate not completed"]
          }
        }
      },
      consistencyVerification: null,
      artifactVerification: null,
      runId: "panel-browser-001"
    });

    assert.equal(verification.passed, false);
    assert.equal(
      verification.checks.some((check) => check.id === "preview-summary-rendered" && !check.passed),
      true
    );
    assert.equal(
      verification.checks.some((check) => check.id === "start-check-rendered" && !check.passed),
      true
    );
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

  await runTest("panel browser smoke captures latest log entry without embedding multiline regex literals", async () => {
    const expression = buildUiStateCaptureExpression();

    assert.equal(expression.includes('split("\\n\\n---\\n\\n")'), true);
    assert.equal(expression.includes("split(/\n\n---\n\n/g)"), false);
  });

  await runTest("panel browser smoke requires matching completed evidence in strict mode", async () => {
    const verification = buildBrowserRunConsistencyVerification({
      runId: "panel-browser-001",
      statusAfter: {
        overview: {
          latestRun: {
            summary: {
              runId: "panel-browser-001",
              status: "completed",
              blockedTasks: 0,
              failedTasks: 0,
              waitingRetryTasks: 0
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
        finalStatus: "completed",
        runSummary: {
          blockedTasks: 0,
          failedTasks: 0,
          waitingRetryTasks: 0
        }
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

  await runTest("panel browser smoke accepts auto-filled confirmation fields without prompt popups", async () => {
    const statusAfter = {
      overview: {
        humanReadiness: {
          readyForHuman: false,
          blockers: ["目前只跑到 repo 級驗證，還沒有完成 release-ready。"]
        },
        latestRun: {
          summary: {
            runId: "panel-browser-003",
            status: "completed",
            blockedTasks: 0,
            failedTasks: 0,
            waitingRetryTasks: 0
          }
        }
      }
    };
    const runState = {
      runId: "panel-browser-003",
      status: "completed"
    };
    const autonomousSummary = {
      runId: "panel-browser-003",
      finalStatus: "completed",
      runSummary: {
        blockedTasks: 0,
        failedTasks: 0,
        waitingRetryTasks: 0
      }
    };
    const verification = buildVerification({
      browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      browserWebSocketUrl: "ws://127.0.0.1:9222/devtools/page/example",
      requireCompleted: true,
      preparedFields: {
        pageDefaultMaxRounds: "20",
        preparedMaxRounds: "20",
        requestedMaxRounds: "20"
      },
      runState,
      autonomousSummary,
      specSnapshotExists: true,
      uiState: {
        promptMessages: [],
        confirmationInputValue: "我確認起點與終點",
        statusPillText: "需求狀態：已確認 | 執行狀態：已完成",
        statusPillClassName: "status-pill",
        logBoxText: "[2026/4/22 12:18:04] Quick start completed\\n\\n{\\n  \"runId\": \"panel-browser-003\",\\n  \"finalStatus\": \"completed\"\\n}",
        latestLogEntryText: "[2026/4/22 12:18:04] Quick start completed\\n\\n{\\n  \"runId\": \"panel-browser-003\",\\n  \"finalStatus\": \"completed\"\\n}",
        humanStatusText: "面板操作：可操作 目前判定：未達 ready for human 驗證層級：repo 目前阻塞原因 目前只跑到 repo 級驗證，還沒有完成 release-ready。",
        humanStatusHint: "目前只能確認面板可開啟，還不能直接宣稱 ready for human / 可實戰。"
      },
      statusAfter,
      consistencyVerification: buildBrowserRunConsistencyVerification({
        runId: "panel-browser-003",
        statusAfter,
        runState,
        autonomousSummary,
        requireCompleted: true
      }),
      artifactVerification: {
        passed: true
      },
      runId: "panel-browser-003"
    });

    assert.equal(verification.passed, true);
    assert.equal(
      verification.checks.some((check) => check.id === "prompt-handled" && check.passed === true),
      true
    );
    assert.equal(
      verification.checks.some((check) => check.id === "human-status-card-state" && check.passed === true),
      true
    );
  });

  await runTest("panel browser smoke fails closed when completed backend leaves error styling in the status pill", async () => {
    const verification = buildVerification({
      browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      browserWebSocketUrl: "ws://127.0.0.1:9222/devtools/page/example",
      requireCompleted: true,
      preparedFields: {
        pageDefaultMaxRounds: "20",
        preparedMaxRounds: "20",
        requestedMaxRounds: "20"
      },
      runState: {
        runId: "panel-browser-004",
        status: "completed"
      },
      autonomousSummary: {
        runId: "panel-browser-004",
        finalStatus: "completed",
        runSummary: {
          blockedTasks: 0,
          failedTasks: 0,
          waitingRetryTasks: 0
        }
      },
      specSnapshotExists: true,
      uiState: {
        promptMessages: [],
        confirmationInputValue: "我確認起點與終點",
        statusPillText: "需求狀態：已確認 | 執行狀態：已完成",
        statusPillClassName: "status-pill error",
        logBoxText: "[2026/4/22 12:20:00] Quick start completed",
        latestLogEntryText: "[2026/4/22 12:20:00] Quick start completed",
        humanStatusText: "面板操作：可操作 目前判定：未達 ready for human",
        humanStatusHint: "先不要直接交給人類。"
      },
      statusAfter: {
        overview: {
          humanReadiness: {
            readyForHuman: false,
            blockers: ["尚未執行 release-ready gate。"]
          },
          latestRun: {
            summary: {
              runId: "panel-browser-004",
              status: "completed",
              blockedTasks: 0,
              failedTasks: 0,
              waitingRetryTasks: 0
            }
          }
        }
      },
      consistencyVerification: buildBrowserRunConsistencyVerification({
        runId: "panel-browser-004",
        statusAfter: {
          overview: {
            latestRun: {
              summary: {
                runId: "panel-browser-004",
                status: "completed",
                blockedTasks: 0,
                failedTasks: 0,
                waitingRetryTasks: 0
              }
            }
          }
        },
        runState: {
          runId: "panel-browser-004",
          status: "completed"
        },
        autonomousSummary: {
          runId: "panel-browser-004",
          finalStatus: "completed",
          runSummary: {
            blockedTasks: 0,
            failedTasks: 0,
            waitingRetryTasks: 0
          }
        },
        requireCompleted: true
      }),
      artifactVerification: {
        passed: true
      },
      runId: "panel-browser-004"
    });

    assert.equal(verification.passed, false);
    assert.equal(
      verification.checks.some((check) => check.id === "completed-status-pill-tone" && check.passed === false),
      true
    );
  });

  await runTest("panel browser smoke fails closed when completed backend still shows waiting or attention in the latest log", async () => {
    const verification = buildVerification({
      browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      browserWebSocketUrl: "ws://127.0.0.1:9222/devtools/page/example",
      requireCompleted: true,
      preparedFields: {
        pageDefaultMaxRounds: "20",
        preparedMaxRounds: "20",
        requestedMaxRounds: "20"
      },
      runState: {
        runId: "panel-browser-005",
        status: "completed"
      },
      autonomousSummary: {
        runId: "panel-browser-005",
        finalStatus: "completed",
        runSummary: {
          blockedTasks: 0,
          failedTasks: 0,
          waitingRetryTasks: 0
        }
      },
      specSnapshotExists: true,
      uiState: {
        promptMessages: [],
        confirmationInputValue: "我確認起點與終點",
        statusPillText: "需求狀態：已確認 | 執行狀態：已完成",
        statusPillClassName: "status-pill",
        logBoxText: "[2026/4/22 12:21:00] Quick start finished this pass but the run needs attention",
        latestLogEntryText: "[2026/4/22 12:21:00] Quick start finished this pass but the run needs attention",
        humanStatusText: "面板操作：可操作 目前判定：未達 ready for human",
        humanStatusHint: "先不要直接交給人類。"
      },
      statusAfter: {
        overview: {
          humanReadiness: {
            readyForHuman: false,
            blockers: ["尚未執行 release-ready gate。"]
          },
          latestRun: {
            summary: {
              runId: "panel-browser-005",
              status: "completed",
              blockedTasks: 0,
              failedTasks: 0,
              waitingRetryTasks: 0
            }
          }
        }
      },
      consistencyVerification: buildBrowserRunConsistencyVerification({
        runId: "panel-browser-005",
        statusAfter: {
          overview: {
            latestRun: {
              summary: {
                runId: "panel-browser-005",
                status: "completed",
                blockedTasks: 0,
                failedTasks: 0,
                waitingRetryTasks: 0
              }
            }
          }
        },
        runState: {
          runId: "panel-browser-005",
          status: "completed"
        },
        autonomousSummary: {
          runId: "panel-browser-005",
          finalStatus: "completed",
          runSummary: {
            blockedTasks: 0,
            failedTasks: 0,
            waitingRetryTasks: 0
          }
        },
        requireCompleted: true
      }),
      artifactVerification: {
        passed: true
      },
      runId: "panel-browser-005"
    });

    assert.equal(verification.passed, false);
    assert.equal(
      verification.checks.some((check) => check.id === "completed-latest-log-entry" && check.passed === false),
      true
    );
  });

  await runTest("panel browser smoke fails closed when completed backend still reports blocker or retry counters", async () => {
    const verification = buildVerification({
      browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      browserWebSocketUrl: "ws://127.0.0.1:9222/devtools/page/example",
      requireCompleted: true,
      preparedFields: {
        pageDefaultMaxRounds: "20",
        preparedMaxRounds: "20",
        requestedMaxRounds: "20"
      },
      runState: {
        runId: "panel-browser-006",
        status: "completed"
      },
      autonomousSummary: {
        runId: "panel-browser-006",
        finalStatus: "completed",
        runSummary: {
          blockedTasks: 1,
          failedTasks: 0,
          waitingRetryTasks: 0
        }
      },
      specSnapshotExists: true,
      uiState: {
        promptMessages: [],
        confirmationInputValue: "我確認起點與終點",
        statusPillText: "需求狀態：已確認 | 執行狀態：已完成",
        statusPillClassName: "status-pill",
        logBoxText: "[2026/4/22 12:22:00] Quick start completed",
        latestLogEntryText: "[2026/4/22 12:22:00] Quick start completed",
        humanStatusText: "面板操作：可操作 目前判定：未達 ready for human 目前阻塞原因 最新 run 目前需要人工處理。",
        humanStatusHint: "先不要直接交給人類。"
      },
      statusAfter: {
        overview: {
          humanReadiness: {
            readyForHuman: false,
            blockers: ["最新 run 目前需要人工處理。"]
          },
          latestRun: {
            summary: {
              runId: "panel-browser-006",
              status: "completed",
              blockedTasks: 1,
              failedTasks: 0,
              waitingRetryTasks: 0
            }
          }
        }
      },
      consistencyVerification: buildBrowserRunConsistencyVerification({
        runId: "panel-browser-006",
        statusAfter: {
          overview: {
            latestRun: {
              summary: {
                runId: "panel-browser-006",
                status: "completed",
                blockedTasks: 1,
                failedTasks: 0,
                waitingRetryTasks: 0
              }
            }
          }
        },
        runState: {
          runId: "panel-browser-006",
          status: "completed"
        },
        autonomousSummary: {
          runId: "panel-browser-006",
          finalStatus: "completed",
          runSummary: {
            blockedTasks: 1,
            failedTasks: 0,
            waitingRetryTasks: 0
          }
        },
        requireCompleted: true
      }),
      artifactVerification: {
        passed: true
      },
      runId: "panel-browser-006"
    });

    assert.equal(verification.passed, false);
    assert.equal(
      verification.checks.some((check) => check.id === "completed-zero-blocker-counters" && check.passed === false),
      true
    );
  });

  await runTest("panel browser smoke fails closed when blocker counters disagree across backend artifacts", async () => {
    const verification = buildBrowserRunConsistencyVerification({
      runId: "panel-browser-007",
      statusAfter: {
        overview: {
          latestRun: {
            summary: {
              runId: "panel-browser-007",
              status: "completed",
              blockedTasks: 1,
              failedTasks: 0,
              waitingRetryTasks: 0
            }
          }
        }
      },
      runState: {
        runId: "panel-browser-007",
        status: "completed"
      },
      autonomousSummary: {
        runId: "panel-browser-007",
        finalStatus: "completed",
        runSummary: {
          blockedTasks: 0,
          failedTasks: 0,
          waitingRetryTasks: 0
        }
      },
      requireCompleted: true
    });

    assert.equal(verification.passed, false);
    assert.equal(
      verification.checks.some((check) => check.id === "terminal-counter-agreement" && check.passed === false),
      true
    );
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
