import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const stepPresets = {
  quality: [
    { name: "validate:workflows", args: ["run", "validate:workflows"] },
    { name: "build", args: ["run", "build"] },
    { name: "pack:check", args: ["run", "pack:check"] },
    { name: "lint", args: ["run", "lint"] },
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "test", args: ["test"] },
    { name: "test:integration", args: ["run", "test:integration"] },
    { name: "test:e2e", args: ["run", "test:e2e"] },
    { name: "doctor", args: ["run", "doctor"] }
  ],
  example: [
    { name: "validate:example", args: ["run", "validate:example"] },
    { name: "plan:example", args: ["run", "plan:example"] },
    { name: "run:example", args: ["run", "run:example"] },
    { name: "report:example", args: ["run", "report:example"] },
    { name: "handoff:example", args: ["run", "handoff:example"] },
    { name: "dispatch:example", args: ["run", "dispatch:example"] }
  ]
};

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}.${String(millis).padStart(3, "0")}s`;
}

function toBoolean(value) {
  if (typeof value !== "string") {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseInteger(value, label) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return number;
}

function printHelp() {
  console.log([
    "Usage: node scripts/release-burnin.mjs [options]",
    "",
    "Options:",
    "  --preset <name>      Step preset: quality or example (default: quality)",
    "  --rounds <n>          Number of full validation rounds (default: 1)",
    "  --keep-going          Continue remaining steps/rounds after failures",
    "  --summary-file <path> Write JSON summary to a file",
    "  --help                Show this help message",
    "",
    "Environment variables:",
    "  BURNIN_PRESET=quality|example",
    "  BURNIN_ROUNDS=<n>",
    "  BURNIN_KEEP_GOING=true|false",
    "  BURNIN_SUMMARY_FILE=<path>"
  ].join("\n"));
}

function parsePreset(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  const normalized = value.trim().toLowerCase();

  if (!Object.hasOwn(stepPresets, normalized)) {
    throw new Error(`Unsupported ${label}: ${value}`);
  }

  return normalized;
}

function parseArgs(argv) {
  const config = {
    preset: parsePreset(process.env.BURNIN_PRESET ?? "quality", "BURNIN_PRESET"),
    rounds: parseInteger(process.env.BURNIN_ROUNDS ?? "1", "BURNIN_ROUNDS"),
    keepGoing: toBoolean(process.env.BURNIN_KEEP_GOING),
    summaryFile: process.env.BURNIN_SUMMARY_FILE ?? null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help") {
      printHelp();
      process.exit(0);
    }

    if (token === "--keep-going") {
      config.keepGoing = true;
      continue;
    }

    if (token === "--preset") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --preset");
      }

      config.preset = parsePreset(value, "--preset");
      index += 1;
      continue;
    }

    if (token === "--rounds") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --rounds");
      }

      config.rounds = parseInteger(value, "--rounds");
      index += 1;
      continue;
    }

    if (token === "--summary-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --summary-file");
      }

      config.summaryFile = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${token}`);
  }

  return config;
}

async function runStep(step, round) {
  const commandArgs = [...npmRunner.fixedArgs, ...step.args];
  const commandLabel = `${npmRunner.display} ${step.args.join(" ")}`;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  console.log(`\n[round ${round}] START ${step.name} -> ${commandLabel}`);

  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(npmRunner.command, commandArgs, {
      cwd: projectRoot,
      env: process.env,
      shell: npmRunner.shell,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code, signal) => {
      resolve({
        exitCode: code ?? 1,
        signal
      });
    });
  });

  const finishedMs = Date.now();
  const status = outcome.exitCode === 0 ? "passed" : "failed";
  const result = {
    step: step.name,
    command: commandLabel,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: finishedMs - startedMs,
    exitCode: outcome.exitCode,
    signal: outcome.signal
  };

  const suffix = status === "passed" ? "PASS" : "FAIL";
  console.log(
    `[round ${round}] ${suffix} ${step.name} in ${formatDuration(result.durationMs)} (exit ${result.exitCode})`
  );

  return result;
}

async function writeSummary(summaryFile, payload) {
  const resolved = path.isAbsolute(summaryFile) ? summaryFile : path.resolve(projectRoot, summaryFile);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const selectedSteps = stepPresets[config.preset];
  const startedMs = Date.now();
  const startedAt = new Date().toISOString();
  const rounds = [];
  let encounteredFailure = false;

  console.log(
    `Release burn-in start: preset=${config.preset}, rounds=${config.rounds}, keepGoing=${config.keepGoing ? "true" : "false"}`
  );

  for (let round = 1; round <= config.rounds; round += 1) {
    const roundStartedMs = Date.now();
    const roundResult = {
      round,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: 0,
      status: "passed",
      steps: []
    };

    console.log(`\n=== Round ${round}/${config.rounds} ===`);

    for (const step of selectedSteps) {
      const stepResult = await runStep(step, round);
      roundResult.steps.push(stepResult);

      if (stepResult.status === "failed") {
        roundResult.status = "failed";
        encounteredFailure = true;

        if (!config.keepGoing) {
          break;
        }
      }
    }

    roundResult.finishedAt = new Date().toISOString();
    roundResult.durationMs = Date.now() - roundStartedMs;
    rounds.push(roundResult);

    console.log(
      `Round ${round} ${roundResult.status === "passed" ? "PASS" : "FAIL"} (${formatDuration(roundResult.durationMs)})`
    );

    if (roundResult.status === "failed" && !config.keepGoing) {
      break;
    }
  }

  const finishedMs = Date.now();
  const allStepResults = rounds.flatMap((round) => round.steps);
  const failedSteps = allStepResults.filter((step) => step.status === "failed");
  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: finishedMs - startedMs,
    config: {
      preset: config.preset,
      roundsRequested: config.rounds,
      keepGoing: config.keepGoing,
      stepsPerRound: selectedSteps.map((step) => step.name)
    },
    totals: {
      roundsExecuted: rounds.length,
      roundsPassed: rounds.filter((round) => round.status === "passed").length,
      roundsFailed: rounds.filter((round) => round.status === "failed").length,
      stepsExecuted: allStepResults.length,
      stepsFailed: failedSteps.length
    },
    rounds
  };

  console.log("\n=== Burn-in summary ===");
  console.log(`Started at: ${summary.startedAt}`);
  console.log(`Finished at: ${summary.finishedAt}`);
  console.log(`Duration: ${formatDuration(summary.durationMs)}`);
  console.log(
    `Rounds: ${summary.totals.roundsExecuted}/${summary.config.roundsRequested} executed, ` +
      `${summary.totals.roundsPassed} passed, ${summary.totals.roundsFailed} failed`
  );
  console.log(`Steps: ${summary.totals.stepsExecuted} executed, ${summary.totals.stepsFailed} failed`);
  if (failedSteps.length > 0) {
    console.log("Failed steps:");
    for (const roundResult of rounds) {
      for (const step of roundResult.steps) {
        if (step.status !== "failed") {
          continue;
        }

        console.log(
          `  - round ${roundResult.round}: ${step.step} (${step.command}) exit ${step.exitCode} in ${formatDuration(step.durationMs)}`
        );
      }
    }
  }

  if (config.summaryFile) {
    const summaryPath = await writeSummary(config.summaryFile, summary);
    console.log(`Summary file: ${summaryPath}`);
  }

  if (encounteredFailure) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
