import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPhases = [
  { name: "canary", trafficPercent: 5, trials: 2 },
  { name: "ramp", trafficPercent: 20, trials: 3 },
  { name: "full", trafficPercent: 100, trials: 3 }
];

function formatDuration(durationMs) {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function parseInteger(value, label, { minimum = 0 } = {}) {
  const rawValue = String(value ?? "").trim();

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  const parsedValue = Number(rawValue);

  if (!Number.isSafeInteger(parsedValue) || parsedValue < minimum) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsedValue;
}

function parsePositiveInteger(value, label) {
  return parseInteger(value, label, { minimum: 1 });
}

function parseNonNegativeInteger(value, label) {
  return parseInteger(value, label, { minimum: 0 });
}

function parseDecimal(value, label) {
  const rawValue = String(value ?? "").trim();

  if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawValue)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  const parsedValue = Number(rawValue);

  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsedValue;
}

function parseRate(value, label) {
  const parsedValue = parseDecimal(value, label);

  if (!Number.isFinite(parsedValue) || parsedValue < 0 || parsedValue > 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsedValue;
}

function truncateText(value, maxLength = 8000) {
  if (typeof value !== "string") {
    return "";
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}\n... [truncated]` : value;
}

export function parsePhaseSpec(rawValue) {
  const normalized = String(rawValue ?? "").trim();
  const parts = normalized.split(":");

  if (parts.length !== 3 || parts.some((part) => part.trim().length === 0)) {
    throw new Error(`Invalid --phase value: ${rawValue}. Expected format: <name>:<trafficPercent>:<trials>.`);
  }

  const [nameRaw, percentRaw, trialsRaw] = parts;
  const name = nameRaw.trim().toLowerCase();
  const trafficPercent = parsePositiveInteger(percentRaw, "phase traffic percent");
  const trials = parsePositiveInteger(trialsRaw, "phase trials");

  if (trafficPercent <= 0 || trafficPercent > 100) {
    throw new Error(`Invalid phase traffic percent: ${trafficPercent}. Must be 1..100.`);
  }

  return {
    name: name.trim().toLowerCase(),
    trafficPercent,
    trials
  };
}

function parsePhaseList(rawValue) {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return [];
  }

  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => parsePhaseSpec(item));
}

function ensurePhaseOrder(phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("At least one rollout phase is required.");
  }

  let previousPercent = 0;

  for (const phase of phases) {
    if (phase.trafficPercent < previousPercent) {
      throw new Error("Rollout phases must be ordered by non-decreasing trafficPercent.");
    }
    previousPercent = phase.trafficPercent;
  }
}

function parseOptionalPath(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toResolvedPath(targetPath, cwd = projectRoot) {
  if (!targetPath) {
    return null;
  }

  return path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwd, targetPath);
}

export function parseArgs(argv, env = process.env) {
  const options = {
    runCommand: env.ROLLOUT_RUN_COMMAND ?? "npm run selfcheck",
    rollbackCommand: parseOptionalPath(env.ROLLOUT_ROLLBACK_COMMAND),
    phases: parsePhaseList(env.ROLLOUT_PHASES),
    minSuccessRate: parseRate(env.ROLLOUT_MIN_SUCCESS_RATE ?? "1", "ROLLOUT_MIN_SUCCESS_RATE"),
    maxFailureCount: parseNonNegativeInteger(env.ROLLOUT_MAX_FAILURE_COUNT ?? "0", "ROLLOUT_MAX_FAILURE_COUNT"),
    maxConsecutiveFailures: parseNonNegativeInteger(
      env.ROLLOUT_MAX_CONSECUTIVE_FAILURES ?? "1",
      "ROLLOUT_MAX_CONSECUTIVE_FAILURES"
    ),
    summaryFile: parseOptionalPath(env.ROLLOUT_SUMMARY_FILE)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const nextValue = argv[index + 1];

    switch (token) {
      case "--run-command":
        if (!nextValue) {
          throw new Error("Missing value for --run-command.");
        }
        options.runCommand = nextValue;
        index += 1;
        break;
      case "--rollback-command":
        if (!nextValue) {
          throw new Error("Missing value for --rollback-command.");
        }
        options.rollbackCommand = nextValue;
        index += 1;
        break;
      case "--phase":
        if (!nextValue) {
          throw new Error("Missing value for --phase.");
        }
        options.phases.push(parsePhaseSpec(nextValue));
        index += 1;
        break;
      case "--min-success-rate":
        if (!nextValue) {
          throw new Error("Missing value for --min-success-rate.");
        }
        options.minSuccessRate = parseRate(nextValue, "--min-success-rate");
        index += 1;
        break;
      case "--max-failure-count":
        if (!nextValue) {
          throw new Error("Missing value for --max-failure-count.");
        }
        options.maxFailureCount = parseNonNegativeInteger(nextValue, "--max-failure-count");
        index += 1;
        break;
      case "--max-consecutive-failures":
        if (!nextValue) {
          throw new Error("Missing value for --max-consecutive-failures.");
        }
        options.maxConsecutiveFailures = parseNonNegativeInteger(nextValue, "--max-consecutive-failures");
        index += 1;
        break;
      case "--summary-file":
        if (!nextValue) {
          throw new Error("Missing value for --summary-file.");
        }
        options.summaryFile = nextValue;
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  if (!Array.isArray(options.phases) || options.phases.length === 0) {
    options.phases = [...defaultPhases];
  }

  ensurePhaseOrder(options.phases);
  return options;
}

export function evaluatePhaseSlo({
  attempts,
  successes,
  failures,
  consecutiveFailures,
  remainingTrials,
  minSuccessRate,
  maxFailureCount,
  maxConsecutiveFailures
}) {
  const reasons = [];
  const successRate = attempts > 0 ? successes / attempts : 0;
  const maxPossibleSuccessRate =
    attempts + remainingTrials > 0 ? (successes + remainingTrials) / (attempts + remainingTrials) : 0;

  if (failures > maxFailureCount) {
    reasons.push(
      `failure count ${failures} exceeded maxFailureCount ${maxFailureCount}.`
    );
  }

  if (consecutiveFailures > maxConsecutiveFailures) {
    reasons.push(
      `consecutive failures ${consecutiveFailures} exceeded maxConsecutiveFailures ${maxConsecutiveFailures}.`
    );
  }

  if (attempts > 0 && successRate < minSuccessRate && maxPossibleSuccessRate < minSuccessRate) {
    reasons.push(
      `success rate target is no longer reachable: current=${successRate.toFixed(3)}, maxPossible=${maxPossibleSuccessRate.toFixed(3)}, required=${minSuccessRate.toFixed(3)}.`
    );
  }

  return {
    breached: reasons.length > 0,
    reasons,
    metrics: {
      attempts,
      successes,
      failures,
      consecutiveFailures,
      successRate,
      maxPossibleSuccessRate
    }
  };
}

function buildShellInvocation(commandLine) {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", commandLine]
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", commandLine]
  };
}

export async function executeShellCommand(commandLine, options = {}) {
  const { cwd = projectRoot, env = process.env } = options;
  const { command, args } = buildShellInvocation(commandLine);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        commandLine,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        exitCode: typeof code === "number" ? code : 1,
        signal: signal ?? null,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr)
      });
    });
  });
}

function buildSummaryMarkdown(summary) {
  const lines = [
    "# Progressive Rollout Summary",
    "",
    `- Status: ${summary.status}`,
    `- Run command: ${summary.runCommand}`,
    `- Rollback command: ${summary.rollbackCommand ?? "(none)"}`,
    `- Min success rate: ${summary.thresholds.minSuccessRate}`,
    `- Max failure count (inclusive): ${summary.thresholds.maxFailureCount}`,
    `- Max consecutive failures (inclusive): ${summary.thresholds.maxConsecutiveFailures}`,
    ""
  ];

  for (const phase of summary.phases) {
    lines.push(
      `## ${phase.name} (${phase.trafficPercent}%)`,
      `- Status: ${phase.status}`,
      `- Attempts: ${phase.attempts}`,
      `- Successes: ${phase.successes}`,
      `- Failures: ${phase.failures}`,
      `- Success rate: ${phase.successRate.toFixed(3)}`
    );

    if (phase.sloBreachReasons.length > 0) {
      lines.push("- SLO breach reasons:");
      for (const reason of phase.sloBreachReasons) {
        lines.push(`  - ${reason}`);
      }
    }

    lines.push("");
  }

  if (summary.rollback) {
    lines.push("## Rollback", `- Status: ${summary.rollback.status}`, `- Command: ${summary.rollback.commandLine}`);
  }

  return `${lines.join("\n")}\n`;
}

