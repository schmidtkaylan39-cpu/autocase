import http from "node:http";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  confirmIntake,
  createRunHandoffs,
  initProject,
  intakeRequest,
  planProject,
  reportProjectRun,
  reviseIntake,
  runProject,
  validateSpec
} from "./commands.mjs";
import { runAutonomousLoop } from "./autonomous-run.mjs";
import { dispatchHandoffs } from "./dispatch.mjs";
import { runRuntimeDoctor } from "./doctor.mjs";
import { readJson } from "./fs-utils.mjs";
import { loadIntakeArtifacts } from "./intake-state.mjs";
import { summarizeRunState } from "./run-state.mjs";

const DEFAULT_PANEL_HOST = "127.0.0.1";
const DEFAULT_PANEL_PORT = 4310;
const MAX_REQUEST_BYTES = 1_000_000;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveWithinWorkspace(workspaceRoot, value, fallbackPath) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallbackPath;
  }

  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
}

async function listRunStateCandidates(runsDirectory) {
  let entries;
  try {
    entries = await readdir(runsDirectory, {
      withFileTypes: true
    });
  } catch {
    return [];
  }

  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runStatePath = path.join(runsDirectory, entry.name, "run-state.json");

    try {
      const details = await stat(runStatePath);
      candidates.push({
        runStatePath,
        mtimeMs: details.mtimeMs
      });
    } catch {
      // Ignore directories without run-state.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates;
}

async function findLatestRunStatePath(workspaceRoot) {
  const runsDirectory = path.join(workspaceRoot, "runs");
  const [latest] = await listRunStateCandidates(runsDirectory);
  return latest?.runStatePath ?? null;
}

async function collectHandoffDirectories(runStatePath) {
  const runDirectory = path.dirname(runStatePath);
  const candidateDirectories = new Set([
    path.join(runDirectory, "handoffs"),
    path.join(runDirectory, "handoffs-autonomous")
  ]);
  const runState = await readJson(runStatePath).catch(() => null);

  for (const task of runState?.taskLedger ?? []) {
    if (typeof task.activeHandoffOutputDir === "string" && task.activeHandoffOutputDir.trim().length > 0) {
      candidateDirectories.add(path.resolve(task.activeHandoffOutputDir));
    }
  }

  return [...candidateDirectories];
}

async function resolveDefaultHandoffIndexPath(runStatePath) {
  const directories = await collectHandoffDirectories(runStatePath);

  for (const directoryPath of directories) {
    const indexPath = path.join(directoryPath, "index.json");

    if (await pathExists(indexPath)) {
      return indexPath;
    }
  }

  throw new Error(`No handoff index was found for ${runStatePath}. Generate handoffs before dispatching.`);
}

async function findLatestDispatchResultsPath(runStatePath) {
  const directories = await collectHandoffDirectories(runStatePath);
  const candidates = [];

  for (const directoryPath of directories) {
    const dispatchResultsPath = path.join(directoryPath, "dispatch-results.json");

    try {
      const details = await stat(dispatchResultsPath);
      candidates.push({
        dispatchResultsPath,
        mtimeMs: details.mtimeMs
      });
    } catch {
      // Ignore missing dispatch-results.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.dispatchResultsPath ?? null;
}

function getDefaultPaths(workspaceRoot) {
  return {
    specPath: path.join(workspaceRoot, "specs", "project-spec.json"),
    runsDir: path.join(workspaceRoot, "runs"),
    reportsDir: path.join(workspaceRoot, "reports")
  };
}

export function normalizePanelPort(portInput, fallbackPort = DEFAULT_PANEL_PORT) {
  if (portInput === undefined || portInput === null || String(portInput).trim().length === 0) {
    return fallbackPort;
  }

  const parsedPort = Number.parseInt(String(portInput), 10);

  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error(`Invalid panel port: ${portInput}`);
  }

  return parsedPort;
}

export function resolvePanelWorkspace(workspaceDir = ".") {
  return path.resolve(workspaceDir);
}

async function buildWorkspaceOverview(workspaceRoot) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const defaults = getDefaultPaths(normalizedWorkspaceRoot);
  const intake = await loadIntakeArtifacts(normalizedWorkspaceRoot).catch(() => ({
    exists: false,
    artifactPaths: null,
    spec: null
  }));
  const latestRunStatePath = await findLatestRunStatePath(normalizedWorkspaceRoot);
  let latestRun = null;

  if (latestRunStatePath) {
    const runState = await readJson(latestRunStatePath).catch(() => null);

    if (runState) {
      const runDirectory = path.dirname(latestRunStatePath);
      const reportPath = path.join(runDirectory, "report.md");
      const defaultHandoffIndexPath = await resolveDefaultHandoffIndexPath(latestRunStatePath).catch(() => null);

      latestRun = {
        runDirectory,
        runStatePath: latestRunStatePath,
        reportPath,
        handoffIndexPath: defaultHandoffIndexPath,
        summary: summarizeRunState(runState)
      };
    }
  }

  return {
    workspaceRoot: normalizedWorkspaceRoot,
    defaults,
    intake: {
      exists: intake.exists,
      clarificationStatus: intake.spec?.clarificationStatus ?? null,
      confirmedByUser: intake.spec?.confirmedByUser ?? null,
      recommendedNextStep: intake.spec?.recommendedNextStep ?? null,
      intakeSpecPath: intake.artifactPaths?.intakeSpecPath ?? null,
      intakeSummaryPath: intake.artifactPaths?.intakeSummaryPath ?? null
    },
    latestRun
  };
}

function createUserError(message) {
  return Object.assign(new Error(message), {
    statusCode: 400
  });
}

function createHttpError(message, statusCode) {
  return Object.assign(new Error(message), {
    statusCode
  });
}

function readStatusCode(error) {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const candidate = error.statusCode;

    if (typeof candidate === "number" && candidate >= 400) {
      return candidate;
    }
  }

  return null;
}

