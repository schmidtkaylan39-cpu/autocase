import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");
const burninScriptPath = path.join(projectRoot, "scripts", "release-burnin.mjs");
const examplePresetCommands = [
  "run validate:example",
  "run plan:example",
  "run run:example",
  "run report:example",
  "run handoff:example",
  "run dispatch:example"
];

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function createFakeNpmFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-release-burnin-"));
  const fakeNpmPath = path.join(fixtureRoot, "fake-npm-cli.mjs");
  const logPath = path.join(fixtureRoot, "fake-npm-log.jsonl");

  await writeFile(
    fakeNpmPath,
    [
      'import { appendFile, mkdir } from "node:fs/promises";',
      'import path from "node:path";',
      "",
      'const logPath = process.env.FAKE_NPM_LOG_PATH;',
      "const outcomeMap = process.env.FAKE_NPM_OUTCOMES ? JSON.parse(process.env.FAKE_NPM_OUTCOMES) : {};",
      'const command = process.argv.slice(2).join(" ");',
      "",
      "if (logPath) {",
      "  await mkdir(path.dirname(logPath), { recursive: true });",
      '  await appendFile(logPath, `${JSON.stringify({ command, cwd: process.cwd() })}\\n`, "utf8");',
      "}",
      "",
      "const outcome = outcomeMap[command] ?? {};",
      "",
      'if (typeof outcome.stdout === "string") {',
      "  process.stdout.write(outcome.stdout);",
      "}",
      "",
      'if (typeof outcome.stderr === "string") {',
      "  process.stderr.write(outcome.stderr);",
      "}",
      "",
      "process.exit(typeof outcome.code === \"number\" ? outcome.code : 0);",
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    fixtureRoot,
    fakeNpmPath,
    logPath
  };
}

async function readCommandLog(logPath) {
  try {
    const text = await readFile(logPath, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function runBurnin(args, options = {}) {
  const fixture = options.fixture ?? (await createFakeNpmFixture());
  const env = {
    ...process.env,
    ...options.envOverrides,
    npm_execpath: fixture.fakeNpmPath,
    FAKE_NPM_LOG_PATH: fixture.logPath,
    FAKE_NPM_OUTCOMES: JSON.stringify(options.outcomes ?? {})
  };

  try {
    const result = await execFileAsync(process.execPath, [burninScriptPath, ...args], {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      windowsHide: true
    });

    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      fixture
    };
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout,
        stderr: error.stderr,
        fixture
      };
    }

    throw error;
  }
}

async function main() {
  await runTest("release burn-in help exits cleanly without invoking npm", async () => {
    const fixture = await createFakeNpmFixture();
    const result = await runBurnin(["--help"], {
      fixture
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: node scripts\/release-burnin\.mjs/);
    assert.match(result.stdout, /--preset <name>/);
    assert.match(result.stdout, /BURNIN_SUMMARY_FILE=<path>/);
    assert.deepEqual(await readCommandLog(fixture.logPath), []);
  });

  await runTest("release burn-in honors env-based example preset across multiple rounds", async () => {
    const fixture = await createFakeNpmFixture();
    const summaryPath = path.join(fixture.fixtureRoot, "summary.json");
    const result = await runBurnin([], {
      fixture,
      envOverrides: {
        BURNIN_PRESET: "example",
        BURNIN_ROUNDS: "2",
        BURNIN_SUMMARY_FILE: summaryPath
      }
    });

    assert.equal(result.code, 0);
    const commandLog = await readCommandLog(fixture.logPath);
    assert.deepEqual(
      commandLog.map((entry) => entry.command),
      [...examplePresetCommands, ...examplePresetCommands]
    );
    assert.ok(commandLog.every((entry) => entry.cwd === projectRoot));

    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    assert.equal(summary.config.preset, "example");
    assert.equal(summary.config.roundsRequested, 2);
    assert.equal(summary.totals.roundsExecuted, 2);
    assert.equal(summary.totals.roundsPassed, 2);
    assert.equal(summary.totals.stepsExecuted, 12);
    assert.equal(summary.totals.stepsFailed, 0);
  });

  await runTest("release burn-in forwards doctor output overrides for the quality preset", async () => {
    const fixture = await createFakeNpmFixture();
    const summaryPath = path.join(fixture.fixtureRoot, "quality-summary.json");
    const doctorOutputDir = path.join(fixture.fixtureRoot, "doctor-output");
    const result = await runBurnin(
      ["--preset", "quality", "--rounds", "1", "--summary-file", summaryPath, "--doctor-output-dir", doctorOutputDir],
      { fixture }
    );

    assert.equal(result.code, 0);
    assert.deepEqual(
      (await readCommandLog(fixture.logPath)).map((entry) => entry.command),
      [
        "run validate:workflows",
        "run build",
        "run pack:check",
        "run lint",
        "run typecheck",
        "test",
        "run test:integration",
        "run test:e2e",
        `run doctor -- ${doctorOutputDir}`
      ]
    );
  });

  await runTest("release burn-in stops the round immediately after a failed step by default", async () => {
    const fixture = await createFakeNpmFixture();
    const result = await runBurnin(["--preset", "example"], {
      fixture,
      outcomes: {
        "run plan:example": {
          code: 7,
          stderr: "plan failed\n"
        }
      }
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /\[round 1\] START validate:example -> npm run validate:example/);
    assert.match(result.stdout, /\[round 1\] START plan:example -> npm run plan:example/);
    assert.match(result.stdout, /Round 1 FAIL/);
    assert.match(result.stdout, /Steps: 2 executed, 1 failed/);
    assert.match(result.stdout, /round 1: plan:example \(npm run plan:example\) exit 7/);
    assert.deepEqual(
      (await readCommandLog(fixture.logPath)).map((entry) => entry.command),
      examplePresetCommands.slice(0, 2)
    );
  });

  await runTest("release burn-in keep-going records failures but finishes remaining steps", async () => {
    const fixture = await createFakeNpmFixture();
    const summaryPath = path.join(fixture.fixtureRoot, "keep-going-summary.json");
    const result = await runBurnin(
      ["--preset", "example", "--keep-going", "--summary-file", summaryPath],
      {
        fixture,
        outcomes: {
          "run plan:example": {
            code: 9,
            stderr: "plan still failed\n"
          }
        }
      }
    );

    assert.equal(result.code, 1);
    assert.deepEqual(
      (await readCommandLog(fixture.logPath)).map((entry) => entry.command),
      examplePresetCommands
    );

    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    assert.equal(summary.totals.roundsExecuted, 1);
    assert.equal(summary.totals.roundsFailed, 1);
    assert.equal(summary.totals.stepsExecuted, examplePresetCommands.length);
    assert.equal(summary.totals.stepsFailed, 1);
    assert.equal(summary.rounds[0].status, "failed");
    assert.equal(summary.rounds[0].steps.length, examplePresetCommands.length);
    assert.equal(summary.rounds[0].steps[1].step, "plan:example");
    assert.equal(summary.rounds[0].steps[1].status, "failed");
    assert.equal(summary.rounds[0].steps[1].exitCode, 9);
  });

  console.log("Release burn-in tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
