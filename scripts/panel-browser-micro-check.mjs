import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { startPanelServer } from "../src/lib/panel.mjs";
import {
  CdpSession,
  buildUiStateCaptureExpression,
  collectPageReadiness,
  detectBrowser,
  evaluateExpression,
  launchBrowser,
  stopChildProcess,
  waitForExpression,
  waitForPageTarget
} from "./panel-browser-smoke.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultOutputRoot = path.join(repoRoot, "reports", "panel-browser-micro");
const defaultBrowserStartupMs = 15_000;

function timestampLabel() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("") + "-" + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("");
}

function parsePositiveInteger(value, fallbackValue) {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(String(value), 10);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function parseArgs(argv) {
  const options = {
    outputRoot: defaultOutputRoot,
    browserPath: null,
    browserStartupMs: defaultBrowserStartupMs,
    headless: true,
    requireBrowser: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];

    switch (argument) {
      case "--output-root":
        options.outputRoot = path.resolve(repoRoot, nextValue ?? options.outputRoot);
        index += 1;
        break;
      case "--browser":
        options.browserPath = nextValue ? path.resolve(nextValue) : options.browserPath;
        index += 1;
        break;
      case "--browser-startup-ms":
        options.browserStartupMs = parsePositiveInteger(nextValue, options.browserStartupMs);
        index += 1;
        break;
      case "--headed":
        options.headless = false;
        break;
      case "--require-browser":
        options.requireBrowser = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node scripts/panel-browser-micro-check.mjs [options]

Options:
  --output-root <dir>        Directory that will receive micro-check evidence
  --browser <path>           Explicit Chrome/Edge executable to use
  --browser-startup-ms <ms>  Browser/CDP startup timeout (default: ${defaultBrowserStartupMs})
  --headed                   Show the browser window instead of using headless mode
  --require-browser          Fail instead of skipping when no supported browser is available
`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createHumanReadinessFixture() {
  return {
    humanReadiness: {
      readyForHuman: false,
      uiUsable: null,
      validationProfile: null,
      blockers: ["尚未執行 release-ready gate。"],
      recommendedAction: "先跑 npm run selfcheck:release-ready，再決定是否交給人類。",
      message: "目前只能確認面板可開啟，還不能直接宣稱 ready for human / 可實戰。"
    }
  };
}

function buildChecks({ pageReadiness, helperState, uiState }) {
  return [
    {
      id: "page-script-ready",
      passed: pageReadiness?.callApiType === "function" && pageReadiness?.refreshStatusType === "function",
      message: "The live panel page finished booting and exposed its page-side API."
    },
    {
      id: "human-status-helper-live",
      passed: helperState?.renderHumanStatusCardType === "function",
      message: "The live page exposes renderHumanStatusCard as an active helper."
    },
    {
      id: "human-status-card-rendered",
      passed: String(uiState?.humanStatusText ?? "").includes("面板操作"),
      message: "The live page can render the human status card through the page-side helper."
    },
    {
      id: "ui-status-pill-captured",
      passed: /需求狀態：|執行狀態：/.test(String(uiState?.statusPillText ?? "")),
      message: "The CDP capture expression reads the current status pill text."
    },
    {
      id: "ui-latest-log-entry-captured",
      passed: String(uiState?.latestLogEntryText ?? "").includes("Quick start completed"),
      message: "The CDP capture expression isolates the latest log entry without throwing."
    },
    {
      id: "prompt-messages-captured",
      passed:
        Array.isArray(uiState?.promptMessages) &&
        uiState.promptMessages.length === 1 &&
        String(uiState.promptMessages[0] ?? "").includes("我確認起點與終點"),
      message: "The micro check preserves prompt-message capture for browser smoke flows."
    }
  ];
}

export async function runPanelBrowserMicroCheck(options = {}) {
  const effectiveOptions = {
    outputRoot: options.outputRoot ? path.resolve(options.outputRoot) : defaultOutputRoot,
    browserPath: options.browserPath ? path.resolve(options.browserPath) : null,
    browserStartupMs: parsePositiveInteger(options.browserStartupMs, defaultBrowserStartupMs),
    headless: options.headless !== false,
    requireBrowser: options.requireBrowser === true
  };
  const startedAt = new Date();
  const evidenceRoot = path.join(effectiveOptions.outputRoot, `panel-browser-micro-${timestampLabel()}`);
  const workspaceRoot = path.join(evidenceRoot, "workspace");
  const summary = {
    generatedAt: startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    harnessPassed: false,
    feasibleNow: false,
    skipped: false,
    evidenceRoot,
    workspaceRoot,
    browser: null,
    panelUrl: null,
    pageReadiness: null,
    helperState: null,
    uiState: null,
    checks: [],
    error: null
  };

  let panel = null;
  let browser = null;
  let cdpSession = null;

  await ensureDirectory(workspaceRoot);

  try {
    let browserInfo;
    try {
      browserInfo = await detectBrowser(effectiveOptions.browserPath);
    } catch (error) {
      if (effectiveOptions.requireBrowser) {
        throw error;
      }

      summary.skipped = true;
      summary.harnessPassed = true;
      summary.feasibleNow = false;
      summary.error = error instanceof Error ? error.message : String(error);
      return summary;
    }

    summary.browser = browserInfo;
    panel = await startPanelServer({
      workspaceDir: workspaceRoot,
      port: 0
    });
    summary.panelUrl = panel.url;

    browser = await launchBrowser({
      browserPath: browserInfo.browserPath,
      panelUrl: panel.url,
      headless: effectiveOptions.headless,
      browserStartupMs: effectiveOptions.browserStartupMs,
      evidenceRoot
    });

    const pageTarget = await waitForPageTarget(browser.debugBaseUrl, panel.url, effectiveOptions.browserStartupMs);
    cdpSession = await CdpSession.connect(pageTarget.webSocketDebuggerUrl, effectiveOptions.browserStartupMs);
    await cdpSession.send("Page.enable");
    await cdpSession.send("Runtime.enable");
    await cdpSession.send("Page.bringToFront");
    await waitForExpression(
      cdpSession,
      "document.readyState === \"complete\" && !!document.getElementById(\"statusPill\") && !!document.getElementById(\"logBox\")",
      effectiveOptions.browserStartupMs,
      "panel page to finish loading"
    );

    const pageReadiness = await collectPageReadiness(cdpSession);
    summary.pageReadiness = pageReadiness;
    await writeJson(path.join(evidenceRoot, "page-readiness.json"), pageReadiness);

    const helperState = await evaluateExpression(
      cdpSession,
      `(() => ({
        renderHumanStatusCardType: typeof renderHumanStatusCard,
        renderStatusType: typeof renderStatus,
        previewIntakeType: typeof previewIntake
      }))()`
    );
    summary.helperState = helperState;

    await evaluateExpression(
      cdpSession,
      `(() => {
        const statusPill = document.getElementById("statusPill");
        const logBox = document.getElementById("logBox");
        const confirmationInput = document.getElementById("confirmationInput");

        if (!statusPill || !logBox || !confirmationInput) {
          throw new Error("Required panel elements are missing.");
        }

        statusPill.textContent = "需求狀態：已確認 | 執行狀態：已完成";
        statusPill.className = "status-pill";
        logBox.textContent = [
          "[2026/4/23 01:00:00] GPT 狀態更新",
          "",
          "{ \\"title\\": \\"GPT 正在思考\\" }",
          "",
          "---",
          "",
          "[2026/4/23 01:00:05] Quick start completed",
          "",
          "{ \\"runId\\": \\"panel-browser-micro\\", \\"outcome\\": \\"completed\\" }"
        ].join("\\n");
        confirmationInput.value = "我確認起點與終點";
        window.__panelBrowserSmokePromptMessages = ["Type exactly: 我確認起點與終點"];

        if (typeof renderHumanStatusCard !== "function") {
          throw new Error("renderHumanStatusCard is not available.");
        }

        renderHumanStatusCard(${JSON.stringify(createHumanReadinessFixture())});
        return true;
      })()`
    );

    const uiState = await evaluateExpression(cdpSession, buildUiStateCaptureExpression());
    summary.uiState = uiState;
    await writeJson(path.join(evidenceRoot, "ui-state.json"), uiState);

    const checks = buildChecks({
      pageReadiness,
      helperState,
      uiState
    });
    summary.checks = checks;
    summary.feasibleNow = checks.every((check) => check.passed);
    summary.harnessPassed = summary.feasibleNow;

    if (!summary.harnessPassed) {
      summary.error = checks
        .filter((check) => !check.passed)
        .map((check) => check.message)
        .join("\n");
    }
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  } finally {
    summary.finishedAt = new Date().toISOString();
    await writeJson(path.join(evidenceRoot, "panel-browser-micro-summary.json"), summary).catch(() => undefined);

    if (cdpSession) {
      await cdpSession.close().catch(() => undefined);
    }

    if (browser) {
      await writeFile(path.join(evidenceRoot, "browser.stderr.log"), browser.stderrChunks.join(""), "utf8").catch(() => undefined);
      await stopChildProcess(browser.childProcess).catch(() => undefined);
      await rm(browser.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }

    if (panel) {
      await panel.close().catch(() => undefined);
    }
  }

  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDirectory(options.outputRoot);
  const summary = await runPanelBrowserMicroCheck(options);

  console.log(JSON.stringify(summary, null, 2));

  if (summary.harnessPassed !== true) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