function extractPromptFromStderr(stderr) {
  if (typeof stderr !== "string" || stderr.trim().length === 0) {
    return null;
  }

  const normalized = stderr.replaceAll("\r\n", "\n");
  const userMarker = "\nuser\n";
  let startIndex = normalized.indexOf(userMarker);

  if (startIndex >= 0) {
    startIndex += userMarker.length;
  } else if (normalized.startsWith("user\n")) {
    startIndex = "user\n".length;
  } else {
    return null;
  }

  let promptBody = normalized.slice(startIndex);
  const timestampMatch = /\n\d{4}-\d{2}-\d{2}T/.exec(promptBody);

  if (timestampMatch && typeof timestampMatch.index === "number") {
    promptBody = promptBody.slice(0, timestampMatch.index);
  }

  const trimmed = promptBody.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePreferredModel(stdout) {
  if (typeof stdout !== "string") {
    return null;
  }

  const match = stdout.match(/Preferred model:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

function parseExecutionMetadata(stderr) {
  if (typeof stderr !== "string") {
    return {
      model: null,
      provider: null,
      sessionId: null,
      endpoint: null,
      cfRay: null
    };
  }

  const model = stderr.match(/^\s*model:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const provider = stderr.match(/^\s*provider:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const sessionId = stderr.match(/^\s*session id:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const endpoint = stderr.match(/url:\s*(https?:\/\/\S+)/i)?.[1]?.replace(/[,)]$/, "") ?? null;
  const cfRay = stderr.match(/cf-ray:\s*([^\s,]+)/i)?.[1]?.trim() ?? null;

  return {
    model,
    provider,
    sessionId,
    endpoint,
    cfRay
  };
}

function truncateText(value, maxLength = 12000) {
  if (typeof value !== "string") {
    return {
      text: null,
      truncated: false
    };
  }

  if (value.length <= maxLength) {
    return {
      text: value,
      truncated: false
    };
  }

  return {
    text: `${value.slice(0, maxLength)}\n\n... [truncated]`,
    truncated: true
  };
}

async function readGptEvidenceForRun(runStatePath) {
  const dispatchResultsPath = await findLatestDispatchResultsPath(runStatePath);

  if (!dispatchResultsPath) {
    throw createUserError("No dispatch-results.json found for this run. Execute dispatch first.");
  }

  const dispatchResults = await readJson(dispatchResultsPath);
  const gptInteractions = [];

  for (const result of dispatchResults?.results ?? []) {
    if (result?.runtime !== "gpt-runner") {
      continue;
    }

    const promptInfo = truncateText(extractPromptFromStderr(result?.stderr));
    const execution = parseExecutionMetadata(result?.stderr);

    gptInteractions.push({
      taskId: result?.taskId ?? null,
      handoffId: result?.handoffId ?? null,
      status: result?.status ?? null,
      runtime: result?.runtime ?? null,
      preferredModel: parsePreferredModel(result?.stdout),
      model: execution.model,
      provider: execution.provider,
      sessionId: execution.sessionId,
      endpoint: execution.endpoint,
      cfRay: execution.cfRay,
      launcherPath: result?.launcherPath ?? null,
      resultPath: result?.resultPath ?? null,
      promptText: promptInfo.text,
      promptTextTruncated: promptInfo.truncated
    });
  }

  if (gptInteractions.length === 0) {
    throw createUserError("No gpt-runner execution records were found in dispatch-results.json.");
  }

  return {
    runStatePath,
    dispatchResultsPath,
    interactionCount: gptInteractions.length,
    gptInteractions
  };
}

async function handlePanelAction(state, action, payload = {}) {
  const defaults = getDefaultPaths(state.workspaceRoot);

  switch (action) {
    case "set-workspace": {
      const nextWorkspace = payload?.workspaceDir;

      if (typeof nextWorkspace !== "string" || nextWorkspace.trim().length === 0) {
        throw createUserError("Please provide workspaceDir.");
      }

      state.workspaceRoot = resolvePanelWorkspace(nextWorkspace);
      return {
        workspaceRoot: state.workspaceRoot
      };
    }
    case "init":
      return initProject(resolveWithinWorkspace(state.workspaceRoot, payload?.targetDir, state.workspaceRoot));
    case "intake": {
      const userRequest = typeof payload?.request === "string" ? payload.request : "";

      if (userRequest.trim().length === 0) {
        throw createUserError("Please provide request text for intake.");
      }

      return intakeRequest(userRequest, state.workspaceRoot);
    }
    case "confirm":
      return confirmIntake(state.workspaceRoot);
    case "revise":
      return reviseIntake(payload?.request, state.workspaceRoot);
    case "validate":
      return validateSpec(resolveWithinWorkspace(state.workspaceRoot, payload?.specPath, defaults.specPath));
    case "plan":
      return planProject(
        resolveWithinWorkspace(state.workspaceRoot, payload?.specPath, defaults.specPath),
        resolveWithinWorkspace(state.workspaceRoot, payload?.outputDir, defaults.runsDir)
      );
    case "run":
      return runProject(
        resolveWithinWorkspace(state.workspaceRoot, payload?.specPath, defaults.specPath),
        resolveWithinWorkspace(state.workspaceRoot, payload?.outputDir, defaults.runsDir),
        payload?.runId
      );
    case "doctor":
      return runRuntimeDoctor(resolveWithinWorkspace(state.workspaceRoot, payload?.outputDir, defaults.reportsDir));
    case "report": {
      const runStatePath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.runStatePath,
        await findLatestRunStatePath(state.workspaceRoot)
      );

      if (typeof runStatePath !== "string" || runStatePath.trim().length === 0) {
        throw createUserError("No run-state.json found. Create a run first.");
      }

      return reportProjectRun(runStatePath);
    }
    case "handoff": {
      const runStatePath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.runStatePath,
        await findLatestRunStatePath(state.workspaceRoot)
      );

      if (typeof runStatePath !== "string" || runStatePath.trim().length === 0) {
        throw createUserError("No run-state.json found. Create a run first.");
      }

      return createRunHandoffs(runStatePath, payload?.outputDir, payload?.doctorReportPath);
    }
    case "dispatch": {
      const fallbackRunStatePath = await findLatestRunStatePath(state.workspaceRoot);
      const fallbackHandoffIndexPath = fallbackRunStatePath
        ? await resolveDefaultHandoffIndexPath(fallbackRunStatePath).catch(() => null)
        : null;
      const handoffIndexPath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.handoffIndexPath,
        fallbackHandoffIndexPath
      );

      if (typeof handoffIndexPath !== "string" || handoffIndexPath.trim().length === 0) {
        throw createUserError("No handoff index was found. Generate handoffs first.");
      }

      const mode = payload?.mode === "execute" ? "execute" : "dry-run";
      return dispatchHandoffs(handoffIndexPath, mode);
    }
    case "autonomous": {
      const runStatePath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.runStatePath,
        await findLatestRunStatePath(state.workspaceRoot)
      );

      if (typeof runStatePath !== "string" || runStatePath.trim().length === 0) {
        throw createUserError("No run-state.json found. Create a run first.");
      }

      const parsedRounds =
        payload?.maxRounds === undefined || payload?.maxRounds === null || String(payload.maxRounds).trim().length === 0
          ? undefined
          : Number.parseInt(String(payload.maxRounds), 10);
      const maxRounds = Number.isFinite(parsedRounds) ? parsedRounds : undefined;
      const doctorReportPath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.doctorReportPath,
        path.join(defaults.reportsDir, "runtime-doctor.json")
      );
      const handoffOutputDir = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.outputDir,
        path.join(path.dirname(runStatePath), "handoffs")
      );

      return runAutonomousLoop(runStatePath, {
        doctorReportPath,
        handoffOutputDir,
        maxRounds
      });
    }
    case "gpt-evidence": {
      const runStatePath = resolveWithinWorkspace(
        state.workspaceRoot,
        payload?.runStatePath,
        await findLatestRunStatePath(state.workspaceRoot)
      );

      if (typeof runStatePath !== "string" || runStatePath.trim().length === 0) {
        throw createUserError("No run-state.json found. Create a run first.");
      }

      return readGptEvidenceForRun(runStatePath);
    }
    case "status":
      return buildWorkspaceOverview(state.workspaceRoot);
    default:
      throw createUserError(`Unsupported panel action: ${action}`);
  }
}