function toMarkdownSummaryPath(resolvedJsonPath) {
  const extension = path.extname(resolvedJsonPath);

  if (extension.toLowerCase() === ".json") {
    return `${resolvedJsonPath.slice(0, -extension.length)}.md`;
  }

  return `${resolvedJsonPath}.md`;
}

export async function runProgressiveRollout(
  config,
  { executeCommand = executeShellCommand, cwd = projectRoot, env = process.env } = {}
) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const summary = {
    status: "passed",
    runCommand: config.runCommand,
    rollbackCommand: config.rollbackCommand ?? null,
    thresholds: {
      minSuccessRate: config.minSuccessRate,
      maxFailureCount: config.maxFailureCount,
      maxConsecutiveFailures: config.maxConsecutiveFailures
    },
    phases: [],
    rollback: null,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    failedPhase: null,
    promotedTrafficPercent: 0
  };

  for (const phase of config.phases) {
    const phaseResult = {
      name: phase.name,
      trafficPercent: phase.trafficPercent,
      trials: phase.trials,
      attempts: 0,
      successes: 0,
      failures: 0,
      successRate: 0,
      status: "passed",
      sloBreachReasons: [],
      logs: []
    };
    let consecutiveFailures = 0;

    for (let attemptNumber = 1; attemptNumber <= phase.trials; attemptNumber += 1) {
      const attemptContext = /** @type {any} */ ({
        cwd,
        env,
        phase,
        attemptNumber,
        commandType: "run"
      });
      const attemptResult = await executeCommand(config.runCommand, attemptContext);
      const passed = attemptResult.exitCode === 0;

      phaseResult.attempts += 1;
      phaseResult.logs.push({
        attemptNumber,
        status: passed ? "passed" : "failed",
        ...attemptResult
      });

      if (passed) {
        phaseResult.successes += 1;
        consecutiveFailures = 0;
      } else {
        phaseResult.failures += 1;
        consecutiveFailures += 1;
      }

      const evaluation = evaluatePhaseSlo({
        attempts: phaseResult.attempts,
        successes: phaseResult.successes,
        failures: phaseResult.failures,
        consecutiveFailures,
        remainingTrials: phase.trials - attemptNumber,
        minSuccessRate: config.minSuccessRate,
        maxFailureCount: config.maxFailureCount,
        maxConsecutiveFailures: config.maxConsecutiveFailures
      });

      if (evaluation.breached) {
        phaseResult.status = "failed";
        phaseResult.sloBreachReasons = evaluation.reasons;
        break;
      }
    }

    phaseResult.successRate = phaseResult.attempts > 0 ? phaseResult.successes / phaseResult.attempts : 0;

    if (phaseResult.status !== "failed" && phaseResult.successRate < config.minSuccessRate) {
      phaseResult.status = "failed";
      phaseResult.sloBreachReasons.push(
        `final success rate ${phaseResult.successRate.toFixed(3)} is below minSuccessRate ${config.minSuccessRate.toFixed(3)}.`
      );
    }

    summary.phases.push(phaseResult);

    if (phaseResult.status === "failed") {
      summary.status = "failed";
      summary.failedPhase = phase.name;

      if (config.rollbackCommand) {
        const rollbackContext = /** @type {any} */ ({
          cwd,
          env,
          phase,
          commandType: "rollback"
        });
        const rollbackResult = await executeCommand(config.rollbackCommand, rollbackContext);
        summary.rollback = {
          commandLine: config.rollbackCommand,
          status: rollbackResult.exitCode === 0 ? "passed" : "failed",
          ...rollbackResult
        };
      }

      break;
    }

    summary.promotedTrafficPercent = phase.trafficPercent;
  }

  summary.finishedAt = new Date().toISOString();
  summary.durationMs = Date.now() - startedMs;
  return summary;
}

