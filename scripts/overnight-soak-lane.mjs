import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBurninRounds = 12;
const defaultE2eRounds = 12;
const defaultAcceptanceSuccesses = 8;
const defaultAcceptanceMaxAttempts = 12;
const defaultAcceptanceMaxRounds = 20;
const defaultPanelMaxRounds = 20;
const defaultPanelWatchdogMs = 2_700_000;
const defaultPanelPollIntervalMs = 15_000;
const npmCliCandidates = [
  process.env.npm_execpath,
  path.resolve(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
const npmCliPath = npmCliCandidates.find((candidate) => existsSync(candidate));
const npmRunner = npmCliPath
  ? {
      command: process.execPath,
      fixedArgs: [npmCliPath],
      shell: false,
      display: "npm"
    }
  : process.platform === "win32"
    ? {
        command: "npm.cmd",
        fixedArgs: [],
        shell: false,
        display: "npm"
      }
    : {
        command: "npm",
        fixedArgs: [],
        shell: false,
        display: "npm"
      };

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

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function parsePositiveInteger(value, fallbackValue, label) {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsedValue;
}

function printHelp() {
  console.log(`Usage: node scripts/overnight-soak-lane.mjs [options]

Options:
  --output-root <path>               Isolated output root for the overnight lane
  --burnin-rounds <n>                Quality burn-in rounds (default: ${defaultBurninRounds})
  --e2e-rounds <n>                   Repeated npm run test:e2e rounds (default: ${defaultE2eRounds})
  --acceptance-successes <n>         Required live acceptance successes (default: ${defaultAcceptanceSuccesses})
  --acceptance-max-attempts <n>      Live acceptance max attempts (default: ${defaultAcceptanceMaxAttempts})
  --acceptance-max-rounds <n>        Live acceptance autonomous max rounds (default: ${defaultAcceptanceMaxRounds})
  --panel-max-rounds <n>             Panel browser max rounds (default: ${defaultPanelMaxRounds})
  --panel-watchdog-ms <ms>           Panel browser watchdog timeout (default: ${defaultPanelWatchdogMs})
  --panel-poll-interval-ms <ms>      Panel browser poll interval (default: ${defaultPanelPollIntervalMs})
  --help                             Show this help message
`);
}

function parseArgs(argv) {
  const options = {
    outputRoot: path.join(projectRoot, "reports", "soak", `overnight-lane-${timestampLabel()}`),
    burninRounds: defaultBurninRounds,
    e2eRounds: defaultE2eRounds,
    acceptanceSuccesses: defaultAcceptanceSuccesses,
    acceptanceMaxAttempts: defaultAcceptanceMaxAttempts,
    acceptanceMaxRounds: defaultAcceptanceMaxRounds,
    panelMaxRounds: defaultPanelMaxRounds,
    panelWatchdogMs: defaultPanelWatchdogMs,
    panelPollIntervalMs: defaultPanelPollIntervalMs
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const nextValue = argv[index + 1];

    switch (token) {
      case "--output-root":
        if (!nextValue) {
          throw new Error("Missing value for --output-root");
        }
        options.outputRoot = path.resolve(projectRoot, nextValue);
        index += 1;
        break;
      case "--burnin-rounds":
        options.burninRounds = parsePositiveInteger(nextValue, options.burninRounds, "--burnin-rounds");
        index += 1;
        break;
      case "--e2e-rounds":
        options.e2eRounds = parsePositiveInteger(nextValue, options.e2eRounds, "--e2e-rounds");
        index += 1;
        break;
      case "--acceptance-successes":
        options.acceptanceSuccesses = parsePositiveInteger(
          nextValue,
          options.acceptanceSuccesses,
          "--acceptance-successes"
        );
        index += 1;
        break;
      case "--acceptance-max-attempts":
        options.acceptanceMaxAttempts = parsePositiveInteger(
          nextValue,
          options.acceptanceMaxAttempts,
          "--acceptance-max-attempts"
        );
        index += 1;
        break;
      case "--acceptance-max-rounds":
        options.acceptanceMaxRounds = parsePositiveInteger(
          nextValue,
          options.acceptanceMaxRounds,
          "--acceptance-max-rounds"
        );
        index += 1;
        break;
      case "--panel-max-rounds":
        options.panelMaxRounds = parsePositiveInteger(nextValue, options.panelMaxRounds, "--panel-max-rounds");
        index += 1;
        break;
      case "--panel-watchdog-ms":
        options.panelWatchdogMs = parsePositiveInteger(nextValue, options.panelWatchdogMs, "--panel-watchdog-ms");
        index += 1;
        break;
      case "--panel-poll-interval-ms":
        options.panelPollIntervalMs = parsePositiveInteger(
          nextValue,
          options.panelPollIntervalMs,
          "--panel-poll-interval-ms"
        );
        index += 1;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  if (options.acceptanceMaxAttempts < options.acceptanceSuccesses) {
    throw new Error(
      `--acceptance-max-attempts must be >= --acceptance-successes (${options.acceptanceMaxAttempts} < ${options.acceptanceSuccesses})`
    );
  }

  return options;
}

async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
  return targetPath;
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalJson(targetPath) {
  if (!(await fileExists(targetPath))) {
    return null;
  }

  return JSON.parse((await readFile(targetPath, "utf8")).replace(/^\uFEFF/, ""));
}

async function writeJson(targetPath, value) {
  await ensureDirectory(path.dirname(targetPath));
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function endLogStream(logStream) {
  await new Promise((resolve) => logStream.end(resolve));
}

async function runLoggedCommand({ command, args, label, logPath, cwd = projectRoot, env = process.env, shell = false }) {
  await ensureDirectory(path.dirname(logPath));
  const startedMs = Date.now();
  const logStream = createWriteStream(logPath, { flags: "w" });
  logStream.write(`[command] ${label}\n`);
  logStream.write(`[cwd] ${cwd}\n\n`);

  try {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        shell,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        logStream.write(chunk);
      });

      child.stderr.on("data", (chunk) => {
        process.stderr.write(chunk);
        logStream.write(chunk);
      });

      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({
          exitCode: code ?? 1,
          signal
        });
      });
    });

    return {
      ...exit,
      command: label,
      logPath,
      durationMs: Date.now() - startedMs
    };
  } finally {
    await endLogStream(logStream);
  }
}

