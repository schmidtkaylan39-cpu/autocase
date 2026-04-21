import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startPanelServer } from "../src/lib/panel.mjs";
import { captureSmokeInputSnapshots, verifyGeneratedSummaryArtifact } from "./panel-one-click-smoke.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputRoot = path.join(projectRoot, "reports", "panel-browser-smoke");
const defaultWatchdogMs = 90_000;
const defaultBrowserStartupMs = 15_000;
const defaultPollIntervalMs = 15_000;
const defaultMaxRounds = 0;
const defaultBriefToken = "BRIEF-PANEL-SMOKE-20260421-A";
const defaultDetailToken = "DETAIL-PANEL-SMOKE-20260421-B";
const defaultRequestText = [
  `Start: Local workspace contains data/brief.txt and data/details.txt with tokens ${defaultBriefToken} and ${defaultDetailToken}, and artifacts/generated is writable.`,
  "End point: Create artifacts/generated/summary.md from both local files without changing the input files.",
  `Success criteria: artifacts/generated/summary.md exists; summary.md includes the exact token ${defaultBriefToken}; summary.md includes the exact token ${defaultDetailToken}; summary.md contains a heading named Combined Notes; summary.md includes a short Chinese summary.`,
  "Input source: data/brief.txt; data/details.txt.",
  "Out of scope: do not modify input files; do not call external APIs; do not send email."
].join("\n");
const completedStatusPillMarkers = ["已完成", "completed"];
const incompleteStatusPillMarkers = [
  "進行中",
  "等待重試",
  "需要人工處理",
  "已阻塞",
  "已失敗",
  "in progress",
  "waiting retry",
  "attention required",
  "blocked",
  "failed"
];

function timestampLabel() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("") + "-" + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
}