async function readJsonRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_REQUEST_BYTES) {
      throw createHttpError("Request body is too large.", 413);
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();

  if (text.length === 0) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw createUserError("Request body must be valid JSON.");
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function renderPanelHtml(workspaceRoot) {
  const escapedWorkspace = escapeHtml(workspaceRoot);
  const serializedWorkspace = JSON.stringify(workspaceRoot);

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AI Factory 中文操作面板</title>
  <style>
    :root { --ink:#132238; --sub:#4a6078; --bg:#eef4f8; --card:#fff; --line:#d8e3ef; --accent:#0f9d7a; --warn:#bf6f15; --bad:#bb3a43; --code:#0f1727; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Noto Sans TC","Microsoft JhengHei",ui-sans-serif,system-ui,sans-serif; color:var(--ink); background:radial-gradient(circle at 0% 0%, rgba(15,157,122,.08), transparent 45%),radial-gradient(circle at 100% 100%, rgba(30,94,157,.08), transparent 45%),var(--bg); }
    .shell { max-width:1080px; margin:0 auto; padding:22px 16px 28px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
    .hero { grid-column:1/-1; background:linear-gradient(160deg,#f7fcff,#f5fdfa); border:1px solid var(--line); border-radius:18px; padding:16px 18px; box-shadow:0 8px 20px rgba(16,54,87,.08); }
    .hero h1 { margin:0 0 6px; font-size:1.35rem; letter-spacing:.01em; }
    .hero p { margin:0; color:var(--sub); line-height:1.6; }
    .steps { margin:10px 0 0; padding-left:20px; color:#335374; line-height:1.6; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:14px; box-shadow:0 6px 16px rgba(16,54,87,.06); }
    .card h2 { margin:0 0 8px; font-size:1rem; }
    .hint { margin:0 0 10px; color:var(--sub); font-size:.9rem; line-height:1.55; }
    label { display:block; font-size:.84rem; color:#335374; margin-bottom:5px; font-weight:600; }
    input, textarea { width:100%; border:1px solid #cfdbea; border-radius:11px; padding:10px 11px; font:inherit; color:var(--ink); background:#fbfeff; }
    textarea { min-height:118px; resize:vertical; line-height:1.55; }
    .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .actions { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px; margin-top:10px; }
    button { border:0; border-radius:11px; padding:9px 10px; font:inherit; cursor:pointer; color:#fff; background:linear-gradient(140deg,var(--accent),#13b78d); box-shadow:0 8px 18px rgba(15,157,122,.28); }
    button:hover { filter:brightness(1.03); }
    button[data-tone="neutral"] { background:linear-gradient(140deg,#4b6d93,#365374); box-shadow:0 8px 18px rgba(39,70,108,.24); }
    button[data-tone="warn"] { background:linear-gradient(140deg,#d1832f,#b2600f); box-shadow:0 8px 18px rgba(178,96,15,.24); }
    .status-pill { display:inline-flex; align-items:center; gap:8px; border-radius:999px; padding:7px 12px; font-size:.84rem; font-weight:600; background:rgba(18,143,98,.13); color:#136548; }
    .status-pill.warn { background:rgba(193,119,31,.16); color:#8d5112; }
    .status-pill.error { background:rgba(187,58,67,.14); color:#8d2028; }
    .kv { margin:10px 0 0; display:grid; grid-template-columns:130px 1fr; row-gap:6px; column-gap:10px; font-size:.88rem; }
    .kv dt { color:#48627f; font-weight:600; }
    .kv dd { margin:0; word-break:break-word; color:#142b45; }
    details { border:1px dashed #cad7e8; border-radius:12px; padding:10px; background:#fafdff; }
    details > summary { cursor:pointer; font-size:.9rem; font-weight:600; color:#365374; margin-bottom:8px; }
    pre { margin:0; padding:12px; border-radius:12px; border:1px solid #dde6f3; background:var(--code); color:#dbe6f4; font-family:"Cascadia Code",Consolas,monospace; font-size:.8rem; line-height:1.5; max-height:360px; overflow:auto; }
    @media (max-width: 680px) { .grid-2 { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <h1>AI Factory 中文操作面板</h1>
      <p>給人類操作的簡化流程：一鍵完成初始化、需求澄清、確認、建立 Run、全自動執行。</p>
      <ol class="steps">
        <li>先確認工作區路徑</li>
        <li>輸入需求文字</li>
        <li>按「一鍵開始（推薦）」</li>
      </ol>
      <p style="margin-top:8px"><strong>目前工作區：</strong> <code id="workspaceTag">${escapedWorkspace}</code></p>
    </section>

    <section class="card">
      <h2>基本設定</h2>
      <p class="hint">一般情況下按一鍵開始即可。需要時再使用進階按鈕。</p>
      <label for="workspaceInput">工作區路徑</label>
      <input id="workspaceInput" value="${escapedWorkspace}" />
      <label for="requestInput" style="margin-top:10px">需求內容</label>
      <textarea id="requestInput">Read local sales.json and write summary.md to artifacts/reports; do not send email and do not call external APIs.</textarea>
      <div class="grid-2" style="margin-top:10px">
        <div>
          <label for="runIdInput">Run ID（可留空）</label>
          <input id="runIdInput" placeholder="例如 today-run-001" />
        </div>
        <div>
          <label for="maxRoundsInput">最大自動輪數</label>
          <input id="maxRoundsInput" value="8" />
        </div>
      </div>
      <div class="actions">
        <button id="applyWorkspaceBtn" data-tone="neutral">套用工作區</button>
        <button id="quickStartBtn" data-tone="warn">一鍵開始（推薦）</button>
        <button id="refreshStatusBtn" data-tone="neutral">重新整理狀態</button>
        <button id="viewGptPromptBtn" data-tone="neutral">查看 GPT 發問內容</button>
      </div>
    </section>

    <section class="card">
      <h2>目前狀態</h2>
      <div id="statusPill" class="status-pill">讀取中...</div>
      <dl class="kv" id="statusDetail"></dl>
    </section>

    <section class="card">
      <h2>進階操作（選用）</h2>
      <details>
        <summary>展開進階按鈕</summary>
        <p class="hint">只有需要手動排查時才用，平常不用。</p>
        <div class="actions">
          <button id="initBtn">只做初始化</button>
          <button id="intakeBtn">只做需求澄清</button>
          <button id="confirmBtn">只做需求確認</button>
          <button id="runBtn">只建立 Run</button>
          <button id="autonomousBtn" data-tone="warn">只跑全自動</button>
          <button id="doctorBtn" data-tone="neutral">環境健康檢查</button>
        </div>
      </details>
    </section>

    <section class="card" style="grid-column: 1 / -1">
      <h2>操作紀錄</h2>
      <p class="hint">每次動作的回應都會顯示在這裡。</p>
      <pre id="logBox">等待操作...</pre>
    </section>
  </main>

  <script>
    const initialWorkspace = ${serializedWorkspace};
    const workspaceInput = document.getElementById("workspaceInput");
    const workspaceTag = document.getElementById("workspaceTag");
    const requestInput = document.getElementById("requestInput");
    const runIdInput = document.getElementById("runIdInput");
    const maxRoundsInput = document.getElementById("maxRoundsInput");
    const statusPill = document.getElementById("statusPill");
    const statusDetail = document.getElementById("statusDetail");
    const logBox = document.getElementById("logBox");

    const runStatusLabelMap = {
      planned: "已規劃",
      in_progress: "進行中",
      completed: "已完成",
      attention_required: "需要人工處理",
      pending: "等待中",
      ready: "可執行",
      waiting_retry: "等待重試",
      blocked: "已阻塞",
      failed: "已失敗",
      "not-found": "尚未建立",
      "no-run": "尚未建立"
    };

    const intakeStatusLabelMap = {
      clarifying: "澄清中",
      awaiting_confirmation: "等待確認",
      confirmed: "已確認",
      clarification_blocked: "確認失敗（需補資訊）",
      clarification_abandoned: "已放棄",
      "not-found": "尚未建立"
    };

    workspaceInput.value = initialWorkspace;

    function setButtonsDisabled(disabled) {
      for (const button of document.querySelectorAll("button")) {
        button.disabled = disabled;
        button.style.opacity = disabled ? "0.65" : "1";
      }
    }

    async function parseJsonResponse(response) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: "伺服器回傳非 JSON 內容。", raw: text };
      }
    }

    async function callApi(urlPath, options = {}) {
      const response = await fetch(urlPath, options);
      const payload = await parseJsonResponse(response);
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || payload.message || "API 呼叫失敗。");
      }
      return payload;
    }

    function setLog(title, value) {
      const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      logBox.textContent = "[" + new Date().toLocaleString() + "] " + title + "\\n\\n" + body;
    }

    function labelForRunStatus(value) { return runStatusLabelMap[value] || value || "-"; }
    function labelForIntakeStatus(value) { return intakeStatusLabelMap[value] || value || "-"; }

    function renderStatus(overview) {
      workspaceTag.textContent = overview.workspaceRoot;
      const intakeState = overview.intake?.clarificationStatus || "not-found";
      const runState = overview.latestRun?.summary?.status || "no-run";
      const waitingConfirm = overview.intake?.exists && overview.intake?.confirmedByUser === false;
      statusPill.textContent = "需求狀態：" + labelForIntakeStatus(intakeState) + " | 執行狀態：" + labelForRunStatus(runState);
      statusPill.className = "status-pill";
      if (waitingConfirm) { statusPill.classList.add("warn"); }
      if (overview.latestRun?.summary?.blockedTasks > 0 || overview.latestRun?.summary?.failedTasks > 0) {
        statusPill.classList.remove("warn");
        statusPill.classList.add("error");
      }

      const latestRun = overview.latestRun || {};
      const summary = latestRun.summary || {};
      const fields = [
        ["工作區", overview.workspaceRoot],
        ["規格檔", overview.defaults?.specPath || "-"],
        ["最新 Run 檔案", latestRun.runStatePath || "-"],
        ["Run ID", summary.runId || "-"],
        ["需求狀態", labelForIntakeStatus(intakeState)],
        ["執行狀態", labelForRunStatus(summary.status || runState)],
        ["已完成任務", String(summary.completedTasks ?? "-")],
        ["可執行任務", String(summary.readyTasks ?? "-")],
        ["阻塞任務", String(summary.blockedTasks ?? "-")],
        ["失敗任務", String(summary.failedTasks ?? "-")]
      ];
      statusDetail.innerHTML = fields.map(([key, value]) => "<dt>" + key + "</dt><dd>" + String(value) + "</dd>").join("");
    }

    async function setWorkspace(logResult = true) {
      const workspaceDir = workspaceInput.value.trim();
      const result = await callApi("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-workspace", payload: { workspaceDir } })
      });
      if (logResult) { setLog("套用工作區", result); }
      await refreshStatus();
      return result;
    }

    async function invokeAction(action, payload = {}, logTitle = action) {
      const result = await callApi("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, payload })
      });
      setLog(logTitle, result);
      await refreshStatus();
      return result;
    }

    async function refreshStatus() {
      const workspaceDir = workspaceInput.value.trim();
      await callApi("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-workspace", payload: { workspaceDir } })
      });
      const overviewPayload = await callApi("/api/status");
      renderStatus(overviewPayload.overview);
      return overviewPayload;
    }

    async function runAction(action, payload = {}, logTitle = action) {
      setButtonsDisabled(true);
      try {
        await setWorkspace(false);
        await invokeAction(action, payload, logTitle);
      } catch (error) {
        setLog(logTitle + " 失敗", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        setButtonsDisabled(false);
      }
    }

    async function runQuickStart() {
      setButtonsDisabled(true);
      try {
        const requestText = requestInput.value.trim();
        if (requestText.length === 0) {
          throw new Error("請先輸入需求內容。");
        }
        await setWorkspace(false);
        await invokeAction("init", {}, "步驟 1/5：初始化");
        await invokeAction("intake", { request: requestText }, "步驟 2/5：需求澄清");
        await invokeAction("confirm", {}, "步驟 3/5：需求確認");
        const runResult = await invokeAction("run", { runId: runIdInput.value.trim() || undefined }, "步驟 4/5：建立 Run");
        const runStatePath = runResult?.result?.statePath;
        const autonomousResult = await invokeAction(
          "autonomous",
          { runStatePath, maxRounds: maxRoundsInput.value.trim() || undefined },
          "步驟 5/5：全自動執行"
        );

        setLog("一鍵開始完成", {
          runId: runResult?.result?.runId ?? "-",
          finalStatus: autonomousResult?.result?.summary?.runSummary?.status ?? "unknown"
        });
        await refreshStatus();
      } catch (error) {
        setLog("一鍵開始失敗", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        setButtonsDisabled(false);
      }
    }

    document.getElementById("applyWorkspaceBtn").addEventListener("click", async () => {
      setButtonsDisabled(true);
      try {
        await setWorkspace(true);
      } catch (error) {
        setLog("套用工作區失敗", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        setButtonsDisabled(false);
      }
    });
    document.getElementById("quickStartBtn").addEventListener("click", runQuickStart);
    document.getElementById("refreshStatusBtn").addEventListener("click", async () => {
      setButtonsDisabled(true);
      try {
        await refreshStatus();
      } catch (error) {
        setLog("重新整理狀態失敗", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        setButtonsDisabled(false);
      }
    });
    document.getElementById("viewGptPromptBtn").addEventListener("click", () =>
      runAction("gpt-evidence", {}, "查看 GPT 發問內容")
    );

    document.getElementById("initBtn").addEventListener("click", () => runAction("init", {}, "只做初始化"));
    document.getElementById("intakeBtn").addEventListener("click", () =>
      runAction("intake", { request: requestInput.value }, "只做需求澄清")
    );
    document.getElementById("confirmBtn").addEventListener("click", () => runAction("confirm", {}, "只做需求確認"));
    document.getElementById("runBtn").addEventListener("click", () =>
      runAction("run", { runId: runIdInput.value.trim() || undefined }, "只建立 Run")
    );
    document.getElementById("autonomousBtn").addEventListener("click", () =>
      runAction("autonomous", { maxRounds: maxRoundsInput.value.trim() || undefined }, "只跑全自動")
    );
    document.getElementById("doctorBtn").addEventListener("click", () => runAction("doctor", {}, "環境健康檢查"));

    refreshStatus().catch((error) => {
      setLog("初始化狀態讀取失敗", { error: error instanceof Error ? error.message : String(error) });
    });
  </script>
</body>
</html>`;
}

async function handleRequest(request, response, state) {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && requestUrl.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(renderPanelHtml(state.workspaceRoot));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/status") {
    const overview = await buildWorkspaceOverview(state.workspaceRoot);
    sendJson(response, 200, {
      ok: true,
      overview
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/action") {
    const body = await readJsonRequestBody(request);
    const action = typeof body.action === "string" ? body.action : "";

    if (action.trim().length === 0) {
      throw createUserError("Please provide an action.");
    }

    const result = await handlePanelAction(state, action.trim(), body.payload ?? {});
    const overview = await buildWorkspaceOverview(state.workspaceRoot);

    sendJson(response, 200, {
      ok: true,
      action,
      result,
      overview
    });
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: `Unknown route: ${request.method} ${requestUrl.pathname}`
  });
}

export async function startPanelServer({
  workspaceDir = ".",
  host = DEFAULT_PANEL_HOST,
  port = DEFAULT_PANEL_PORT
} = {}) {
  const state = {
    workspaceRoot: resolvePanelWorkspace(workspaceDir)
  };
  const server = http.createServer((request, response) => {
    handleRequest(request, response, state).catch((error) => {
      const statusCode = readStatusCode(error) ?? 500;
      sendJson(response, statusCode, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    workspaceRoot: state.workspaceRoot,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}
