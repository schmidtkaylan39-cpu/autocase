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
      // Ignore directories without a run-state file.
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

async function resolveDefaultHandoffIndexPath(runStatePath) {
  const runDirectory = path.dirname(runStatePath);
  const runState = await readJson(runStatePath);
  const candidateDirectories = [path.join(runDirectory, "handoffs")];

  for (const task of runState.taskLedger ?? []) {
    if (typeof task.activeHandoffOutputDir === "string" && task.activeHandoffOutputDir.trim().length > 0) {
      candidateDirectories.push(path.resolve(task.activeHandoffOutputDir));
    }
  }

  for (const directoryPath of candidateDirectories) {
    const indexPath = path.join(directoryPath, "index.json");

    if (await pathExists(indexPath)) {
      return indexPath;
    }
  }

  throw new Error(
    `No handoff index was found for ${runStatePath}. Generate handoffs before dispatching.`
  );
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
      const runStatePath =
        resolveWithinWorkspace(
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
      const runStatePath =
        resolveWithinWorkspace(
          state.workspaceRoot,
          payload?.runStatePath,
          await findLatestRunStatePath(state.workspaceRoot)
        );

      if (typeof runStatePath !== "string" || runStatePath.trim().length === 0) {
        throw createUserError("No run-state.json found. Create a run first.");
      }

      return createRunHandoffs(
        runStatePath,
        payload?.outputDir,
        payload?.doctorReportPath
      );
    }
    case "dispatch": {
      const fallbackRunStatePath = await findLatestRunStatePath(state.workspaceRoot);
      const fallbackHandoffIndexPath = fallbackRunStatePath
        ? await resolveDefaultHandoffIndexPath(fallbackRunStatePath).catch(() => null)
        : null;
      const handoffIndexPath =
        resolveWithinWorkspace(
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
      const runStatePath =
        resolveWithinWorkspace(
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
  <title>AI Factory 控制面板</title>
  <style>
    :root {
      --ink: #132238;
      --subtle: #59708d;
      --line: #d9e3f1;
      --panel: #ffffff;
      --accent: #0f9d7a;
      --accent-strong: #0f7f63;
      --warning: #c76716;
      --error: #be2f3b;
      --bg-a: #eef8ff;
      --bg-b: #f9fff4;
      --bg-c: #fff8f1;
      --code: #0a1d2f;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--ink);
      font-family: "Noto Sans TC", "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
      background:
        radial-gradient(circle at 8% 10%, var(--bg-a), transparent 34%),
        radial-gradient(circle at 88% 15%, var(--bg-c), transparent 32%),
        radial-gradient(circle at 76% 84%, var(--bg-b), transparent 35%),
        #f4f7fb;
      min-height: 100vh;
      padding: 28px 18px 34px;
    }

    .shell {
      max-width: 1120px;
      margin: 0 auto;
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }

    .hero,
    .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: linear-gradient(170deg, #fff, #fdfefe 65%, #f7fcff);
      box-shadow: 0 12px 30px rgba(24, 46, 74, 0.06);
    }

    .hero {
      grid-column: 1 / -1;
      padding: 22px 22px 18px;
    }

    .hero h1 {
      margin: 0 0 8px;
      font-size: 1.45rem;
      letter-spacing: 0.01em;
    }

    .hero p {
      margin: 0;
      color: var(--subtle);
    }

    .card {
      padding: 16px;
    }

    .card h2 {
      margin: 0 0 12px;
      font-size: 1rem;
    }

    .hint {
      margin: 0 0 12px;
      color: var(--subtle);
      font-size: 0.92rem;
      line-height: 1.5;
    }

    label {
      display: block;
      margin: 0 0 6px;
      font-size: 0.84rem;
      color: #2f4a66;
    }

    input,
    textarea,
    select {
      width: 100%;
      border: 1px solid #c7d6ea;
      border-radius: 10px;
      padding: 9px 10px;
      font: inherit;
      color: var(--ink);
      background: #fff;
    }

    textarea {
      min-height: 92px;
      resize: vertical;
      line-height: 1.45;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .actions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 8px;
      margin-top: 10px;
    }

    button {
      border: 0;
      border-radius: 11px;
      padding: 9px 10px;
      font: inherit;
      cursor: pointer;
      color: #fff;
      background: linear-gradient(140deg, var(--accent), #13b78d);
      transition: transform 0.12s ease, box-shadow 0.2s ease, filter 0.15s ease;
      box-shadow: 0 8px 18px rgba(15, 157, 122, 0.28);
    }

    button:hover {
      filter: brightness(1.03);
      transform: translateY(-1px);
    }

    button[data-tone="neutral"] {
      background: linear-gradient(140deg, #4b6d93, #365374);
      box-shadow: 0 8px 18px rgba(39, 70, 108, 0.24);
    }

    button[data-tone="warn"] {
      background: linear-gradient(140deg, #d1832f, #b2600f);
      box-shadow: 0 8px 18px rgba(178, 96, 15, 0.24);
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 0 0 12px;
      border-radius: 999px;
      padding: 5px 11px;
      font-size: 0.8rem;
      background: #eef8f4;
      color: var(--accent-strong);
    }

    .status-pill.warn {
      background: #fff5ea;
      color: var(--warning);
    }

    .status-pill.error {
      background: #ffeff2;
      color: var(--error);
    }

    .kv {
      display: grid;
      grid-template-columns: 130px 1fr;
      gap: 6px 10px;
      font-size: 0.9rem;
    }

    .kv dt {
      color: var(--subtle);
    }

    .kv dd {
      margin: 0;
      word-break: break-all;
    }

    pre {
      margin: 0;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid #dde6f3;
      background: var(--code);
      color: #dbe6f4;
      font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
      font-size: 0.8rem;
      line-height: 1.5;
      max-height: 360px;
      overflow: auto;
    }

    @media (max-width: 680px) {
      .grid-2 {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <h1>AI Factory 本機控制面板</h1>
      <p>給人類操作的簡化入口。點按流程：初始化 → 需求 intake → confirm → 建立 run → autonomous。</p>
      <p style="margin-top:8px"><strong>目前工作目錄：</strong> <code id="workspaceTag">${escapedWorkspace}</code></p>
    </section>

    <section class="card">
      <h2>工作區設定</h2>
      <p class="hint">把你要執行任務的資料夾填在下面，先按「套用工作區」。</p>
      <label for="workspaceInput">Workspace 路徑</label>
      <input id="workspaceInput" value="${escapedWorkspace}" />
      <div class="actions">
        <button id="setWorkspaceBtn" data-tone="neutral">套用工作區</button>
        <button id="refreshStatusBtn" data-tone="neutral">重新整理狀態</button>
        <button id="initBtn">初始化 init</button>
      </div>
    </section>

    <section class="card">
      <h2>需求與執行</h2>
      <label for="requestInput">需求描述（給 intake）</label>
      <textarea id="requestInput">在本地資料夾讀取資料並輸出報告，不要呼叫外部 API。</textarea>
      <div class="grid-2" style="margin-top:10px">
        <div>
          <label for="runIdInput">Run ID（可留空）</label>
          <input id="runIdInput" placeholder="例如 prod-run-001" />
        </div>
        <div>
          <label for="maxRoundsInput">Autonomous 最大輪數</label>
          <input id="maxRoundsInput" value="8" />
        </div>
      </div>
      <div class="actions">
        <button id="intakeBtn">1. Intake</button>
        <button id="confirmBtn">2. Confirm</button>
        <button id="runBtn">3. 建立 Run</button>
        <button id="autonomousBtn" data-tone="warn">4. Autonomous</button>
      </div>
      <div class="actions">
        <button id="doctorBtn" data-tone="neutral">Doctor</button>
        <button id="handoffBtn" data-tone="neutral">Handoff</button>
        <button id="dispatchDryBtn" data-tone="neutral">Dispatch Dry-run</button>
        <button id="dispatchExecBtn" data-tone="neutral">Dispatch Execute</button>
      </div>
    </section>

    <section class="card">
      <h2>目前狀態</h2>
      <div id="statusPill" class="status-pill">讀取中…</div>
      <dl class="kv" id="statusDetail"></dl>
    </section>

    <section class="card" style="grid-column: 1 / -1">
      <h2>執行回應</h2>
      <p class="hint">每次操作都會把 API 回應寫在這裡，方便你追蹤。</p>
      <pre id="logBox">等待操作…</pre>
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
        return {
          ok: false,
          error: "Server returned invalid JSON.",
          raw: text
        };
      }
    }

    async function callApi(path, options = {}) {
      const response = await fetch(path, options);
      const payload = await parseJsonResponse(response);

      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || payload.message || "API request failed.");
      }

      return payload;
    }

    function setLog(title, value) {
      const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      logBox.textContent = "[" + new Date().toLocaleString() + "] " + title + "\\n\\n" + body;
    }

    function renderStatus(overview) {
      workspaceTag.textContent = overview.workspaceRoot;

      const intakeState = overview.intake?.clarificationStatus || "not-found";
      const runState = overview.latestRun?.summary?.status || "no-run";
      const waitingConfirm = overview.intake?.exists && overview.intake?.confirmedByUser === false;

      statusPill.textContent = "Intake: " + intakeState + " | Run: " + runState;
      statusPill.className = "status-pill";

      if (waitingConfirm) {
        statusPill.classList.add("warn");
      }

      if (overview.latestRun?.summary?.blockedTasks > 0 || overview.latestRun?.summary?.failedTasks > 0) {
        statusPill.classList.remove("warn");
        statusPill.classList.add("error");
      }

      const latestRun = overview.latestRun || {};
      const summary = latestRun.summary || {};
      const fields = [
        ["Workspace", overview.workspaceRoot],
        ["Spec", overview.defaults?.specPath || "-"],
        ["Intake Spec", overview.intake?.intakeSpecPath || "-"],
        ["Latest Run", latestRun.runStatePath || "-"],
        ["Run ID", summary.runId || "-"],
        ["Run Status", summary.status || "-"],
        ["Completed", String(summary.completedTasks ?? "-")],
        ["Ready", String(summary.readyTasks ?? "-")],
        ["Blocked", String(summary.blockedTasks ?? "-")],
        ["Failed", String(summary.failedTasks ?? "-")]
      ];

      statusDetail.innerHTML = fields
        .map(([key, value]) => "<dt>" + key + "</dt><dd>" + String(value) + "</dd>")
        .join("");
    }

    async function setWorkspace() {
      const workspaceDir = workspaceInput.value.trim();
      const result = await callApi("/api/action", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          action: "set-workspace",
          payload: {
            workspaceDir
          }
        })
      });

      setLog("set-workspace", result);
      await refreshStatus();
      return result;
    }

    async function runAction(action, payload = {}) {
      setButtonsDisabled(true);

      try {
        await setWorkspace();
        const result = await callApi("/api/action", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            action,
            payload
          })
        });
        setLog(action, result);
        await refreshStatus();
      } catch (error) {
        setLog(action + " failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        setButtonsDisabled(false);
      }
    }

    async function refreshStatus() {
      const workspaceDir = workspaceInput.value.trim();
      const status = await callApi("/api/action", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          action: "set-workspace",
          payload: {
            workspaceDir
          }
        })
      });

      const overviewPayload = await callApi("/api/status");
      renderStatus(overviewPayload.overview);
      return {
        status,
        overviewPayload
      };
    }

    document.getElementById("setWorkspaceBtn").addEventListener("click", async () => {
      setButtonsDisabled(true);
      try {
        await setWorkspace();
      } catch (error) {
        setLog("set-workspace failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        setButtonsDisabled(false);
      }
    });

    document.getElementById("refreshStatusBtn").addEventListener("click", async () => {
      setButtonsDisabled(true);
      try {
        await refreshStatus();
      } catch (error) {
        setLog("status refresh failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        setButtonsDisabled(false);
      }
    });

    document.getElementById("initBtn").addEventListener("click", () => runAction("init"));
    document.getElementById("intakeBtn").addEventListener("click", () =>
      runAction("intake", {
        request: requestInput.value
      })
    );
    document.getElementById("confirmBtn").addEventListener("click", () => runAction("confirm"));
    document.getElementById("runBtn").addEventListener("click", () =>
      runAction("run", {
        runId: runIdInput.value.trim() || undefined
      })
    );
    document.getElementById("autonomousBtn").addEventListener("click", () =>
      runAction("autonomous", {
        maxRounds: maxRoundsInput.value.trim() || undefined
      })
    );
    document.getElementById("doctorBtn").addEventListener("click", () => runAction("doctor"));
    document.getElementById("handoffBtn").addEventListener("click", () => runAction("handoff"));
    document.getElementById("dispatchDryBtn").addEventListener("click", () =>
      runAction("dispatch", {
        mode: "dry-run"
      })
    );
    document.getElementById("dispatchExecBtn").addEventListener("click", () =>
      runAction("dispatch", {
        mode: "execute"
      })
    );

    refreshStatus().catch((error) => {
      setLog("initial refresh failed", {
        error: error instanceof Error ? error.message : String(error)
      });
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