function parsePositiveInteger(value, fallbackValue) {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(String(value), 10);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function parseNonNegativeInteger(value, fallbackValue) {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(String(value), 10);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallbackValue;
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function dedupeList(values) {
  const seen = new Set();
  const deduped = [];

  for (const value of values) {
    if (!nonEmptyText(value)) {
      continue;
    }

    const normalized = value.trim();

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function listCandidateBrowserPaths(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const join = path.win32.join;
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const userProfile = env.USERPROFILE ?? "C:\\Users\\Default";
    const localAppData = env.LocalAppData ?? join(userProfile, "AppData", "Local");

    return dedupeList([
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
    ]);
  }

  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    ];
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge"
  ];
}

function identifyBrowser(pathValue) {
  const lowerPath = String(pathValue ?? "").toLowerCase();

  if (lowerPath.includes("msedge")) {
    return "edge";
  }

  if (lowerPath.includes("chrome")) {
    return "chrome";
  }

  return "chromium";
}

function parseArgs(argv) {
  const options = {
    outputRoot: defaultOutputRoot,
    browserPath: null,
    browserStartupMs: defaultBrowserStartupMs,
    watchdogMs: defaultWatchdogMs,
    pollIntervalMs: defaultPollIntervalMs,
    maxRounds: defaultMaxRounds,
    requestText: defaultRequestText,
    requestFile: null,
    headless: true,
    requireCompleted: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];

    switch (argument) {
      case "--output-root":
        options.outputRoot = path.resolve(projectRoot, nextValue ?? options.outputRoot);
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
      case "--watchdog-ms":
        options.watchdogMs = parsePositiveInteger(nextValue, options.watchdogMs);
        index += 1;
        break;
      case "--poll-interval-ms":
        options.pollIntervalMs = parsePositiveInteger(nextValue, options.pollIntervalMs);
        index += 1;
        break;
      case "--max-rounds":
        options.maxRounds = parseNonNegativeInteger(nextValue, options.maxRounds);
        index += 1;
        break;
      case "--request-file":
        options.requestText = nextValue ? null : options.requestText;
        options.requestFile = nextValue ? path.resolve(projectRoot, nextValue) : options.requestFile;
        index += 1;
        break;
      case "--headed":
        options.headless = false;
        break;
      case "--require-completed":
        options.requireCompleted = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node scripts/panel-browser-smoke.mjs [options]

Options:
  --output-root <dir>        Directory that will receive browser smoke evidence
  --browser <path>           Explicit Chrome/Edge executable to use
  --browser-startup-ms <ms>  Browser/CDP startup timeout (default: ${defaultBrowserStartupMs})
  --watchdog-ms <ms>         Overall smoke timeout (default: ${defaultWatchdogMs})
  --poll-interval-ms <ms>    Poll interval for status checks (default: ${defaultPollIntervalMs})
  --max-rounds <count>       quick-start-safe autonomous maxRounds (default: ${defaultMaxRounds})
  --request-file <path>      Optional text file whose contents replace the default smoke request
  --headed                   Show the browser window instead of using headless mode
  --require-completed        Wait for the browser-triggered run to complete and verify summary output
`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function extractConfirmationTokenFromPrompt(promptText) {
  const normalizedPrompt = String(promptText ?? "");
  const exactLineMatch = normalizedPrompt.match(/Type exactly:\s*([^\r\n]+)/i);

  if (exactLineMatch && nonEmptyText(exactLineMatch[1])) {
    return exactLineMatch[1].trim();
  }

  const lines = normalizedPrompt
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.at(-1) ?? "";
}

function normalizeInlineText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildStatusPillCompletionVerification(statusPillText) {
  const normalizedStatusPillText = normalizeInlineText(statusPillText);
  const lowerStatusPillText = normalizedStatusPillText.toLowerCase();
  const matchedCompletedMarkers = completedStatusPillMarkers.filter((marker) =>
    lowerStatusPillText.includes(marker.toLowerCase())
  );
  const matchedIncompleteMarkers = incompleteStatusPillMarkers.filter((marker) =>
    lowerStatusPillText.includes(marker.toLowerCase())
  );

  return {
    passed:
      matchedCompletedMarkers.length > 0 &&
      matchedIncompleteMarkers.length === 0,
    normalizedStatusPillText,
    matchedCompletedMarkers,
    matchedIncompleteMarkers
  };
}

function buildMaxRoundsPreparationEvidence({
  pageDefaultMaxRounds,
  preparedMaxRounds,
  requestedMaxRounds
}) {
  const normalizedPageDefaultMaxRounds = normalizeInlineText(pageDefaultMaxRounds);
  const normalizedPreparedMaxRounds = normalizeInlineText(preparedMaxRounds);
  const normalizedRequestedMaxRounds = normalizeInlineText(requestedMaxRounds);
  const overrideApplied =
    normalizedRequestedMaxRounds.length > 0 &&
    normalizedPreparedMaxRounds === normalizedRequestedMaxRounds &&
    normalizedPageDefaultMaxRounds.length > 0 &&
    normalizedPageDefaultMaxRounds !== normalizedPreparedMaxRounds;

  return {
    pageDefaultMaxRounds:
      normalizedPageDefaultMaxRounds.length > 0 ? normalizedPageDefaultMaxRounds : null,
    preparedMaxRounds:
      normalizedPreparedMaxRounds.length > 0 ? normalizedPreparedMaxRounds : null,
    requestedMaxRounds:
      normalizedRequestedMaxRounds.length > 0 ? normalizedRequestedMaxRounds : null,
    overrideApplied,
    capturedPageDefault: normalizedPageDefaultMaxRounds.length > 0
  };
}

function buildPageReadinessEvidence({
  initialPageReadiness = null,
  finalPageReadiness = null
}) {
  const artifacts = [];

  if (initialPageReadiness) {
    artifacts.push(
      {
        fileName: "page-readiness.json",
        value: initialPageReadiness
      },
      {
        fileName: "page-readiness.initial.json",
        value: initialPageReadiness
      }
    );
  }

  if (finalPageReadiness) {
    artifacts.push({
      fileName: "page-readiness.final.json",
      value: finalPageReadiness
    });
  }

  return {
    pageReadiness: initialPageReadiness,
    finalPageReadiness,
    artifacts
  };
}

function serializeForExpression(value) {
  return JSON.stringify(value);
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeBase64(filePath, data) {
  await writeFile(filePath, Buffer.from(data, "base64"));
}

async function writePageReadinessArtifacts(evidenceRoot, pageReadinessEvidence) {
  await Promise.all(
    pageReadinessEvidence.artifacts.map(({ fileName, value }) =>
      writeJson(path.join(evidenceRoot, fileName), value)
    )
  );
}

async function copyFileIfPresent(sourcePath, destinationPath) {
  try {
    const contents = await readFile(sourcePath);
    await writeFile(destinationPath, contents);
  } catch {
    // Best-effort evidence copy.
  }
}

async function resolveRequestText(options) {
  if (!options.requestFile) {
    return options.requestText;
  }

  return readFile(options.requestFile, "utf8");
}

async function seedWorkspace(workspaceRoot) {
  await ensureDirectory(path.join(workspaceRoot, "data"));
  await ensureDirectory(path.join(workspaceRoot, "artifacts", "generated"));
  await writeFile(
    path.join(workspaceRoot, "data", "brief.txt"),
    `Brief token: ${defaultBriefToken}\n`,
    "utf8"
  );
  await writeFile(
    path.join(workspaceRoot, "data", "details.txt"),
    `Details token: ${defaultDetailToken}\n`,
    "utf8"
  );
}

async function detectBrowser(browserPath) {
  const candidatesTried = [];

  if (nonEmptyText(browserPath)) {
    const resolvedPath = path.resolve(browserPath);
    candidatesTried.push(resolvedPath);

    if (await pathExists(resolvedPath)) {
      return {
        browserPath: resolvedPath,
        browserName: identifyBrowser(resolvedPath),
        candidatesTried
      };
    }

    throw new Error(`Requested browser executable was not found: ${resolvedPath}`);
  }

  for (const candidatePath of listCandidateBrowserPaths()) {
    candidatesTried.push(candidatePath);

    if (await pathExists(candidatePath)) {
      return {
        browserPath: candidatePath,
        browserName: identifyBrowser(candidatePath),
        candidatesTried
      };
    }
  }

  throw new Error(`No supported browser executable was found. Tried: ${candidatesTried.join(", ")}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(description, timeoutMs, fn, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await fn();

      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(intervalMs);
  }

  if (lastError) {
    throw new Error(`${description} timed out after ${timeoutMs}ms: ${lastError.message}`);
  }

  throw new Error(`${description} timed out after ${timeoutMs}ms.`);
}

async function waitForDevToolsEndpoint(userDataDir, getStderr, timeoutMs) {
  return pollUntil("browser DevTools endpoint", timeoutMs, async () => {
    const activePortPath = path.join(userDataDir, "DevToolsActivePort");

    try {
      const contents = await readFile(activePortPath, "utf8");
      const [portLine, websocketPath] = contents
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const port = Number.parseInt(portLine, 10);

      if (Number.isInteger(port) && nonEmptyText(websocketPath)) {
        return {
          port,
          browserWebSocketUrl: `ws://127.0.0.1:${port}${websocketPath.startsWith("/") ? websocketPath : `/${websocketPath}`}`
        };
      }
    } catch {
      // Fall back to stderr parsing below while the file is not ready yet.
    }

    const stderrText = getStderr();
    const match = stderrText.match(/DevTools listening on (ws:\/\/[^\s]+)/i);

    if (!match) {
      return null;
    }

    const browserWebSocketUrl = match[1];
    const parsedUrl = new URL(browserWebSocketUrl);

    return {
      port: Number.parseInt(parsedUrl.port, 10),
      browserWebSocketUrl
    };
  });
}

async function waitForChildExit(childProcess, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      childProcess.off("close", onClose);
    };

    childProcess.once("close", onClose);
  });
}