function buildFailedArtifactReason(stepName, targetPath) {
  return `${stepName} completed without the expected artifact: ${targetPath}`;
}

async function runBurninStep(options, laneOutputRoot, logsRoot) {
  const burninRoot = path.join(laneOutputRoot, "burnin");
  const doctorOutputDir = path.join(burninRoot, "doctor");
  const summaryPath = path.join(burninRoot, "quality-burnin-summary.json");
  const logPath = path.join(logsRoot, "01-quality-burnin.log");
  const args = [
    path.join(projectRoot, "scripts", "release-burnin.mjs"),
    "--preset",
    "quality",
    "--rounds",
    String(options.burninRounds),
    "--summary-file",
    summaryPath,
    "--doctor-output-dir",
    doctorOutputDir
  ];
  const commandLabel = `node scripts/release-burnin.mjs --preset quality --rounds ${options.burninRounds} --summary-file ${summaryPath} --doctor-output-dir ${doctorOutputDir}`;
  const commandResult = await runLoggedCommand({
    command: process.execPath,
    args,
    label: commandLabel,
    logPath
  });
  const doctorJsonPath = path.join(doctorOutputDir, "runtime-doctor.json");
  const doctorMarkdownPath = path.join(doctorOutputDir, "runtime-doctor.md");
  const summary = await readOptionalJson(summaryPath);
  const artifactsPresent =
    (await fileExists(summaryPath)) &&
    (await fileExists(doctorJsonPath)) &&
    (await fileExists(doctorMarkdownPath));
  const status = commandResult.exitCode === 0 && artifactsPresent ? "passed" : "failed";

  return {
    id: "quality-burnin",
    name: "Quality burn-in",
    status,
    durationMs: commandResult.durationMs,
    command: commandLabel,
    commandExitCode: commandResult.exitCode,
    signal: commandResult.signal,
    logPath,
    outputRoot: burninRoot,
    summaryPath,
    doctorOutputDir,
    doctorJsonPath,
    doctorMarkdownPath,
    roundsRequested: options.burninRounds,
    roundsExecuted: summary?.totals?.roundsExecuted ?? 0,
    stepsFailed: summary?.totals?.stepsFailed ?? null,
    stopReason:
      commandResult.exitCode !== 0
        ? `quality burn-in failed with exit code ${commandResult.exitCode}`
        : artifactsPresent
          ? null
          : buildFailedArtifactReason("quality burn-in", summaryPath)
  };
}

