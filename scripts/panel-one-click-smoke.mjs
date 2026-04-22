import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputRoot = path.join(projectRoot, "reports", "panel-smoke");
const defaultWatchdogMs = 45 * 60 * 1000;
const defaultPollIntervalMs = 15 * 1000;
const defaultMaxRounds = 20;
const defaultImmutableInputPaths = Object.freeze(["data/brief.txt", "data/details.txt"]);
const briefToken = "BRIEF-PANEL-SMOKE-20260421-A";
const detailToken = "DETAIL-PANEL-SMOKE-20260421-B";
const defaultRequestText = [
  "Start: Local workspace contains data/brief.txt and data/details.txt, and artifacts/generated is writable.",
  "End point: Create artifacts/generated/summary.md from both local files without changing the input files.",
  `Success criteria: artifacts/generated/summary.md exists; summary.md includes the exact token ${briefToken}; summary.md includes the exact token ${detailToken}; summary.md contains a heading named Combined Notes; summary.md includes a short Chinese summary.`,
  "Input source: data/brief.txt; data/details.txt.",
  "Out of scope: do not modify input files; do not call external APIs; do not send email."
].join("\n");

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
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function parseArgs(argv) {
  const options = {
    outputRoot: defaultOutputRoot,
    watchdogMs: defaultWatchdogMs,
    pollIntervalMs: defaultPollIntervalMs,
    maxRounds: defaultMaxRounds,
    requestText: defaultRequestText
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];

    switch (argument) {
      case "--output-root":
        options.outputRoot = path.resolve(projectRoot, nextValue ?? options.outputRoot);
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
        options.maxRounds = parsePositiveInteger(nextValue, options.maxRounds);
        index += 1;
        break;
      case "--request-file":
        options.requestText = nextValue ? null : options.requestText;
        options.requestFile = nextValue ? path.resolve(projectRoot, nextValue) : null;
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node scripts/panel-one-click-smoke.mjs [options]

Options:
  --output-root <dir>        Directory that will receive panel-smoke evidence
  --watchdog-ms <ms>         Outer watchdog for the smoke harness (default: ${defaultWatchdogMs})
  --poll-interval-ms <ms>    /api/status polling interval (default: ${defaultPollIntervalMs})
  --max-rounds <count>       quick-start-safe autonomous maxRounds (default: ${defaultMaxRounds})
  --request-file <path>      Optional text file whose contents replace the default smoke request
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

async function writeText(filePath, value) {
  await writeFile(filePath, value, "utf8");
}

function hashTextSha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function resolveWorkspaceRelativePath(workspaceRoot, relativePath) {
  return path.join(workspaceRoot, ...String(relativePath ?? "").split(/[\\/]+/).filter(Boolean));
}

function sanitizeCheckIdSegment(value) {
  return (
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "input"
  );
}

async function captureSmokeInputSnapshots(workspaceRoot, relativePaths = defaultImmutableInputPaths) {
  const snapshots = [];

  for (const relativePath of relativePaths ?? []) {
    const absolutePath = resolveWorkspaceRelativePath(workspaceRoot, relativePath);
    const contents = await readFile(absolutePath, "utf8");
    snapshots.push({
      relativePath,
      exists: true,
      sha256: hashTextSha256(contents)
    });
  }

  return snapshots;
}

async function verifyGeneratedSummaryArtifact(workspaceRoot, options = {}) {
  const { immutableInputSnapshots = [] } = options;
  const summaryPath = path.join(workspaceRoot, "artifacts", "generated", "summary.md");
  let contents;

  try {
    contents = await readFile(summaryPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      passed: false,
      summaryPath,
      checks: [
        {
          id: "summary-exists",
          passed: false,
          message: `Generated summary artifact was not found: ${message}`
        }
      ]
    };
  }

  const checks = [
    {
      id: "summary-exists",
      passed: true,
      message: "Generated summary artifact exists."
    },
    {
      id: "brief-token",
      passed: contents.includes(briefToken),
      message: `summary.md must include exact token ${briefToken}.`
    },
    {
      id: "detail-token",
      passed: contents.includes(detailToken),
      message: `summary.md must include exact token ${detailToken}.`
    },
    {
      id: "combined-notes-heading",
      passed: /^#{1,6}\s+Combined Notes\s*$/m.test(contents),
      message: "summary.md must contain a heading named Combined Notes."
    },
    {
      id: "chinese-summary",
      passed: /[\p{Script=Han}]/u.test(contents),
      message: "summary.md must include at least one Chinese character."
    }
  ];

  for (const snapshot of immutableInputSnapshots) {
    const inputPath = resolveWorkspaceRelativePath(workspaceRoot, snapshot.relativePath);
    let message = `Input file ${snapshot.relativePath} must remain unchanged.`;
    const passed = await readFile(inputPath, "utf8")
      .then((currentContents) => snapshot.exists === true && hashTextSha256(currentContents) === snapshot.sha256)
      .catch((error) => {
        const details = error instanceof Error ? error.message : String(error);
        message = `Input file ${snapshot.relativePath} must remain unchanged and readable: ${details}`;
        return snapshot.exists === false;
      });

    checks.push({
      id: `input-immutable-${sanitizeCheckIdSegment(snapshot.relativePath)}`,
      passed,
      message
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    summaryPath,
    immutableInputSnapshots,
    checks
  };
}

function buildArtifactFailureMessage(artifactVerification) {
  const failedChecks = (artifactVerification?.checks ?? []).filter((check) => !check.passed);

  if (failedChecks.length === 0) {
    return "Generated summary artifact verification failed.";
  }

  return [
    "Generated summary artifact verification failed.",
    ...failedChecks.map((check) => `- ${check.message}`)
  ].join("\n");
}

function buildRunStatusFailureMessage(finalRunStatus) {
  if (finalRunStatus === "unknown") {
    return "Panel quick-start run did not complete before watchdog. finalRunStatus=unknown";
  }

  return `Panel quick-start run did not finish successfully. finalRunStatus=${finalRunStatus}`;
}

function readQuickStartTerminalStatus(quickStartResponse) {
  return (
    quickStartResponse?.result?.autonomous?.runSummary?.status ??
    quickStartResponse?.result?.autonomous?.finalStatus ??
    null
  );
}

function readStatusAfterTerminalStatus(statusAfter) {
  return statusAfter?.overview?.latestRun?.summary?.status ?? null;
}

function readAutonomousSummaryTerminalStatus(autonomousSummary) {
  return autonomousSummary?.finalStatus ?? autonomousSummary?.runSummary?.status ?? null;
}

function buildRunConsistencyVerification({
  runId,
  quickStartResponse,
  statusAfter,
  runState,
  autonomousSummary
}) {
  const quickStartRunId = quickStartResponse?.result?.run?.runId ?? null;
  const statusAfterRunId = statusAfter?.overview?.latestRun?.summary?.runId ?? null;
  const runStateRunId = runState?.runId ?? null;
  const autonomousSummaryRunId = autonomousSummary?.runId ?? null;
  const quickStartStatus = readQuickStartTerminalStatus(quickStartResponse);
  const statusAfterStatus = readStatusAfterTerminalStatus(statusAfter);
  const runStateStatus = runState?.status ?? null;
  const autonomousSummaryStatus = readAutonomousSummaryTerminalStatus(autonomousSummary);
  const checks = [
    {
      id: "quick-start-response-run-id",
      passed: quickStartRunId === runId,
      message: "quick-start response must report the expected runId."
    },
    {
      id: "status-after-run-id",
      passed: statusAfterRunId === runId,
      message: "/api/status must report the expected runId."
    },
    {
      id: "run-state-exists",
      passed: Boolean(runState),
      message: "run-state.json must exist."
    },
    {
      id: "run-state-run-id",
      passed: runStateRunId === runId,
      message: "run-state.json must report the expected runId."
    },
    {
      id: "autonomous-summary-exists",
      passed: Boolean(autonomousSummary),
      message: "autonomous-summary.json must exist."
    },
    {
      id: "autonomous-summary-run-id",
      passed: autonomousSummaryRunId === runId,
      message: "autonomous-summary.json must report the expected runId."
    },
    {
      id: "terminal-status-agreement",
      passed:
        [quickStartStatus, statusAfterStatus, runStateStatus, autonomousSummaryStatus].every((value) => value !== null) &&
        new Set([quickStartStatus, statusAfterStatus, runStateStatus, autonomousSummaryStatus]).size === 1,
      message: "quick-start response, /api/status, run-state.json, and autonomous-summary.json must agree on terminal status."
    }
  ];

  return {
    passed: checks.every((check) => check.passed),
    runId,
    observed: {
      quickStartRunId,
      statusAfterRunId,
      runStateRunId,
      autonomousSummaryRunId,
      quickStartStatus,
      statusAfterStatus,
      runStateStatus,
      autonomousSummaryStatus
    },
    checks
  };
}

function buildConsistencyFailureMessage(consistencyVerification) {
  const failedChecks = (consistencyVerification?.checks ?? []).filter((check) => !check.passed);

  if (failedChecks.length === 0) {
    return "Panel smoke evidence did not stay consistent across artifacts.";
  }

  return [
    "Panel smoke evidence did not stay consistent across artifacts.",
    ...failedChecks.map((check) => `- ${check.message}`)
  ].join("\n");
}

function requestJson(baseUrl, method, pathname, payload) {
  const url = new URL(pathname, baseUrl);
  const requestBody = payload === undefined ? null : JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestBody
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(requestBody)
            }
          : undefined
      },
      (response) => {
        let rawBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          rawBody += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};

            if ((response.statusCode ?? 500) >= 400 || parsed.ok === false) {
              reject(new Error(parsed.error ?? `Request failed: ${response.statusCode}`));
              return;
            }

            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);

    if (requestBody) {
      request.write(requestBody);
    }

    request.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedWorkspace(workspaceRoot) {
  await ensureDirectory(path.join(workspaceRoot, "data"));
  await ensureDirectory(path.join(workspaceRoot, "artifacts", "generated"));
  await writeText(
    path.join(workspaceRoot, "data", "brief.txt"),
    "Brief token: BRIEF-PANEL-SMOKE-20260421-A\n"
  );
  await writeText(
    path.join(workspaceRoot, "data", "details.txt"),
    "Details token: DETAIL-PANEL-SMOKE-20260421-B\n"
  );
}

async function startPanelProcess(workspaceRoot, stdoutPath, stderrPath) {
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let panelUrl = null;
  let panelReadyResolve;
  let panelReadyReject;

  const panelReady = new Promise((resolve, reject) => {
    panelReadyResolve = resolve;
    panelReadyReject = reject;
  });
  const panelChild = spawn(process.execPath, ["src/index.mjs", "panel", workspaceRoot, "0"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  panelChild.stdout.on("data", async (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    await writeText(stdoutPath, stdoutBuffer);
    const urlMatch = stdoutBuffer.match(/Panel URL:\s*(http:\/\/[^\s]+)/);

    if (urlMatch && !panelUrl) {
      panelUrl = urlMatch[1];
      panelReadyResolve(panelUrl);
    }
  });

  panelChild.stderr.on("data", async (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    await writeText(stderrPath, stderrBuffer);
  });

  panelChild.once("error", (error) => {
    panelReadyReject(error);
  });

  panelChild.once("close", (code) => {
    if (!panelUrl) {
      panelReadyReject(new Error(`panel exited before reporting URL (code=${code ?? "unknown"})`));
    }
  });

  return {
    panelChild,
    panelReady
  };
}

async function copyFileIfPresent(sourcePath, destinationPath) {
  try {
    const contents = await readFile(sourcePath, "utf8");
    await writeText(destinationPath, contents);
  } catch {
    // Best-effort evidence copy.
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function stopPanelProcess(panelChild) {
  if (panelChild.exitCode !== null || panelChild.signalCode !== null) {
    return;
  }

  const waitForExit = (timeoutMs) =>
    new Promise((resolve) => {
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
        panelChild.off("close", onClose);
      };

      panelChild.once("close", onClose);
    });

  panelChild.kill("SIGINT");
  if (await waitForExit(1000)) {
    return;
  }

  if (panelChild.exitCode === null && panelChild.signalCode === null) {
    panelChild.kill("SIGTERM");
    await waitForExit(1000);
  }
}

async function resolveRequestText(options) {
  if (!options.requestFile) {
    return options.requestText;
  }

  return readFile(options.requestFile, "utf8");
}

async function runPanelOneClickSmoke(options) {
  const requestText = await resolveRequestText(options);
  const startedAt = new Date();
  const evidenceRoot = path.join(options.outputRoot, `panel-one-click-${timestampLabel()}`);
  const workspaceRoot = path.join(evidenceRoot, "workspace");
  const runId = `panel-live-smoke-${timestampLabel()}`;
  const stdoutPath = path.join(evidenceRoot, "panel.stdout.log");
  const stderrPath = path.join(evidenceRoot, "panel.stderr.log");

  await ensureDirectory(evidenceRoot);
  await seedWorkspace(workspaceRoot);
  const immutableInputSnapshots = await captureSmokeInputSnapshots(workspaceRoot);
  await writeJson(path.join(evidenceRoot, "input-snapshots.json"), immutableInputSnapshots);
  const { panelChild, panelReady } = await startPanelProcess(workspaceRoot, stdoutPath, stderrPath);

  let panelUrl = null;
  let statusBefore = null;
  let intakePreview = null;
  /** @type {any} */
  let quickStartResponse = null;
  let latestStatus = null;
  let quickStartSettled = false;
  /** @type {unknown} */
  let quickStartError = null;
  const pollSnapshots = [];
  /** @type {any} */
  let summary;
  let artifactVerification;
  let consistencyVerification;

  try {
    panelUrl = await Promise.race([
      panelReady,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("panel startup timed out")), 30_000)
      )
    ]);

    statusBefore = await requestJson(panelUrl, "GET", "/api/status");
    intakePreview = await requestJson(panelUrl, "POST", "/api/action", {
      action: "intake-preview",
      payload: { request: requestText }
    });

    const quickStartPromise = requestJson(panelUrl, "POST", "/api/action", {
      action: "quick-start-safe",
      payload: {
        request: requestText,
        runId,
        maxRounds: options.maxRounds,
        previewDigest: intakePreview.result.preview.previewDigest,
        confirmationText: intakePreview.result.preview.confirmationToken
      }
    })
      .then((response) => {
        quickStartSettled = true;
        quickStartResponse = response;
        return response;
      })
      .catch((error) => {
        quickStartSettled = true;
        quickStartError = error;
        throw error;
      });

    const deadline = Date.now() + options.watchdogMs;

    while (Date.now() < deadline) {
      await delay(options.pollIntervalMs);
      latestStatus = await requestJson(panelUrl, "GET", "/api/status");
      pollSnapshots.push({
        collectedAt: new Date().toISOString(),
        status: latestStatus
      });

      const latestRunSummary = latestStatus?.overview?.latestRun?.summary ?? {};

      if (latestRunSummary.runId === runId && latestRunSummary.status === "completed") {
        break;
      }

      if (quickStartSettled) {
        break;
      }
    }

    if (!quickStartSettled) {
      await Promise.race([quickStartPromise.catch(() => undefined), delay(30_000)]);
    } else {
      await quickStartPromise.catch(() => undefined);
    }

    const runRoot = path.join(workspaceRoot, "runs", runId);
    const runState = await readJsonIfPresent(path.join(runRoot, "run-state.json"));
    const autonomousSummary = await readJsonIfPresent(path.join(runRoot, "autonomous-summary.json"));
    const finalRunStatus =
      quickStartResponse?.result?.autonomous?.runSummary?.status ??
      latestStatus?.overview?.latestRun?.summary?.status ??
      "unknown";
    artifactVerification = await verifyGeneratedSummaryArtifact(workspaceRoot, {
      immutableInputSnapshots
    });
    consistencyVerification = buildRunConsistencyVerification({
      runId,
      quickStartResponse,
      statusAfter: latestStatus,
      runState,
      autonomousSummary
    });
    const completed = finalRunStatus === "completed";
    const harnessPassed = completed && artifactVerification.passed && consistencyVerification.passed;
    const summaryError =
      !completed || !artifactVerification.passed || !consistencyVerification.passed
        ? quickStartError
          ? quickStartError instanceof Error
            ? quickStartError.message
            : String(quickStartError)
          : !completed
            ? buildRunStatusFailureMessage(finalRunStatus)
            : !artifactVerification.passed
              ? buildArtifactFailureMessage(artifactVerification)
              : buildConsistencyFailureMessage(consistencyVerification)
        : null;

    summary = {
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      panelUrl,
      evidenceRoot,
      workspaceRoot,
      runId,
      clientMode: "node:http background quick-start-safe POST + /api/status polling",
      watchdogMs: options.watchdogMs,
      pollIntervalMs: options.pollIntervalMs,
      pollCount: pollSnapshots.length,
      quickStartSettled,
      finalRunStatus,
      harnessPassed,
      quickStartOutcome: quickStartResponse?.result?.outcome ?? null,
      artifactVerification,
      consistencyVerification,
      panelStdoutPath: stdoutPath,
      panelStderrPath: stderrPath,
      ...(summaryError ? { error: summaryError } : {})
    };
  } catch (error) {
    summary = {
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      panelUrl,
      evidenceRoot,
      workspaceRoot,
      runId,
      clientMode: "node:http background quick-start-safe POST + /api/status polling",
      watchdogMs: options.watchdogMs,
      pollIntervalMs: options.pollIntervalMs,
      pollCount: pollSnapshots.length,
      quickStartSettled,
      harnessPassed: false,
      error: error instanceof Error ? error.message : String(error),
      panelStdoutPath: stdoutPath,
      panelStderrPath: stderrPath
    };
  } finally {
    if (statusBefore) {
      await writeJson(path.join(evidenceRoot, "status-before.json"), statusBefore);
    }

    if (intakePreview) {
      await writeJson(path.join(evidenceRoot, "intake-preview.json"), intakePreview);
    }

    if (quickStartResponse) {
      await writeJson(path.join(evidenceRoot, "quick-start-response.json"), quickStartResponse);
    }

    if (latestStatus) {
      await writeJson(path.join(evidenceRoot, "status-after.json"), latestStatus);
    }

    if (pollSnapshots.length > 0) {
      await writeJson(path.join(evidenceRoot, "status-polls.json"), pollSnapshots);
    }

    const runRoot = path.join(workspaceRoot, "runs", runId);
    await copyFileIfPresent(
      path.join(workspaceRoot, "artifacts", "generated", "summary.md"),
      path.join(evidenceRoot, "summary.md")
    );
    await copyFileIfPresent(path.join(runRoot, "run-state.json"), path.join(evidenceRoot, "run-state.json"));
    await copyFileIfPresent(
      path.join(runRoot, "autonomous-summary.json"),
      path.join(evidenceRoot, "autonomous-summary.json")
    );
    if (artifactVerification) {
      await writeJson(path.join(evidenceRoot, "artifact-verification.json"), artifactVerification);
    }
    await writeJson(path.join(evidenceRoot, "panel-smoke-summary.json"), summary);
    await stopPanelProcess(panelChild);
  }

  return summary;
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDirectory(options.outputRoot);
  const summary = await runPanelOneClickSmoke(options);

  console.log(JSON.stringify(summary, null, 2));

  if (summary.harnessPassed !== true) {
    process.exitCode = 1;
  }
}

export {
  buildRunConsistencyVerification,
  captureSmokeInputSnapshots,
  isMainModule,
  parseArgs,
  runPanelOneClickSmoke,
  verifyGeneratedSummaryArtifact
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
