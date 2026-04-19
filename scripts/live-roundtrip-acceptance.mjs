import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultLauncherTimeoutMs = 300000;
const defaultMaxRounds = 12;
const defaultMaxBuffer = 128 * 1024 * 1024;

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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function classifyFailureCategory(reason = "") {
  const text = String(reason).toLowerCase();

  if (/rate limit|too many requests|429/.test(text)) {
    return "rate_limit";
  }

  if (/timeout|timed out|etimedout/.test(text)) {
    return "timeout";
  }

  if (/missing|not found|enoent|npm ci|dependency/.test(text)) {
    return "missing_dependency";
  }

  if (/502|bad gateway|network|connection|runtime is not available/.test(text)) {
    return "environment_mismatch";
  }

  if (/artifact|schema|invalid json|prompt hash mismatch|idempotency key mismatch/.test(text)) {
    return "artifact_invalid";
  }

  if (/verification|test failed|lint|typecheck|build failed/.test(text)) {
    return "verification_failed";
  }

  if (/logic|state transition|stale/.test(text)) {
    return "logic_bug";
  }

  return "unknown";
}

function buildFailureFeedbackRecord({ attemptNumber, attemptLabel, reason, outputRoot }) {
  const category = classifyFailureCategory(reason);
  const retryable = ["rate_limit", "timeout", "missing_dependency", "environment_mismatch"].includes(category);

  return {
    taskId: `live-roundtrip-${String(attemptNumber).padStart(2, "0")}`,
    category,
    summary: isNonEmptyString(reason)
      ? reason
      : "Live roundtrip attempt failed without a detailed message.",
    evidence: [
      path.join(outputRoot, attemptLabel, "logs")
    ],
    likelyCause:
      category === "timeout"
        ? "Launcher exceeded timeout budget during this attempt."
        : category === "environment_mismatch"
          ? "Runtime or network condition was unstable."
          : "See attempt logs for the most specific error details.",
    nextBestAction:
      category === "timeout"
        ? "Inspect attempt logs, then tune timeout only if evidence shows long-running valid work."
        : "Rerun after addressing the captured failure signal.",
    retryable
  };
}