async function runRepeatedE2eStep(options, laneOutputRoot, logsRoot) {
  const e2eRoot = path.join(laneOutputRoot, "e2e");
  const summaryPath = path.join(e2eRoot, "repeated-e2e-summary.json");
  const rounds = [];
  let stopReason = null;

  await ensureDirectory(e2eRoot);

  for (let round = 1; round <= options.e2eRounds; round += 1) {
    const roundLabel = String(round).padStart(2, "0");
    const logPath = path.join(logsRoot, `02-e2e-round-${roundLabel}.log`);
    const commandLabel = `${npmRunner.display} run test:e2e`;
    const commandResult = await runLoggedCommand({
      command: npmRunner.command,
      args: [...npmRunner.fixedArgs, "run", "test:e2e"],
      label: commandLabel,
      logPath,
      shell: npmRunner.shell
    });

    rounds.push({
      round,
      status: commandResult.exitCode === 0 ? "passed" : "failed",
      durationMs: commandResult.durationMs,
      commandExitCode: commandResult.exitCode,
      signal: commandResult.signal,
      logPath
    });

    if (commandResult.exitCode !== 0) {
      stopReason = `repeated e2e failed at round ${round}`;
      break;
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    status: stopReason ? "failed" : "passed",
    roundsRequested: options.e2eRounds,
    roundsExecuted: rounds.length,
    roundsPassed: rounds.filter((round) => round.status === "passed").length,
    roundsFailed: rounds.filter((round) => round.status === "failed").length,
    stopReason,
    rounds
  };
  await writeJson(summaryPath, summary);

  return {
    id: "repeated-e2e",
    name: "Repeated E2E",
    status: summary.status,
    durationMs: rounds.reduce((total, round) => total + round.durationMs, 0),
    command: `${npmRunner.display} run test:e2e (repeated)`,
    commandExitCode: summary.status === "passed" ? 0 : 1,
    signal: null,
    logPath: rounds.at(-1)?.logPath ?? null,
    outputRoot: e2eRoot,
    summaryPath,
    roundsRequested: summary.roundsRequested,
    roundsExecuted: summary.roundsExecuted,
    roundsPassed: summary.roundsPassed,
    roundsFailed: summary.roundsFailed,
    stopReason: summary.stopReason
  };
}

async function runLiveAcceptanceStep(options, laneOutputRoot, logsRoot) {
  const outputRoot = path.join(laneOutputRoot, "live-acceptance");
  const summaryPath = path.join(outputRoot, "acceptance-summary.json");
  const summaryMarkdownPath = path.join(outputRoot, "acceptance-summary.md");
  const logPath = path.join(logsRoot, "03-live-acceptance.log");
  const commandArgs = [
    ...npmRunner.fixedArgs,
    "run",
    "acceptance:live",
    "--",
    "--successes",
    String(options.acceptanceSuccesses),
    "--max-attempts",
    String(options.acceptanceMaxAttempts),
    "--max-rounds",
    String(options.acceptanceMaxRounds),
    "--output-root",
    outputRoot
  ];
  const commandLabel =
    `${npmRunner.display} run acceptance:live -- --successes ${options.acceptanceSuccesses} ` +
    `--max-attempts ${options.acceptanceMaxAttempts} --max-rounds ${options.acceptanceMaxRounds} ` +
    `--output-root ${outputRoot}`;
  const commandResult = await runLoggedCommand({
    command: npmRunner.command,
    args: commandArgs,
    label: commandLabel,
    logPath,
    shell: npmRunner.shell
  });
  const summary = await readOptionalJson(summaryPath);
  const summaryPresent = (await fileExists(summaryPath)) && (await fileExists(summaryMarkdownPath));
  const failureFeedbackIndexPath = summary?.failureFeedback?.indexPath ?? path.join(outputRoot, "failure-feedback", "failure-feedback-index.json");
  const status = commandResult.exitCode === 0 && summaryPresent ? "passed" : "failed";

  return {
    id: "live-acceptance",
    name: "Live acceptance",
    status,
    durationMs: commandResult.durationMs,
    command: commandLabel,
    commandExitCode: commandResult.exitCode,
    signal: commandResult.signal,
    logPath,
    outputRoot,
    summaryPath,
    summaryMarkdownPath,
    failureFeedbackIndexPath: (await fileExists(failureFeedbackIndexPath)) ? failureFeedbackIndexPath : null,
    requiredSuccesses: summary?.requiredSuccesses ?? options.acceptanceSuccesses,
    achievedSuccesses: summary?.achievedSuccesses ?? 0,
    attemptsExecuted: Array.isArray(summary?.attempts) ? summary.attempts.length : 0,
    stopReason:
      commandResult.exitCode !== 0
        ? summary?.stopReason ?? `live acceptance failed with exit code ${commandResult.exitCode}`
        : summaryPresent
          ? summary?.stopReason ?? null
          : buildFailedArtifactReason("live acceptance", summaryPath)
  };
}

async function findNewestPanelBrowserSummary(panelOutputRoot) {
  if (!(await fileExists(panelOutputRoot))) {
    return null;
  }

  const entries = await readdir(panelOutputRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("panel-browser-smoke-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const directoryName of directories) {
    const candidate = path.join(panelOutputRoot, directoryName, "panel-browser-smoke-summary.json");
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function runPanelBrowserStep(options, laneOutputRoot, logsRoot) {
  const outputRoot = path.join(laneOutputRoot, "panel-browser");
  const logPath = path.join(logsRoot, "04-panel-browser.log");
  const commandArgs = [
    ...npmRunner.fixedArgs,
    "run",
    "acceptance:panel:browser:full",
    "--",
    "--output-root",
    outputRoot,
    "--max-rounds",
    String(options.panelMaxRounds),
    "--watchdog-ms",
    String(options.panelWatchdogMs),
    "--poll-interval-ms",
    String(options.panelPollIntervalMs)
  ];
  const commandLabel =
    `${npmRunner.display} run acceptance:panel:browser:full -- --output-root ${outputRoot} ` +
    `--max-rounds ${options.panelMaxRounds} --watchdog-ms ${options.panelWatchdogMs} ` +
    `--poll-interval-ms ${options.panelPollIntervalMs}`;
  const commandResult = await runLoggedCommand({
    command: npmRunner.command,
    args: commandArgs,
    label: commandLabel,
    logPath,
    shell: npmRunner.shell
  });
  const summaryPath = await findNewestPanelBrowserSummary(outputRoot);
  const summary = summaryPath ? await readOptionalJson(summaryPath) : null;
  const status = commandResult.exitCode === 0 && summaryPath ? "passed" : "failed";

  return {
    id: "panel-browser",
    name: "Panel browser full",
    status,
    durationMs: commandResult.durationMs,
    command: commandLabel,
    commandExitCode: commandResult.exitCode,
    signal: commandResult.signal,
    logPath,
    outputRoot,
    summaryPath,
    finalRunStatus: summary?.finalRunStatus ?? null,
    autonomousFinalStatus: summary?.autonomousFinalStatus ?? null,
    harnessPassed: summary?.harnessPassed ?? null,
    stopReason:
      commandResult.exitCode !== 0
        ? `panel browser full failed with exit code ${commandResult.exitCode}`
        : summaryPath
          ? summary?.error ?? null
          : buildFailedArtifactReason("panel browser full", path.join(outputRoot, "panel-browser-smoke-*/panel-browser-smoke-summary.json"))
  };
}

function buildSkippedStep(id, name, reason) {
  return {
    id,
    name,
    status: "skipped",
    durationMs: 0,
    command: null,
    commandExitCode: null,
    signal: null,
    logPath: null,
    outputRoot: null,
    summaryPath: null,
    stopReason: reason
  };
}

function buildMorningTriage(summary, morningSummaryJsonPath, morningSummaryMarkdownPath) {
  const items = [
    { label: "lane summary json", path: morningSummaryJsonPath },
    { label: "lane summary markdown", path: morningSummaryMarkdownPath }
  ];
  const firstFailedStep = summary.steps.find((step) => step.status === "failed") ?? null;

  if (firstFailedStep?.logPath) {
    items.push({ label: `${firstFailedStep.id} log`, path: firstFailedStep.logPath });
  }

  if (firstFailedStep?.summaryPath) {
    items.push({ label: `${firstFailedStep.id} summary`, path: firstFailedStep.summaryPath });
  }

  if (firstFailedStep?.failureFeedbackIndexPath) {
    items.push({
      label: `${firstFailedStep.id} failure feedback`,
      path: firstFailedStep.failureFeedbackIndexPath
    });
  }

  for (const step of summary.steps) {
    if (step.status !== "passed" || !step.summaryPath) {
      continue;
    }

    items.push({ label: `${step.id} summary`, path: step.summaryPath });
  }

  return items;
}

function renderMorningSummaryMarkdown(summary) {
  const lines = [
    "# Overnight Soak Morning Summary",
    "",
    `- Generated at: ${summary.generatedAt}`,
    `- Started at: ${summary.startedAt}`,
    `- Finished at: ${summary.finishedAt}`,
    `- Status: ${summary.status}`,
    `- Stop reason: ${summary.stopReason ?? "n/a"}`,
    `- Output root: ${summary.outputRoot}`,
    "",
    "## Step Results"
  ];

  for (const step of summary.steps) {
    lines.push(
      `- ${step.name}: ${step.status} | duration=${formatDuration(step.durationMs)} | log=${step.logPath ?? "n/a"}`
    );

    if (step.summaryPath) {
      lines.push(`  summary: ${step.summaryPath}`);
    }

    if (typeof step.roundsExecuted === "number" && typeof step.roundsRequested === "number") {
      lines.push(`  rounds: ${step.roundsExecuted}/${step.roundsRequested}`);
    }

    if (typeof step.achievedSuccesses === "number" && typeof step.requiredSuccesses === "number") {
      lines.push(`  successes: ${step.achievedSuccesses}/${step.requiredSuccesses}`);
    }

    if (step.finalRunStatus || step.autonomousFinalStatus) {
      lines.push(
        `  terminal: run=${step.finalRunStatus ?? "n/a"} autonomous=${step.autonomousFinalStatus ?? "n/a"}`
      );
    }

    if (step.stopReason) {
      lines.push(`  note: ${step.stopReason}`);
    }
  }

  lines.push("", "## Morning Triage");

  summary.morningTriage.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.label}: ${item.path}`);
  });

  return `${lines.join("\n")}\n`;
}

async function runOvernightSoakLane(options) {
  const laneOutputRoot = await ensureDirectory(options.outputRoot);
  const logsRoot = await ensureDirectory(path.join(laneOutputRoot, "logs"));
  const morningSummaryJsonPath = path.join(laneOutputRoot, "overnight-soak-summary.json");
  const morningSummaryMarkdownPath = path.join(laneOutputRoot, "morning-summary.md");
  const startedAt = new Date();
  const steps = [];
  const stepQueue = [
    () => runBurninStep(options, laneOutputRoot, logsRoot),
    () => runRepeatedE2eStep(options, laneOutputRoot, logsRoot),
    () => runLiveAcceptanceStep(options, laneOutputRoot, logsRoot),
    () => runPanelBrowserStep(options, laneOutputRoot, logsRoot)
  ];
  const skippedSteps = [
    { id: "quality-burnin", name: "Quality burn-in" },
    { id: "repeated-e2e", name: "Repeated E2E" },
    { id: "live-acceptance", name: "Live acceptance" },
    { id: "panel-browser", name: "Panel browser full" }
  ];
  let encounteredFailure = false;
  let failureReason = null;

  for (let index = 0; index < stepQueue.length; index += 1) {
    if (encounteredFailure) {
      const skipped = skippedSteps[index];
      steps.push(buildSkippedStep(skipped.id, skipped.name, `skipped after ${failureReason}`));
      continue;
    }

    const stepResult = await stepQueue[index]();
    steps.push(stepResult);

    if (stepResult.status === "failed") {
      encounteredFailure = true;
      failureReason = `${stepResult.id} failed`;
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status: encounteredFailure ? "failed" : "passed",
    stopReason: encounteredFailure ? failureReason : "overnight soak lane completed",
    outputRoot: laneOutputRoot,
    config: {
      burninRounds: options.burninRounds,
      e2eRounds: options.e2eRounds,
      acceptanceSuccesses: options.acceptanceSuccesses,
      acceptanceMaxAttempts: options.acceptanceMaxAttempts,
      acceptanceMaxRounds: options.acceptanceMaxRounds,
      panelMaxRounds: options.panelMaxRounds,
      panelWatchdogMs: options.panelWatchdogMs,
      panelPollIntervalMs: options.panelPollIntervalMs
    },
    totals: {
      stepsRequested: stepQueue.length,
      stepsPassed: steps.filter((step) => step.status === "passed").length,
      stepsFailed: steps.filter((step) => step.status === "failed").length,
      stepsSkipped: steps.filter((step) => step.status === "skipped").length
    },
    steps
  };
  summary.morningTriage = buildMorningTriage(summary, morningSummaryJsonPath, morningSummaryMarkdownPath);

  await writeJson(morningSummaryJsonPath, summary);
  await writeFile(morningSummaryMarkdownPath, renderMorningSummaryMarkdown(summary), "utf8");

  return {
    summary,
    morningSummaryJsonPath,
    morningSummaryMarkdownPath
  };
}

function isMainModule() {
  return path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runOvernightSoakLane(options);

  console.log(`Overnight soak summary JSON: ${result.morningSummaryJsonPath}`);
  console.log(`Overnight soak summary Markdown: ${result.morningSummaryMarkdownPath}`);

  if (result.summary.status !== "passed") {
    process.exitCode = 1;
  }
}

export {
  findNewestPanelBrowserSummary,
  isMainModule,
  parseArgs,
  renderMorningSummaryMarkdown,
  runOvernightSoakLane
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
