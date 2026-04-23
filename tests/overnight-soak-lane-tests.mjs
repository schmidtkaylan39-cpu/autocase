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
const soakScriptPath = path.join(projectRoot, "scripts", "overnight-soak-lane.mjs");

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
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-overnight-soak-"));
  const fakeNpmPath = path.join(fixtureRoot, "fake-npm-cli.mjs");
  const logPath = path.join(fixtureRoot, "fake-npm-log.jsonl");
  const statePath = path.join(fixtureRoot, "fake-npm-state.json");

  await writeFile(
    fakeNpmPath,
    [
      'import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      "",
      "const args = process.argv.slice(2);",
      'const logPath = process.env.FAKE_NPM_LOG_PATH;',
      'const statePath = process.env.FAKE_NPM_STATE_PATH;',
      "const outcomeMap = process.env.FAKE_NPM_OUTCOMES ? JSON.parse(process.env.FAKE_NPM_OUTCOMES) : {};",
      'const command = args.join(" ");',
      "",
      "async function readState() {",
      "  try {",
      '    return JSON.parse(await readFile(statePath, "utf8"));',
      "  } catch {",
      "    return { counts: {} };",
      "  }",
      "}",
      "",
      "async function writeState(state) {",
      "  await mkdir(path.dirname(statePath), { recursive: true });",
      '  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");',
      "}",
      "",
      "function readOption(optionName) {",
      "  const index = args.indexOf(optionName);",
      "  if (index === -1) {",
      "    return null;",
      "  }",
      "  return args[index + 1] ?? null;",
      "}",
      "",
      "const state = await readState();",
      "const nextCount = (state.counts[command] ?? 0) + 1;",
      "state.counts[command] = nextCount;",
      "await writeState(state);",
      "",
      "if (logPath) {",
      "  await mkdir(path.dirname(logPath), { recursive: true });",
      '  await appendFile(logPath, `${JSON.stringify({ command, cwd: process.cwd(), count: nextCount })}\\n`, "utf8");',
      "}",
      "",
      'const outcome = outcomeMap[`${command}#${nextCount}`] ?? outcomeMap[command] ?? {};',
      "",
      'if (command.startsWith("run doctor -- ")) {',
      '  const outputDir = command.slice("run doctor -- ".length);',
      "  await mkdir(outputDir, { recursive: true });",
      '  await writeFile(path.join(outputDir, "runtime-doctor.json"), "{\\n  \\"ok\\": true\\n}\\n", "utf8");',
      '  await writeFile(path.join(outputDir, "runtime-doctor.md"), "# doctor ok\\n", "utf8");',
      "}",
      "",
      'if (command.startsWith("run acceptance:live -- ")) {',
      '  const outputRoot = readOption("--output-root");',
      '  const requiredSuccesses = Number.parseInt(readOption("--successes") ?? "1", 10);',
      "  if (outputRoot) {",
      "    await mkdir(outputRoot, { recursive: true });",
      '    await writeFile(path.join(outputRoot, "acceptance-summary.json"), JSON.stringify({',
      '      generatedAt: "2026-04-23T00:00:00.000Z",',
      '      status: "passed",',
      '      stopReason: "required success count reached",',
      "      requiredSuccesses,",
      "      achievedSuccesses: requiredSuccesses,",
      "      attempts: Array.from({ length: requiredSuccesses }, (_, index) => ({",
      "        attemptNumber: index + 1,",
      '        attemptLabel: `attempt-${String(index + 1).padStart(2, "0")}`,',
      "        success: true",
      "      })),",
      '      failureFeedback: { count: 0, indexPath: null }',
      '    }, null, 2) + "\\n", "utf8");',
      '    await writeFile(path.join(outputRoot, "acceptance-summary.md"), "# acceptance ok\\n", "utf8");',
      "  }",
      "}",
      "",
      'if (command.startsWith("run acceptance:panel:browser:full -- ")) {',
      '  const outputRoot = readOption("--output-root");',
      "  if (outputRoot) {",
      '    const evidenceRoot = path.join(outputRoot, "panel-browser-smoke-fake");',
      "    await mkdir(evidenceRoot, { recursive: true });",
      '    await writeFile(path.join(evidenceRoot, "panel-browser-smoke-summary.json"), JSON.stringify({',
      '      generatedAt: "2026-04-23T00:00:00.000Z",',
      '      harnessPassed: true,',
      '      finalRunStatus: "completed",',
      '      autonomousFinalStatus: "completed"',
      '    }, null, 2) + "\\n", "utf8");',
      "  }",
      "}",
      "",
      'if (typeof outcome.stdout === "string") {',
      "  process.stdout.write(outcome.stdout);",
      "}",
      "",
      'if (typeof outcome.stderr === "string") {',
      "  process.stderr.write(outcome.stderr);",
      "}",
      "",
      'process.exit(typeof outcome.code === "number" ? outcome.code : 0);',
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    fixtureRoot,
    fakeNpmPath,
    logPath,
    statePath
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

async function runSoakLane(args, options = {}) {
  const fixture = options.fixture ?? (await createFakeNpmFixture());
  const env = {
    ...process.env,
    ...options.envOverrides,
    npm_execpath: fixture.fakeNpmPath,
    FAKE_NPM_LOG_PATH: fixture.logPath,
    FAKE_NPM_STATE_PATH: fixture.statePath,
    FAKE_NPM_OUTCOMES: JSON.stringify(options.outcomes ?? {})
  };

  try {
    const result = await execFileAsync(process.execPath, [soakScriptPath, ...args], {
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
  await runTest("overnight soak lane writes isolated summaries and output roots", async () => {
    const fixture = await createFakeNpmFixture();
    const outputRoot = path.join(fixture.fixtureRoot, "lane-output");
    const result = await runSoakLane(
      [
        "--output-root",
        outputRoot,
        "--burnin-rounds",
        "1",
        "--e2e-rounds",
        "2",
        "--acceptance-successes",
        "2",
        "--acceptance-max-attempts",
        "2",
        "--acceptance-max-rounds",
        "4",
        "--panel-max-rounds",
        "5",
        "--panel-watchdog-ms",
        "1000",
        "--panel-poll-interval-ms",
        "200"
      ],
      { fixture }
    );

    assert.equal(result.code, 0);

    const summary = JSON.parse(
      await readFile(path.join(outputRoot, "overnight-soak-summary.json"), "utf8")
    );
    const morningSummaryMarkdown = await readFile(path.join(outputRoot, "morning-summary.md"), "utf8");
    const commandLog = await readCommandLog(fixture.logPath);

    assert.equal(summary.status, "passed");
    assert.equal(summary.totals.stepsPassed, 4);
    assert.equal(summary.totals.stepsFailed, 0);
    assert.equal(summary.steps[0].doctorOutputDir, path.join(outputRoot, "burnin", "doctor"));
    assert.match(morningSummaryMarkdown, /Overnight Soak Morning Summary/);
    assert.match(morningSummaryMarkdown, /Morning Triage/);
    assert.ok(
      commandLog.some((entry) => entry.command === `run doctor -- ${path.join(outputRoot, "burnin", "doctor")}`)
    );
    assert.ok(
      commandLog.some((entry) =>
        entry.command.includes(`run acceptance:live -- --successes 2 --max-attempts 2 --max-rounds 4 --output-root ${path.join(outputRoot, "live-acceptance")}`)
      )
    );
    assert.ok(
      commandLog.some((entry) =>
        entry.command.includes(`run acceptance:panel:browser:full -- --output-root ${path.join(outputRoot, "panel-browser")}`)
      )
    );
  });

  await runTest("overnight soak lane fails closed and skips downstream steps after e2e failure", async () => {
    const fixture = await createFakeNpmFixture();
    const outputRoot = path.join(fixture.fixtureRoot, "lane-failure");
    const result = await runSoakLane(
      [
        "--output-root",
        outputRoot,
        "--burnin-rounds",
        "1",
        "--e2e-rounds",
        "2",
        "--acceptance-successes",
        "1",
        "--acceptance-max-attempts",
        "1"
      ],
      {
        fixture,
        outcomes: {
          "run test:e2e#3": {
            code: 9,
            stderr: "e2e failed\n"
          }
        }
      }
    );

    assert.equal(result.code, 1);

    const summary = JSON.parse(
      await readFile(path.join(outputRoot, "overnight-soak-summary.json"), "utf8")
    );

    assert.equal(summary.status, "failed");
    assert.equal(summary.steps[0].status, "passed");
    assert.equal(summary.steps[1].status, "failed");
    assert.equal(summary.steps[2].status, "skipped");
    assert.equal(summary.steps[3].status, "skipped");
    assert.match(summary.steps[1].stopReason ?? "", /round 2/i);
    assert.match(await readFile(path.join(outputRoot, "morning-summary.md"), "utf8"), /repeated-e2e log/i);
  });

  console.log("Overnight soak lane tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