async function writeSummaryFiles(summary, summaryFile, cwd = projectRoot) {
  const resolvedJsonPath = toResolvedPath(summaryFile, cwd);

  if (!resolvedJsonPath) {
    return {
      jsonPath: null,
      markdownPath: null
    };
  }

  const resolvedMarkdownPath = toMarkdownSummaryPath(resolvedJsonPath);
  await mkdir(path.dirname(resolvedJsonPath), { recursive: true });
  await writeFile(resolvedJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(resolvedMarkdownPath, buildSummaryMarkdown(summary), "utf8");

  return {
    jsonPath: resolvedJsonPath,
    markdownPath: resolvedMarkdownPath
  };
}

function printHelp() {
  console.log(`Usage: node scripts/progressive-rollout.mjs [options]

Options:
  --run-command <command>              Command executed in each rollout trial (default: npm run selfcheck)
  --rollback-command <command>         Command executed once when rollout fails
  --phase <name:percent:trials>        Rollout phase (repeatable), e.g. canary:5:2
  --min-success-rate <0..1>            Minimum acceptable success rate per phase (default: 1)
  --max-failure-count <n>              Inclusive failure cap before phase fails (default: 0)
  --max-consecutive-failures <n>       Inclusive consecutive failure cap before phase fails (default: 1)
  --summary-file <path>                Write JSON+Markdown summary files
  --help                               Show this help

Environment:
  ROLLOUT_RUN_COMMAND
  ROLLOUT_ROLLBACK_COMMAND
  ROLLOUT_PHASES                       Comma-separated: canary:5:2,ramp:20:3,full:100:3
  ROLLOUT_MIN_SUCCESS_RATE
  ROLLOUT_MAX_FAILURE_COUNT            Inclusive count
  ROLLOUT_MAX_CONSECUTIVE_FAILURES     Inclusive count
  ROLLOUT_SUMMARY_FILE
`);
}

function isDirectExecution() {
  const entryPath = process.argv[1];

  if (!entryPath) {
    return false;
  }

  return path.resolve(entryPath) === fileURLToPath(import.meta.url);
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);

  if (options.help) {
    printHelp();
    return;
  }

  const summary = await runProgressiveRollout(options, {
    cwd: projectRoot,
    env: process.env
  });
  const summaryPaths = await writeSummaryFiles(summary, options.summaryFile, projectRoot);

  console.log(
    `Progressive rollout ${summary.status === "passed" ? "passed" : "failed"} in ${formatDuration(summary.durationMs)}.`
  );
  console.log(`Promoted traffic: ${summary.promotedTrafficPercent}%`);

  if (summary.failedPhase) {
    console.log(`Failed phase: ${summary.failedPhase}`);
  }

  if (summary.rollback) {
    console.log(`Rollback status: ${summary.rollback.status}`);
  }

  if (summaryPaths.jsonPath) {
    console.log(`Rollout summary JSON: ${summaryPaths.jsonPath}`);
  }

  if (summaryPaths.markdownPath) {
    console.log(`Rollout summary Markdown: ${summaryPaths.markdownPath}`);
  }

  if (summary.status !== "passed") {
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