function parseArgs(argv) {
  const options = {
    successes: 5,
    maxAttempts: 8,
    maxRounds: defaultMaxRounds,
    launcherTimeoutMs: defaultLauncherTimeoutMs,
    outputRoot: path.join(projectRoot, "reports", "acceptance", `live-roundtrip-${timestampLabel()}`)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];

    switch (argument) {
      case "--successes":
        options.successes = parsePositiveInteger(nextValue, options.successes);
        index += 1;
        break;
      case "--max-attempts":
        options.maxAttempts = parsePositiveInteger(nextValue, options.maxAttempts);
        index += 1;
        break;
      case "--max-rounds":
        options.maxRounds = parsePositiveInteger(nextValue, options.maxRounds);
        index += 1;
        break;
      case "--launcher-timeout-ms":
        options.launcherTimeoutMs = parsePositiveInteger(nextValue, options.launcherTimeoutMs);
        index += 1;
        break;
      case "--output-root":
        options.outputRoot = path.resolve(projectRoot, nextValue ?? options.outputRoot);
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node scripts/live-roundtrip-acceptance.mjs [options]

Options:
  --successes <count>            Successful runs required before passing (default: 5)
  --max-attempts <count>         Maximum total attempts before failing (default: 7)
  --max-rounds <count>           Autonomous max rounds per run (default: ${defaultMaxRounds})
  --launcher-timeout-ms <ms>     Launcher timeout override for GPT/Codex/local-ci (default: ${defaultLauncherTimeoutMs})
  --output-root <dir>            Directory for acceptance artifacts
`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.maxAttempts < options.successes) {
    options.maxAttempts = options.successes;
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

async function readJson(targetPath) {
  return JSON.parse((await readFile(targetPath, "utf8")).replace(/^\uFEFF/, ""));
}

async function readTextFile(targetPath) {
  return (await readFile(targetPath, "utf8")).replace(/^\uFEFF/, "");
}

async function writeJson(targetPath, value) {
  await ensureDirectory(path.dirname(targetPath));
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(targetPath, content) {
  await ensureDirectory(path.dirname(targetPath));
  await writeFile(targetPath, content, "utf8");
}

function createAttemptTokens(attemptNumber) {
  const prefix = String(attemptNumber).padStart(2, "0");
  const entropy = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`.toUpperCase();
  return {
    alphaToken: `ALPHA-${prefix}-${entropy.slice(0, 8)}`,
    betaToken: `BETA-${prefix}-${entropy.slice(8, 16).padEnd(8, "0")}`
  };
}

function buildWorkspacePackageJson() {
  return {
    name: "ai-factory-live-roundtrip-acceptance",
    private: true,
    version: "1.0.0",
    scripts: {
      build: 'node -e "console.log(\'build ok\')"',
      lint: 'node -e "console.log(\'lint ok\')"',
      typecheck: 'node -e "console.log(\'typecheck ok\')"',
      test: 'node -e "console.log(\'test ok\')"',
      "test:integration": 'node -e "console.log(\'integration ok\')"',
      "test:e2e": 'node -e "console.log(\'fixture e2e ok\')"'
    }
  };
}

function buildWorkspaceSpec(attemptNumber) {
  return {
    projectName: `Live Roundtrip Acceptance ${String(attemptNumber).padStart(2, "0")}`,
    summary: "Validate real GPT and Codex roundtrip behavior against local workspace files.",
    projectGoal: {
      oneLine: "Use GPT and Codex to process local files and leave verifiable artifacts.",
      details:
        "Exercise the full automated route: GPT planning, Codex implementation, GPT review, local-ci verification, and GPT delivery packaging, all against local workspace files."
    },
    targetUsers: [
      "Operators validating autonomous runs before release",
      "Non-programmers who need auditable local-file handling"
    ],
    coreFeatures: [
      {
        id: "local-file-summary",
        title: "Summarize local files into markdown",
        description:
          "Read the local files data/brief.txt and data/details.txt. Create artifacts/generated/summary.md. The markdown must include the exact tokens found in both files, a heading named Combined Notes, and a short Chinese summary. Do not modify the input files.",
        acceptanceCriteria: [
          "artifacts/generated/summary.md exists",
          "summary.md includes the exact token from data/brief.txt",
          "summary.md includes the exact token from data/details.txt",
          "summary.md contains a heading named Combined Notes",
          "summary.md includes a short Chinese summary"
        ]
      }
    ],
    backlogFeatures: [],
    nonGoals: [
      "Do not modify the input files in data/",
      "Do not call arbitrary third-party services outside the configured runtime route"
    ],
    design: {
      tone: "Clear, concise, and operator-friendly",
      references: [],
      mobileRequired: false,
      desktopRequired: true
    },
    technicalConstraints: {
      preferredStack: ["Node.js", "Markdown artifacts", "Local workspace files"],
      forbiddenTools: [
        "Claiming success without verification artifacts",
        "Modifying the input files under data/"
      ],
      deploymentTarget: "Local machine workflow"
    },
    integrations: [
      {
        name: "GPT Runner",
        status: "active",
        notes: "Planner, reviewer, and delivery path"
      },
      {
        name: "Codex",
        status: "active",
        notes: "Implementation path"
      },
      {
        name: "local-ci",
        status: "active",
        notes: "Verification path"
      }
    ],
    dataSources: ["data/brief.txt", "data/details.txt"],
    definitionOfDone: [
      "The planner, executor, reviewer, verifier, and delivery tasks all complete successfully",
      "artifacts/generated/summary.md exists",
      "The output markdown includes both local file tokens and the Combined Notes heading"
    ],
    acceptanceCriteria: [
      "The planner handoff runs on gpt-runner",
      "The implementation handoff runs on codex",
      "The review handoff runs on gpt-runner",
      "The verification handoff runs on local-ci",
      "The delivery handoff runs on gpt-runner"
    ],
    riskStopRules: [
      "Pause if the workflow needs to delete production data",
      "Pause if an irreversible migration is required",
      "Pause if a new paid external service must be added"
    ],
    priorities: [
      "Verification before convenience",
      "Preserve local file evidence",
      "Keep routing explicit"
    ],
    deliverables: [
      "Generated markdown summary",
      "Planner, implementation, review, verification, and delivery result artifacts",
      "Autonomous summary and run-state artifacts"
    ]
  };
}

async function configureAttemptWorkspace(workspaceRoot, attemptNumber) {
  const dataRoot = path.join(workspaceRoot, "data");
  const specsRoot = path.join(workspaceRoot, "specs");
  const configPath = path.join(workspaceRoot, "config", "factory.config.json");
  const specPath = path.join(specsRoot, "project-spec.json");
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const { alphaToken, betaToken } = createAttemptTokens(attemptNumber);

  await ensureDirectory(dataRoot);
  await ensureDirectory(specsRoot);
  await writeText(path.join(dataRoot, "brief.txt"), `Brief token: ${alphaToken}\n`);
  await writeText(path.join(dataRoot, "details.txt"), `Details token: ${betaToken}\n`);
  await writeJson(packageJsonPath, buildWorkspacePackageJson());
  await writeJson(specPath, buildWorkspaceSpec(attemptNumber));

  const factoryConfig = await readJson(configPath);
  factoryConfig.modelPolicy = factoryConfig.modelPolicy ?? {};
  factoryConfig.modelPolicy.escalation = {
    ...(factoryConfig.modelPolicy.escalation ?? {}),
    minimumRetryCount: 99,
    minimumAttempts: 99,
    escalateOnAttentionRequired: false,
    escalateOnBlockedHistory: false,
    escalateOnDispatchFailure: false,
    forceProTaskIds: [],
    forceProTaskPatterns: []
  };
  await writeJson(configPath, factoryConfig);

  return {
    specPath,
    packageJsonPath,
    configPath,
    alphaToken,
    betaToken
  };
}

async function runNodeStep(stepName, args, { env, logDirectory }) {
  await ensureDirectory(logDirectory);
  const stdoutPath = path.join(logDirectory, `${stepName}.out.log`);
  const stderrPath = path.join(logDirectory, `${stepName}.err.log`);

  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      maxBuffer: defaultMaxBuffer
    });

    await writeText(stdoutPath, result.stdout ?? "");
    await writeText(stderrPath, result.stderr ?? "");

    return {
      stepName,
      args,
      stdoutPath,
      stderrPath,
      exitCode: 0
    };
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";

    await writeText(stdoutPath, stdout);
    await writeText(stderrPath, stderr);

    throw new Error(
      `Step failed: ${stepName}\n` +
        `args=${args.join(" ")}\n` +
        `stdout=${stdoutPath}\n` +
        `stderr=${stderrPath}\n` +
        `reason=${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function ensureHanCharacters(text, label) {
  assert.match(text, /\p{Script=Han}/u, `${label} should contain readable Chinese characters`);
}

async function verifyAttemptArtifacts({
  workspaceRoot,
  runRoot,
  handoffRoot,
  doctorReportPath,
  alphaToken,
  betaToken
}) {
  const runStatePath = path.join(runRoot, "run-state.json");
  const autonomousSummaryPath = path.join(runRoot, "autonomous-summary.json");
  const dispatchResultsPath = path.join(handoffRoot, "dispatch-results.json");
  const implementationBriefPath = path.join(runRoot, "task-briefs", "implement-local-file-summary.md");
  const summaryMarkdownPath = path.join(workspaceRoot, "artifacts", "generated", "summary.md");
  const runState = await readJson(runStatePath);
  const autonomousSummary = await readJson(autonomousSummaryPath);
  const dispatchResults = await readJson(dispatchResultsPath);
  const doctorReport = await readJson(doctorReportPath);
  const implementationBrief = await readTextFile(implementationBriefPath);
  const summaryMarkdown = await readTextFile(summaryMarkdownPath);

  assert.equal(runState.status, "completed", "run-state should end completed");
  assert.equal(autonomousSummary.finalStatus, "completed", "autonomous final status should be completed");
  assert.equal(autonomousSummary.stopReason, "run completed", "autonomous stop reason should be run completed");
  assert.ok(runState.taskLedger.every((task) => task.status === "completed"), "every task should complete");
  assert.match(implementationBrief, /data\/brief\.txt/i, "implementation brief should mention data/brief.txt");
  assert.match(implementationBrief, /data\/details\.txt/i, "implementation brief should mention data/details.txt");
  assert.match(summaryMarkdown, /^# Combined Notes/m, "summary markdown should include Combined Notes heading");
  assert.match(summaryMarkdown, new RegExp(alphaToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "summary markdown should include alpha token");
  assert.match(summaryMarkdown, new RegExp(betaToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "summary markdown should include beta token");
  ensureHanCharacters(summaryMarkdown, "summary markdown");
  assert.equal(dispatchResults.summary.completed, 1, "final dispatch should complete one task");
  assert.equal(dispatchResults.results[0]?.taskId, "delivery-package", "final dispatch should package delivery");
  assert.equal(dispatchResults.results[0]?.status, "completed", "delivery dispatch result should complete");

  const requiredRuntimeStatuses = new Map(
    doctorReport.checks
      .filter((check) => check.requiredByDefaultRoute)
      .map((check) => [check.id, check.ok])
  );
  assert.equal(requiredRuntimeStatuses.get("gpt-runner"), true, "gpt-runner should be ready");
  assert.equal(requiredRuntimeStatuses.get("codex"), true, "codex should be ready");
  assert.equal(requiredRuntimeStatuses.get("local-ci"), true, "local-ci should be ready");

  const expectedRuntimes = new Map([
    ["planning-brief", "gpt-runner"],
    ["implement-local-file-summary", "codex"],
    ["review-local-file-summary", "gpt-runner"],
    ["verify-local-file-summary", "local-ci"],
    ["delivery-package", "gpt-runner"]
  ]);
  const taskEvidence = [];

  for (const [taskId, expectedRuntimeId] of expectedRuntimes) {
    const descriptorPath = path.join(handoffRoot, `${taskId}.handoff.json`);
    assert.equal(await fileExists(descriptorPath), true, `descriptor should exist for ${taskId}`);
    const descriptor = await readJson(descriptorPath);
    assert.equal(descriptor.runtime?.id, expectedRuntimeId, `${taskId} should route to ${expectedRuntimeId}`);
    assert.equal(await fileExists(descriptor.paths?.resultPath), true, `result artifact should exist for ${taskId}`);
    const result = await readJson(descriptor.paths.resultPath);
    assert.equal(result.status, "completed", `${taskId} result should be completed`);
    taskEvidence.push({
      taskId,
      runtimeId: descriptor.runtime.id,
      resultPath: descriptor.paths.resultPath
    });
  }

  return {
    runStatePath,
    autonomousSummaryPath,
    dispatchResultsPath,
    doctorReportPath,
    summaryMarkdownPath,
    taskEvidence
  };
}

async function runAttempt({ attemptNumber, maxRounds, launcherTimeoutMs, outputRoot }) {
  const attemptLabel = `attempt-${String(attemptNumber).padStart(2, "0")}`;
  const attemptRoot = path.join(outputRoot, attemptLabel);
  const workspaceRoot = path.join(attemptRoot, "workspace");
  const runsRoot = path.join(workspaceRoot, "runs");
  const reportsRoot = path.join(workspaceRoot, "reports");
  const logDirectory = path.join(attemptRoot, "logs");
  const runId = `live-roundtrip-${String(attemptNumber).padStart(2, "0")}`;
  const runRoot = path.join(runsRoot, runId);
  const runStatePath = path.join(runRoot, "run-state.json");
  const doctorReportPath = path.join(reportsRoot, "runtime-doctor.json");
  const handoffRoot = path.join(runRoot, "handoffs-autonomous");
  const steps = [];
  const startedAt = new Date();
  const env = {
    ...process.env,
    AI_FACTORY_LAUNCHER_TIMEOUT_MS: String(launcherTimeoutMs),
    AI_FACTORY_POWERSHELL_TIMEOUT_MS: String(launcherTimeoutMs)
  };

  await ensureDirectory(attemptRoot);
  await runNodeStep("01-init", ["src/index.mjs", "init", workspaceRoot], {
    env,
    logDirectory
  }).then((result) => steps.push(result));

  const workspaceConfig = await configureAttemptWorkspace(workspaceRoot, attemptNumber);

  await runNodeStep("02-validate", ["src/index.mjs", "validate", workspaceConfig.specPath], {
    env,
    logDirectory
  }).then((result) => steps.push(result));
  await runNodeStep("03-run", ["src/index.mjs", "run", workspaceConfig.specPath, runsRoot, runId], {
    env,
    logDirectory
  }).then((result) => steps.push(result));
  await runNodeStep("04-doctor", ["src/index.mjs", "doctor", reportsRoot], {
    env,
    logDirectory
  }).then((result) => steps.push(result));
  await runNodeStep(
    "05-autonomous",
    ["src/index.mjs", "autonomous", runStatePath, doctorReportPath, handoffRoot, String(maxRounds)],
    {
      env,
      logDirectory
    }
  ).then((result) => steps.push(result));

  const evidence = await verifyAttemptArtifacts({
    workspaceRoot,
    runRoot,
    handoffRoot,
    doctorReportPath,
    alphaToken: workspaceConfig.alphaToken,
    betaToken: workspaceConfig.betaToken
  });

  return {
    attemptNumber,
    attemptLabel,
    success: true,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    workspaceRoot,
    runId,
    runRoot,
    handoffRoot,
    tokens: {
      alpha: workspaceConfig.alphaToken,
      beta: workspaceConfig.betaToken
    },
    steps,
    evidence
  };
}

function renderSummaryMarkdown(summary) {
  const lines = [
    "# Live Roundtrip Acceptance Summary",
    "",
    `- Generated at: ${summary.generatedAt}`,
    `- Required successes: ${summary.requiredSuccesses}`,
    `- Achieved successes: ${summary.achievedSuccesses}`,
    `- Attempt limit: ${summary.maxAttempts}`,
    `- Launcher timeout (ms): ${summary.launcherTimeoutMs}`,
    `- Autonomous max rounds: ${summary.maxRounds}`,
    `- Final status: ${summary.status}`,
    `- Failure feedback artifacts: ${summary.failureFeedback?.count ?? 0}`,
    "",
    "## Attempts"
  ];

  for (const attempt of summary.attempts) {
    lines.push(
      `- ${attempt.attemptLabel}: ${attempt.success ? "success" : "failed"} | runId=${attempt.runId ?? "n/a"} | duration=${attempt.durationSeconds ?? 0}s`
    );
    if (attempt.failure) {
      lines.push(`  reason: ${attempt.failure}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function writeFailureFeedbackArtifacts(outputRoot, feedbackRecords) {
  const records = Array.isArray(feedbackRecords) ? feedbackRecords : [];

  if (records.length === 0) {
    return {
      count: 0,
      directory: null,
      indexPath: null,
      generatedTestCasesPath: null
    };
  }

  const feedbackDirectory = path.join(outputRoot, "failure-feedback");
  await ensureDirectory(feedbackDirectory);
  const written = [];

  for (const [index, record] of records.entries()) {
    const artifactPath = path.join(
      feedbackDirectory,
      `${String(index + 1).padStart(3, "0")}-${record.taskId}.json`
    );
    await writeJson(artifactPath, record);
    written.push({
      ...record,
      path: artifactPath
    });
  }

  const indexPath = path.join(feedbackDirectory, "failure-feedback-index.json");
  const generatedTestCasesPath = path.join(feedbackDirectory, "generated-test-cases.json");
  await writeJson(indexPath, {
    generatedAt: new Date().toISOString(),
    count: written.length,
    entries: written
  });
  await writeJson(generatedTestCasesPath, {
    generatedAt: new Date().toISOString(),
    sourceIndexPath: indexPath,
    cases: written.map((entry, index) => ({
      id: `live-ff-${String(index + 1).padStart(3, "0")}`,
      sourceFeedbackPath: entry.path,
      category: entry.category,
      scenario: entry.summary,
      expectedBehavior: entry.nextBestAction,
      retryable: entry.retryable
    }))
  });

  return {
    count: written.length,
    directory: feedbackDirectory,
    indexPath,
    generatedTestCasesPath
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDirectory(options.outputRoot);

  const attempts = [];
  const failureFeedbackRecords = [];
  let successCount = 0;

  for (let attemptNumber = 1; attemptNumber <= options.maxAttempts; attemptNumber += 1) {
    console.log(`Starting live roundtrip attempt ${attemptNumber}/${options.maxAttempts}...`);

    try {
      const attempt = await runAttempt({
        attemptNumber,
        maxRounds: options.maxRounds,
        launcherTimeoutMs: options.launcherTimeoutMs,
        outputRoot: options.outputRoot
      });
      attempts.push(attempt);
      successCount += 1;
      console.log(
        `Attempt ${attemptNumber} succeeded: ${attempt.runId} (${attempt.durationSeconds}s, success ${successCount}/${options.successes})`
      );
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const attemptLabel = `attempt-${String(attemptNumber).padStart(2, "0")}`;
      attempts.push({
        attemptNumber,
        attemptLabel,
        success: false,
        finishedAt: new Date().toISOString(),
        failure: failureMessage
      });
      failureFeedbackRecords.push(
        buildFailureFeedbackRecord({
          attemptNumber,
          attemptLabel,
          reason: failureMessage,
          outputRoot: options.outputRoot
        })
      );
      console.error(`Attempt ${attemptNumber} failed.`);
      console.error(failureMessage);
    }

    if (successCount >= options.successes) {
      break;
    }
  }

  const failureFeedback = await writeFailureFeedbackArtifacts(options.outputRoot, failureFeedbackRecords);
  const summary = {
    generatedAt: new Date().toISOString(),
    status: successCount >= options.successes ? "passed" : "failed",
    requiredSuccesses: options.successes,
    achievedSuccesses: successCount,
    maxAttempts: options.maxAttempts,
    maxRounds: options.maxRounds,
    launcherTimeoutMs: options.launcherTimeoutMs,
    outputRoot: options.outputRoot,
    failureFeedback,
    attempts
  };
  const summaryJsonPath = path.join(options.outputRoot, "acceptance-summary.json");
  const summaryMarkdownPath = path.join(options.outputRoot, "acceptance-summary.md");

  await writeJson(summaryJsonPath, summary);
  await writeText(summaryMarkdownPath, renderSummaryMarkdown(summary));

  console.log(`Acceptance summary JSON: ${summaryJsonPath}`);
  console.log(`Acceptance summary Markdown: ${summaryMarkdownPath}`);

  if (summary.status !== "passed") {
    throw new Error(
      `Live roundtrip acceptance did not reach ${options.successes} successful attempts (got ${successCount}/${options.successes}).`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