async function stopChildProcess(childProcess) {
  if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }

  childProcess.kill("SIGTERM");

  if (await waitForChildExit(childProcess, 2_000)) {
    return;
  }

  childProcess.kill("SIGKILL");
  await waitForChildExit(childProcess, 2_000);
}

async function launchBrowser({
  browserPath,
  panelUrl,
  headless,
  browserStartupMs,
  evidenceRoot
}) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-browser-"));
  const stderrChunks = [];
  const browserArgs = [
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--disable-sync",
    "--disable-extensions",
    "--window-size=1440,1100"
  ];

  if (headless) {
    browserArgs.push("--headless=new");
  } else {
    browserArgs.push("--new-window");
  }

  browserArgs.push(panelUrl);

  const childProcess = spawn(browserPath, browserArgs, {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });

  childProcess.stderr.setEncoding("utf8");
  childProcess.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
  });

  const devTools = await waitForDevToolsEndpoint(
    userDataDir,
    () => stderrChunks.join(""),
    browserStartupMs
  );
  const debugBaseUrl = `http://127.0.0.1:${devTools.port}`;

  await writeFile(path.join(evidenceRoot, "browser.stderr.log"), stderrChunks.join(""), "utf8");

  return {
    childProcess,
    userDataDir,
    stderrChunks,
    debugBaseUrl,
    devTools
  };
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  return payload;
}

async function waitForPageTarget(debugBaseUrl, panelUrl, timeoutMs) {
  return pollUntil("panel page target", timeoutMs, async () => {
    const targets = await fetchJson(`${debugBaseUrl}/json/list`);
    const matchingTarget =
      targets.find((target) => target.type === "page" && String(target.url ?? "").startsWith(panelUrl)) ??
      targets.find((target) => target.type === "page");

    return matchingTarget ?? null;
  });
}

function decodeWebSocketMessage(data) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  return String(data);
}

class CdpSession {
  constructor(socket, websocketUrl) {
    this.socket = socket;
    this.websocketUrl = websocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.closeError = null;

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(decodeWebSocketMessage(event.data));

      if (typeof message.id !== "number") {
        return;
      }

      const pendingRequest = this.pending.get(message.id);

      if (!pendingRequest) {
        return;
      }

      this.pending.delete(message.id);

      if (message.error) {
        pendingRequest.reject(
          new Error(`${message.error.message} (${message.error.code})`)
        );
        return;
      }

      pendingRequest.resolve(message.result ?? {});
    });

    const rejectAll = (error) => {
      if (this.closed) {
        return;
      }

      this.closed = true;
      this.closeError = error;

      for (const pendingRequest of this.pending.values()) {
        pendingRequest.reject(error);
      }

      this.pending.clear();
    };

    socket.addEventListener("close", () => {
      rejectAll(new Error(`CDP socket closed: ${this.websocketUrl}`));
    });
    socket.addEventListener("error", () => {
      rejectAll(new Error(`CDP socket error: ${this.websocketUrl}`));
    });
  }

  static async connect(websocketUrl, timeoutMs) {
    if (typeof WebSocket !== "function") {
      throw new Error("Global WebSocket is unavailable in this Node runtime.");
    }

    const socket = new WebSocket(websocketUrl);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out connecting to CDP target: ${websocketUrl}`));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Failed to connect to CDP target: ${websocketUrl}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });

    return new CdpSession(socket, websocketUrl);
  }

  async send(method, params = {}) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw this.closeError ?? new Error(`CDP socket is not open for ${this.websocketUrl}.`);
    }

    const id = this.nextId;
    this.nextId += 1;

    const responsePromise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.socket.send(JSON.stringify({ id, method, params }));
    return responsePromise;
  }

  async close() {
    if (this.closed || this.socket.readyState >= WebSocket.CLOSING) {
      return;
    }

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      const onClose = () => {
        clearTimeout(timer);
        resolve();
      };

      this.socket.addEventListener("close", onClose, { once: true });
      this.socket.close();
    });
  }
}

async function evaluateExpression(session, expression) {
  const evaluation = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });

  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.result?.description ??
        evaluation.exceptionDetails.text ??
        "Runtime.evaluate failed."
    );
  }

  return evaluation.result?.value;
}

async function waitForExpression(session, expression, timeoutMs, description) {
  return pollUntil(description, timeoutMs, async () => {
    const result = await evaluateExpression(session, `(() => Boolean(${expression}))()`);
    return result === true;
  });
}

async function clickSelector(session, selector) {
  return evaluateExpression(
    session,
    `(() => {
      const target = document.querySelector(${serializeForExpression(selector)});

      if (!target) {
        throw new Error("Missing selector: ${selector}");
      }

      if (target.disabled) {
        throw new Error("Selector is disabled: ${selector}");
      }

      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return true;
    })()`
  );
}

async function waitForFile(targetPath, timeoutMs) {
  return pollUntil(`file ${targetPath}`, timeoutMs, async () => {
    if (await pathExists(targetPath)) {
      return targetPath;
    }

    return null;
  });
}

async function waitForPanelStatus(panelUrl, runId, timeoutMs) {
  return pollUntil("panel status update", timeoutMs, async () => {
    const statusPayload = await fetchJson(`${panelUrl}/api/status`);
    const latestRunId = statusPayload?.overview?.latestRun?.summary?.runId;

    if (latestRunId === runId) {
      return statusPayload;
    }

    return null;
  });
}

async function waitForRunSummary(panelUrl, runId, timeoutMs, intervalMs, predicate) {
  const pollSnapshots = [];
  const statusPayload = await pollUntil("panel status terminal update", timeoutMs, async () => {
    const payload = await fetchJson(`${panelUrl}/api/status`);
    pollSnapshots.push({
      collectedAt: new Date().toISOString(),
      status: payload
    });
    const summary = payload?.overview?.latestRun?.summary ?? {};

    if (summary.runId !== runId) {
      return null;
    }

    return predicate(summary, payload) ? payload : null;
  }, intervalMs);

  return {
    statusPayload,
    pollSnapshots
  };
}

async function waitForUiState(session, runId, timeoutMs) {
  return pollUntil("panel UI update", timeoutMs, async () => {
    const uiState = await evaluateExpression(
      session,
      `(() => ({
        statusPillText: document.getElementById("statusPill")?.textContent ?? "",
        logBoxText: document.getElementById("logBox")?.textContent ?? "",
        promptMessages: Array.isArray(window.__panelBrowserSmokePromptMessages)
          ? window.__panelBrowserSmokePromptMessages.slice()
          : [],
        quickStartDisabled: Boolean(document.getElementById("quickStartBtn")?.disabled)
      }))()`
    );

    const logText = String(uiState?.logBoxText ?? "");
    const promptMessages = Array.isArray(uiState?.promptMessages) ? uiState.promptMessages : [];

    if (promptMessages.length === 0) {
      return null;
    }

    if (!logText.includes(runId)) {
      return null;
    }

    if (uiState.quickStartDisabled) {
      return null;
    }

    return uiState;
  });
}

function readAutonomousSummaryTerminalStatus(autonomousSummary) {
  return autonomousSummary?.finalStatus ?? autonomousSummary?.runSummary?.status ?? null;
}

function buildBrowserRunConsistencyVerification({
  runId,
  statusAfter,
  runState,
  autonomousSummary,
  requireCompleted
}) {
  const statusAfterRunId = statusAfter?.overview?.latestRun?.summary?.runId ?? null;
  const statusAfterStatus = statusAfter?.overview?.latestRun?.summary?.status ?? null;
  const runStateRunId = runState?.runId ?? null;
  const runStateStatus = runState?.status ?? null;
  const autonomousSummaryRunId = autonomousSummary?.runId ?? null;
  const autonomousSummaryStatus = readAutonomousSummaryTerminalStatus(autonomousSummary);
  const checks = [
    {
      id: "status-after-run-id",
      passed: statusAfterRunId === runId,
      message: "/api/status reports the expected browser-triggered run id."
    },
    {
      id: "run-state-run-id",
      passed: runStateRunId === runId,
      message: "run-state.json reports the expected browser-triggered run id."
    }
  ];

  if (requireCompleted) {
    checks.push(
      {
        id: "autonomous-summary-exists",
        passed: Boolean(autonomousSummary),
        message: "autonomous-summary.json exists for the browser-triggered run."
      },
      {
        id: "autonomous-summary-run-id",
        passed: autonomousSummaryRunId === runId,
        message: "autonomous-summary.json reports the expected browser-triggered run id."
      },
      {
        id: "terminal-status-agreement",
        passed:
          [statusAfterStatus, runStateStatus, autonomousSummaryStatus].every((value) => value !== null) &&
          new Set([statusAfterStatus, runStateStatus, autonomousSummaryStatus]).size === 1,
        message: "/api/status, run-state.json, and autonomous-summary.json agree on terminal status."
      }
    );
  }

  return {
    passed: checks.every((check) => check.passed),
    observed: {
      statusAfterRunId,
      statusAfterStatus,
      runStateRunId,
      runStateStatus,
      autonomousSummaryRunId,
      autonomousSummaryStatus
    },
    checks
  };
}

async function collectPageReadiness(session) {
  return evaluateExpression(
    session,
    `(() => ({
      readyState: document.readyState,
      callApiType: typeof callApi,
      refreshStatusType: typeof refreshStatus,
      quickStartButtonText: document.getElementById("quickStartBtn")?.textContent ?? "",
      statusPillText: document.getElementById("statusPill")?.textContent ?? "",
      logBoxText: document.getElementById("logBox")?.textContent ?? ""
    }))()`
  );
}

function buildVerification({
  browserPath,
  browserWebSocketUrl,
  requireCompleted,
  preparedFields,
  runState,
  autonomousSummary,
  specSnapshotExists,
  uiState,
  statusAfter,
  consistencyVerification,
  artifactVerification,
  runId
}) {
  const promptMessages = Array.isArray(uiState?.promptMessages) ? uiState.promptMessages : [];
  const extractedPromptToken = promptMessages.length > 0
    ? extractConfirmationTokenFromPrompt(promptMessages[0])
    : "";
  const logText = String(uiState?.logBoxText ?? "");
  const checks = [
    {
      id: "browser-detected",
      passed: nonEmptyText(browserPath),
      message: "A supported Chrome/Edge browser executable was found."
    },
    {
      id: "cdp-connected",
      passed: nonEmptyText(browserWebSocketUrl),
      message: "The browser exposed a DevTools websocket endpoint."
    },
    {
      id: "prompt-handled",
      passed: promptMessages.length > 0 && nonEmptyText(extractedPromptToken),
      message: "The browser smoke handled the panel confirmation prompt in-page."
    },
    {
      id: "ui-log-updated",
      passed: logText.includes(runId),
      message: "The panel log updated with the quick-start run id."
    },
    {
      id: "run-state-created",
      passed: runState?.runId === runId,
      message: "The quick-start click created the expected run-state.json file."
    },
    {
      id: "spec-snapshot-created",
      passed: specSnapshotExists,
      message: "The quick-start flow created a spec.snapshot.json file."
    },
    {
      id: "panel-status-updated",
      passed: statusAfter?.overview?.latestRun?.summary?.runId === runId,
      message: "The panel status endpoint reports the new run after the browser click."
    }
  ];

  const finalRunStatus = statusAfter?.overview?.latestRun?.summary?.status ?? null;
  const statusPillVerification = buildStatusPillCompletionVerification(uiState?.statusPillText);
  const maxRoundsPreparation = buildMaxRoundsPreparationEvidence({
    pageDefaultMaxRounds: preparedFields?.pageDefaultMaxRounds,
    preparedMaxRounds: preparedFields?.maxRounds,
    requestedMaxRounds: preparedFields?.requestedMaxRounds
  });

  if (requireCompleted) {
    checks.push(
      {
        id: "final-run-completed",
        passed: finalRunStatus === "completed",
        message: "The browser-triggered run reached completed status."
      },
      {
        id: "ui-status-pill-completed",
        passed: statusPillVerification.passed,
        message:
          "After backend completion, the rendered status pill shows a completed state instead of an in-progress, retry, or attention-needed state."
      }
    );

    if (maxRoundsPreparation.requestedMaxRounds !== null) {
      checks.push({
        id: "page-default-max-rounds-captured",
        passed: maxRoundsPreparation.capturedPageDefault,
        message:
          "The browser smoke evidence captures the page's original maxRounds default before any harness override."
      });
    }
  }

  if (artifactVerification) {
    checks.push({
      id: "summary-artifact-verified",
      passed: artifactVerification.passed,
      message: "The generated summary artifact satisfies the required smoke assertions."
    });
  }

  if (requireCompleted) {
    checks.push({
      id: "autonomous-summary-completed",
      passed: autonomousSummary?.finalStatus === "completed",
      message: "The browser-triggered quick start reached a completed autonomous summary."
    });
  }

  if (consistencyVerification) {
    checks.push(...consistencyVerification.checks);
  }

  if (finalRunStatus === "completed") {
    checks.push({
      id: "ui-log-completed",
      passed:
        logText.includes("Quick start completed") ||
        logText.includes("\"outcome\": \"completed\"") ||
        logText.includes("\"finalStatus\": \"completed\""),
      message: "The browser UI log shows a completed quick-start outcome."
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    extractedPromptToken,
    statusPillVerification,
    maxRoundsPreparation,
    checks
  };
}

async function runPanelBrowserSmoke(options) {
  const requestText = await resolveRequestText(options);
  if (options.requireCompleted && options.maxRounds === 0) {
    throw new Error("Strict completed mode requires --max-rounds greater than 0.");
  }
  const startedAt = new Date();
  const evidenceRoot = path.join(options.outputRoot, `panel-browser-smoke-${timestampLabel()}`);
  const workspaceRoot = path.join(evidenceRoot, "workspace");
  const runId = `panel-browser-${timestampLabel()}`;
  const runDirectory = path.join(workspaceRoot, "runs", runId);
  const runStatePath = path.join(runDirectory, "run-state.json");
  const specSnapshotPath = path.join(runDirectory, "spec.snapshot.json");
  const summary = {
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    feasibleNow: false,
    harnessPassed: false,
    evidenceRoot,
    workspaceRoot,
    runId,
    maxRounds: options.maxRounds,
    requireCompleted: options.requireCompleted,
    headless: options.headless,
    requestText
  };

  let panel = null;
  let browser = null;
  let cdpSession = null;
  let statusPolls = [];

  await ensureDirectory(evidenceRoot);
  await seedWorkspace(workspaceRoot);
  const immutableInputSnapshots = await captureSmokeInputSnapshots(workspaceRoot);
  await writeJson(path.join(evidenceRoot, "input-snapshots.json"), immutableInputSnapshots);

  try {
    const browserInfo = await detectBrowser(options.browserPath);
    summary.browser = browserInfo;

    panel = await startPanelServer({
      workspaceDir: workspaceRoot,
      port: 0
    });
    summary.panelUrl = panel.url;

    browser = await launchBrowser({
      browserPath: browserInfo.browserPath,
      panelUrl: panel.url,
      headless: options.headless,
      browserStartupMs: options.browserStartupMs,
      evidenceRoot
    });
    summary.devTools = browser.devTools;
    summary.debugBaseUrl = browser.debugBaseUrl;

    const versionPayload = await fetchJson(`${browser.debugBaseUrl}/json/version`);
    await writeJson(path.join(evidenceRoot, "devtools-version.json"), versionPayload);

    const pageTarget = await waitForPageTarget(browser.debugBaseUrl, panel.url, options.browserStartupMs);
    summary.pageTarget = {
      id: pageTarget.id,
      title: pageTarget.title ?? "",
      type: pageTarget.type,
      url: pageTarget.url,
      websocketUrl: pageTarget.webSocketDebuggerUrl
    };

    cdpSession = await CdpSession.connect(pageTarget.webSocketDebuggerUrl, options.browserStartupMs);
    await cdpSession.send("Page.enable");
    await cdpSession.send("Runtime.enable");
    await cdpSession.send("Page.bringToFront");
    await waitForExpression(
      cdpSession,
      "document.readyState === \"complete\" && !!document.getElementById(\"quickStartBtn\") && !!document.getElementById(\"logBox\")",
      options.browserStartupMs,
      "panel page to finish loading"
    );
    const pageReadiness = await collectPageReadiness(cdpSession);
    const initialPageReadinessEvidence = buildPageReadinessEvidence({
      initialPageReadiness: pageReadiness
    });
    summary.pageReadiness = initialPageReadinessEvidence.pageReadiness;
    summary.finalPageReadiness = null;
    await writePageReadinessArtifacts(evidenceRoot, initialPageReadinessEvidence);

    if (pageReadiness.callApiType !== "function") {
      throw new Error(
        `Panel page script did not initialize. callApiType=${pageReadiness.callApiType}, refreshStatusType=${pageReadiness.refreshStatusType}`
      );
    }

    await evaluateExpression(
      cdpSession,
      `(() => {
        window.__panelBrowserSmokePromptMessages = [];
        window.prompt = (message, defaultValue = "") => {
          const text = String(message ?? "");
          window.__panelBrowserSmokePromptMessages.push(text);
          const exactLineMatch = text.match(/Type exactly:\\s*([^\\r\\n]+)/i);

          if (exactLineMatch && exactLineMatch[1]) {
            return exactLineMatch[1].trim();
          }

          const lines = text.split(/\\r?\\n/g).map((line) => line.trim()).filter(Boolean);
          return lines.at(-1) ?? String(defaultValue ?? "");
        };
        return true;
      })()`
    );

    const preparedFields = await evaluateExpression(
      cdpSession,
      `(() => {
        const getElement = (id) => {
          const element = document.getElementById(id);

          if (!element) {
            throw new Error("Missing element: " + id);
          }

          return element;
        };
        const setValue = (id, value) => {
          const element = getElement(id);

          element.focus();
          element.value = String(value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const pageDefaultMaxRounds = String(getElement("maxRoundsInput").value ?? "");

        setValue("workspaceInput", ${serializeForExpression(workspaceRoot)});
        setValue("requestInput", ${serializeForExpression(requestText)});
        setValue("runIdInput", ${serializeForExpression(runId)});
        setValue("maxRoundsInput", ${serializeForExpression(String(options.maxRounds))});
        setValue("confirmationInput", "");

        return {
          workspace: document.getElementById("workspaceInput").value,
          requestLength: document.getElementById("requestInput").value.length,
          runId: document.getElementById("runIdInput").value,
          maxRounds: document.getElementById("maxRoundsInput").value,
          requestedMaxRounds: ${serializeForExpression(String(options.maxRounds))},
          pageDefaultMaxRounds
        };
      })()`
    );
    await writeJson(path.join(evidenceRoot, "prepared-fields.json"), preparedFields);

    const beforeClickScreenshot = await cdpSession.send("Page.captureScreenshot", { format: "png" });
    await writeBase64(path.join(evidenceRoot, "before-click.png"), beforeClickScreenshot.data);

    await clickSelector(cdpSession, "#quickStartBtn");

    await waitForFile(runStatePath, options.watchdogMs);
    let statusAfter = await waitForPanelStatus(panel.url, runId, options.watchdogMs);

    if (options.requireCompleted) {
      const terminalResult = await waitForRunSummary(
        panel.url,
        runId,
        options.watchdogMs,
        options.pollIntervalMs,
        (runSummary) => ["completed", "attention_required", "failed"].includes(runSummary.status)
      );
      statusAfter = terminalResult.statusPayload;
      statusPolls = terminalResult.pollSnapshots;
    }

    const uiState = await waitForUiState(cdpSession, runId, options.watchdogMs);
    const runState = JSON.parse(await readFile(runStatePath, "utf8"));
    const specSnapshotExists = await pathExists(specSnapshotPath);
    const autonomousSummaryPath = path.join(runDirectory, "autonomous-summary.json");
    const autonomousSummary = await readFile(autonomousSummaryPath, "utf8")
      .then((contents) => JSON.parse(contents))
      .catch(() => null);
    const consistencyVerification = buildBrowserRunConsistencyVerification({
      runId,
      statusAfter,
      runState,
      autonomousSummary,
      requireCompleted: options.requireCompleted
    });
    const artifactVerification = options.requireCompleted
      ? await verifyGeneratedSummaryArtifact(workspaceRoot, {
          immutableInputSnapshots
        })
      : null;
    const verification = buildVerification({
      browserPath: browserInfo.browserPath,
      browserWebSocketUrl: browser.devTools.browserWebSocketUrl,
      requireCompleted: options.requireCompleted,
      preparedFields,
      runState,
      autonomousSummary,
      specSnapshotExists,
      uiState,
      statusAfter,
      consistencyVerification,
      artifactVerification,
      runId
    });

    summary.statusAfter = statusAfter;
    summary.uiState = uiState;
    summary.preparedFields = preparedFields;
    summary.verification = verification;
    summary.runStatePath = runStatePath;
    summary.specSnapshotPath = specSnapshotExists ? specSnapshotPath : null;
    summary.autonomousSummaryPath = autonomousSummary ? autonomousSummaryPath : null;
    summary.artifactVerification = artifactVerification;
    summary.pollIntervalMs = options.pollIntervalMs;
    summary.statusPollCount = statusPolls.length;
    summary.finalRunStatus = statusAfter?.overview?.latestRun?.summary?.status ?? null;
    summary.autonomousFinalStatus = autonomousSummary?.finalStatus ?? null;
    summary.feasibleNow = verification.passed;
    summary.harnessPassed = verification.passed;

    const afterClickScreenshot = await cdpSession.send("Page.captureScreenshot", { format: "png" });
    await writeBase64(path.join(evidenceRoot, "after-click.png"), afterClickScreenshot.data);
    await writeJson(path.join(evidenceRoot, "status-after.json"), statusAfter);
    if (statusPolls.length > 0) {
      await writeJson(path.join(evidenceRoot, "status-polls.json"), statusPolls);
    }
    await writeJson(path.join(evidenceRoot, "ui-state.json"), uiState);
    await writeJson(path.join(evidenceRoot, "verification.json"), verification);
    if (artifactVerification) {
      await writeJson(path.join(evidenceRoot, "artifact-verification.json"), artifactVerification);
    }
    await copyFileIfPresent(runStatePath, path.join(evidenceRoot, "run-state.json"));
    await copyFileIfPresent(specSnapshotPath, path.join(evidenceRoot, "spec.snapshot.json"));
    await copyFileIfPresent(autonomousSummaryPath, path.join(evidenceRoot, "autonomous-summary.json"));

    if (!verification.passed) {
      summary.error = verification.checks
        .filter((check) => !check.passed)
        .map((check) => check.message)
        .join("\n");
    }
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (cdpSession) {
      const finalPageReadiness = await collectPageReadiness(cdpSession).catch(() => null);

      if (finalPageReadiness) {
        const finalPageReadinessEvidence = buildPageReadinessEvidence({
          initialPageReadiness: summary.pageReadiness ?? null,
          finalPageReadiness
        });
        summary.pageReadiness = finalPageReadinessEvidence.pageReadiness;
        summary.finalPageReadiness = finalPageReadinessEvidence.finalPageReadiness;
        await writePageReadinessArtifacts(evidenceRoot, finalPageReadinessEvidence).catch(() => undefined);
      }
    }

    summary.finishedAt = new Date().toISOString();
    await writeJson(path.join(evidenceRoot, "panel-browser-smoke-summary.json"), summary);

    if (cdpSession) {
      await cdpSession.close().catch(() => undefined);
    }

    if (browser) {
      await writeFile(
        path.join(evidenceRoot, "browser.stderr.log"),
        browser.stderrChunks.join(""),
        "utf8"
      ).catch(() => undefined);
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
  const summary = await runPanelBrowserSmoke(options);

  console.log(JSON.stringify(summary, null, 2));

  if (summary.harnessPassed !== true) {
    process.exitCode = 1;
  }
}

export {
  buildBrowserRunConsistencyVerification,
  buildMaxRoundsPreparationEvidence,
  buildPageReadinessEvidence,
  buildStatusPillCompletionVerification,
  extractConfirmationTokenFromPrompt,
  isMainModule,
  listCandidateBrowserPaths,
  parseArgs,
  runPanelBrowserSmoke
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
