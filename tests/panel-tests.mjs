import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizePanelPort, startPanelServer } from "../src/lib/panel.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  return payload;
}

async function getText(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return body;
}

async function postAction(baseUrl, action, payload = {}) {
  return getJson(`${baseUrl}/api/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      action,
      payload
    })
  });
}

async function postActionExpectError(baseUrl, action, payload = {}) {
  const response = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      action,
      payload
    })
  });
  const body = await response.json();

  if (response.ok && body.ok !== false) {
    throw new Error(`Expected ${action} to fail, but it succeeded.`);
  }

  return body.error ?? `Request failed: ${response.status}`;
}

async function main() {
  await runTest("normalizePanelPort keeps defaults and validates range", async () => {
    assert.equal(normalizePanelPort(undefined), 4310);
    assert.equal(normalizePanelPort("0"), 0);
    assert.equal(normalizePanelPort("5999"), 5999);
    assert.throws(() => normalizePanelPort("-1"), /invalid panel port/i);
    assert.throws(() => normalizePanelPort("70000"), /invalid panel port/i);
    assert.throws(() => normalizePanelPort("nope"), /invalid panel port/i);
  });

  await runTest("panel server can drive init, intake, run, handoff, and dry-run dispatch", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-workspace-"));
    const panel = await startPanelServer({
      workspaceDir: workspaceRoot,
      port: 0
    });

    try {
      const statusBefore = await getJson(`${panel.url}/api/status`);
      assert.equal(statusBefore.overview.workspaceRoot, workspaceRoot);
      assert.equal(statusBefore.overview.intake.exists, false);
      assert.equal(statusBefore.overview.latestRun, null);

      await postAction(panel.url, "init");
      await postAction(panel.url, "intake", {
        request:
          "Read local sales.json and write summary.md to artifacts/reports; do not send email and do not call external APIs."
      });
      await postAction(panel.url, "confirm");
      const runResponse = await postAction(panel.url, "run", {
        runId: "panel-run"
      });
      assert.equal(runResponse.result.runId, "panel-run");

      const handoffResponse = await postAction(panel.url, "handoff", {
        runStatePath: runResponse.result.statePath
      });
      assert.ok(handoffResponse.result.readyTaskCount >= 1);

      const dispatchResponse = await postAction(panel.url, "dispatch", {
        handoffIndexPath: handoffResponse.result.indexPath,
        mode: "dry-run"
      });
      assert.ok(dispatchResponse.result.summary.total >= 1);

      const statusAfter = await getJson(`${panel.url}/api/status`);
      assert.equal(statusAfter.overview.intake.confirmedByUser, true);
      assert.equal(statusAfter.overview.latestRun?.summary?.runId, "panel-run");

      await stat(path.join(workspaceRoot, "runs", "panel-run", "run-state.json"));
      await stat(path.join(workspaceRoot, "runs", "panel-run", "handoffs", "index.json"));

      const dispatchResultsFixture = {
        summary: {
          mode: "execute",
          total: 1
        },
        results: [
          {
            taskId: "planning-brief",
            handoffId: "handoff-123",
            runtime: "gpt-runner",
            status: "incomplete",
            stdout: "Preferred model: gpt-5.4-pro",
            stderr: [
              "OpenAI Codex v0.120.0 (research preview)",
              "model: gpt-5.4-pro",
              "provider: OpenAI",
              "session id: session-123",
              "user",
              "# Planner Prompt",
              "hello from planner",
              "2026-04-19T01:00:00.000Z WARN retrying..."
            ].join("\n"),
            launcherPath: path.join(workspaceRoot, "runs", "panel-run", "handoffs", "planning-brief.launch.ps1"),
            resultPath: path.join(
              workspaceRoot,
              "runs",
              "panel-run",
              "handoffs",
              "results",
              "planning-brief.handoff-123.result.json"
            )
          }
        ]
      };
      await writeFile(
        path.join(workspaceRoot, "runs", "panel-run", "handoffs", "dispatch-results.json"),
        `${JSON.stringify(dispatchResultsFixture, null, 2)}\n`,
        "utf8"
      );

      const gptEvidenceResponse = await postAction(panel.url, "gpt-evidence", {
        runStatePath: runResponse.result.statePath
      });
      assert.equal(gptEvidenceResponse.result.interactionCount, 1);
      assert.equal(gptEvidenceResponse.result.gptInteractions[0]?.preferredModel, "gpt-5.4-pro");
      assert.equal(gptEvidenceResponse.result.gptInteractions[0]?.provider, "OpenAI");
      assert.equal(gptEvidenceResponse.result.gptInteractions[0]?.sessionId, "session-123");
      assert.match(gptEvidenceResponse.result.gptInteractions[0]?.promptText ?? "", /Planner Prompt/);
    } finally {
      await panel.close();
    }
  });

  await runTest("panel landing page exposes the human one-click controls and wiring", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-ui-contract-"));
    const panel = await startPanelServer({
      workspaceDir: workspaceRoot,
      port: 0
    });

    try {
      const pageHtml = await getText(panel.url);

      assert.match(pageHtml, /id="workspaceInput"/);
      assert.match(pageHtml, /id="requestInput"/);
      assert.match(pageHtml, /Start: Local workspace contains sales\.json and artifacts\/reports is writable\./);
      assert.match(pageHtml, /End point: Create artifacts\/reports\/summary\.md from local sales\.json without changing sales\.json\./);
      assert.match(pageHtml, /Success criteria:/);
      assert.match(pageHtml, /Input source: sales\.json\./);
      assert.match(pageHtml, /Out of scope: do not modify sales\.json; do not send email; do not call external APIs\./);
      assert.match(pageHtml, /id="runIdInput"/);
      assert.match(pageHtml, /id="maxRoundsInput" value="20"/);
      assert.match(pageHtml, /id="confirmationInput"/);
      assert.match(pageHtml, /id="applyWorkspaceBtn"/);
      assert.match(pageHtml, /id="previewIntakeBtn"/);
      assert.match(pageHtml, /id="quickStartBtn"/);
      assert.match(pageHtml, /id="resumeNowBtn"/);
      assert.match(pageHtml, /id="refreshStatusBtn"/);
      assert.match(pageHtml, /id="viewGptPromptBtn"/);
      assert.match(pageHtml, /id="initBtn"/);
      assert.match(pageHtml, /id="intakeBtn"/);
      assert.match(pageHtml, /id="confirmBtn"/);
      assert.match(pageHtml, /id="runBtn"/);
      assert.match(pageHtml, /id="autonomousBtn"/);
      assert.match(pageHtml, /id="doctorBtn"/);
      assert.match(pageHtml, /<details>/);
      assert.match(pageHtml, /Step 1\/2: analyze start\/end in plain language/);
      assert.match(pageHtml, /Step 2\/2: execute after human confirmation/);
      assert.match(pageHtml, /Quick start paused: clarify task details first/);
      assert.match(pageHtml, /Quick start paused: waiting for human confirmation/);
      assert.match(pageHtml, /Quick start failed/);
      assert.match(pageHtml, /window\.prompt\(/);
      assert.match(pageHtml, /confirmationInput\?\.value\?\.trim\(\)/);
      assert.match(pageHtml, /const successCriteriaSummary = Array\.isArray\(preview\.endPoint\?\.successTargets\)/);
      assert.match(pageHtml, /const outOfScopeSummary = Array\.isArray\(preview\.endPoint\?\.outOfScope\)/);
      assert.match(pageHtml, /\\nSuccess criteria: /);
      assert.match(pageHtml, /\\nOut of scope: /);
      assert.match(pageHtml, /document\.getElementById\("quickStartBtn"\)\.addEventListener\("click", runQuickStartSafe\)/);
      assert.match(pageHtml, /runAction\("intake-preview", \{ request: requestInput\.value \}/);
      assert.match(pageHtml, /invokeAction\(\s*"quick-start-safe"/);
      assert.match(pageHtml, /scheduleAutoResume\(overviewPayload\.overview\)/);
      assert.match(pageHtml, /refreshStatus\(\)\.catch/);
    } finally {
      await panel.close();
    }
  });

  await runTest(
    "panel quick-start-safe requires structured intake contract and previewDigest round-trip",
    async () => {
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-preview-"));
      const panel = await startPanelServer({
        workspaceDir: workspaceRoot,
        port: 0
      });
      const startPoint = "Local workspace has sales.json and artifacts/generated is writable.";
      const endPoint = "Write artifacts/generated/summary.md with daily totals and anomalies.";
      const successCriteria = [
        "summary.md exists",
        "summary includes total revenue and top 3 products"
      ];
      const inputSources = ["sales.json", "config/thresholds.json"];
      const outOfScope = ["do not send email notifications", "do not call external APIs"];
      const requestText = [
        `Start: ${startPoint}`,
        `End point: ${endPoint}`,
        `Success criteria: ${successCriteria.join("; ")}`,
        `Input source: ${inputSources.join("; ")}`,
        `Out of scope: ${outOfScope.join("; ")}`
      ].join("\n");
      const unstructuredRequest =
        "Read local sales.json and write summary.md to artifacts/reports; do not send email and do not call external APIs.";
      const runId = "quick-start-safe-preview-gate";
      const maxRounds = 1;
      const correctPreviewDigest = createHash("sha256").update(requestText, "utf8").digest("hex");
      const mismatchedPreviewDigest = correctPreviewDigest.endsWith("0")
        ? `${correctPreviewDigest.slice(0, -1)}1`
        : `${correctPreviewDigest.slice(0, -1)}0`;

      try {
        const missingContractMessage = await postActionExpectError(panel.url, "quick-start-safe", {
          request: unstructuredRequest,
          runId,
          maxRounds,
          previewDigest: "missing-digest",
          confirmationText: "not-used"
        });
        assert.match(missingContractMessage, /execution contract is incomplete/i);
        assert.match(missingContractMessage, /Execution contract is missing/i);

        const previewResponse = await postAction(panel.url, "intake-preview", {
          request: requestText
        });
        const preview = previewResponse.result.preview;

        assert.equal(typeof preview.confirmationToken, "string");
        assert.ok(preview.confirmationToken.length > 0);
        assert.equal(typeof preview.previewDigest, "string");
        assert.match(preview.previewDigest, /^[a-f0-9]{64}$/i);
        assert.ok(Array.isArray(preview.processSteps));
        assert.ok(preview.processSteps.length >= 3);
        assert.deepEqual(preview.startPoint.permissions, []);
        assert.equal(
          preview.humanCheckpoints.some((item) => /email|api|webhook|outbound|public-facing/i.test(item)),
          false
        );

        const digestMismatchMessage = await postActionExpectError(panel.url, "quick-start-safe", {
          request: requestText,
          runId,
          maxRounds,
          previewDigest: mismatchedPreviewDigest,
          confirmationText: preview.confirmationToken
        });
        assert.match(digestMismatchMessage, /Preview digest mismatch/i);
        assert.match(digestMismatchMessage, /expectedPreviewDigest:/i);
        assert.equal(
          digestMismatchMessage.includes(`- expectedPreviewDigest: ${correctPreviewDigest}`),
          true
        );
        assert.doesNotMatch(
          digestMismatchMessage,
          /Cannot start quick execution because the execution contract is incomplete/i
        );

        const statusAfterDigestMismatch = await getJson(`${panel.url}/api/status`);
        assert.equal(statusAfterDigestMismatch.overview.latestRun, null);
        assert.equal(statusAfterDigestMismatch.overview.intake.exists, false);
        assert.equal(statusAfterDigestMismatch.overview.intake.confirmedByUser, null);

        const confirmationMessage = await postActionExpectError(panel.url, "quick-start-safe", {
          request: requestText,
          runId,
          maxRounds,
          previewDigest: correctPreviewDigest,
          confirmationText: "I confirm start and end points"
        });
        assert.match(confirmationMessage, /Human confirmation is required before execution/i);
        assert.equal(confirmationMessage.includes(preview.confirmationToken), true);

        const status = await getJson(`${panel.url}/api/status`);
        assert.equal(status.overview.latestRun, null);
        assert.equal(status.overview.intake.exists, true);
        assert.equal(status.overview.intake.confirmedByUser, false);

        const successResponse = await postAction(panel.url, "quick-start-safe", {
          request: requestText,
          runId,
          maxRounds: 0,
          previewDigest: correctPreviewDigest,
          confirmationText: preview.confirmationToken
        });
        const generatedSpecPath = successResponse.result.spec.specPath;
        const runStatePath = successResponse.result.run.statePath;
        const specSnapshotPath = path.join(workspaceRoot, "runs", runId, "spec.snapshot.json");
        const generatedSpec = JSON.parse(await readFile(generatedSpecPath, "utf8"));
        const runState = JSON.parse(await readFile(runStatePath, "utf8"));
        const specSnapshot = JSON.parse(await readFile(specSnapshotPath, "utf8"));

        assert.equal(successResponse.result.outcome.kind, "in_progress");
        assert.match(successResponse.result.outcome.title, /still in progress|not finished yet/i);
        assert.match(successResponse.result.outcome.message, /round limit|additional autonomous rounds/i);
        assert.equal(generatedSpec.projectName, specSnapshot.projectName);
        assert.notEqual(generatedSpec.projectName, "AI Factory Demo");
        assert.equal(generatedSpec.projectGoal.oneLine, endPoint);
        assert.deepEqual(generatedSpec.acceptanceCriteria, successCriteria);
        assert.deepEqual(generatedSpec.integrations, []);
        assert.equal(runState.intake?.clarificationStatus, "confirmed");
        assert.equal(runState.projectName, generatedSpec.projectName);
        assert.equal(runState.runId, runId);
      } finally {
        await panel.close();
      }
    }
  );

  await runTest("panel status exposes waiting-retry metadata and auto-resume controls", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-waiting-retry-"));
    const runId = "waiting-retry-run";
    const runDirectory = path.join(workspaceRoot, "runs", runId);
    const nextRetryAt = "2026-04-20T18:45:00.000Z";
    const runStatePath = path.join(runDirectory, "run-state.json");
    const runStateFixture = {
      version: 1,
      runId,
      projectName: "Waiting Retry Demo",
      workspacePath: workspaceRoot,
      createdAt: "2026-04-20T18:30:00.000Z",
      updatedAt: "2026-04-20T18:31:00.000Z",
      status: "in_progress",
      summary: {
        totalTasks: 2,
        readyTasks: 0,
        pendingTasks: 0,
        waitingRetryTasks: 1,
        completedTasks: 1,
        blockedTasks: 0,
        failedTasks: 0
      },
      roles: {},
      retryPolicy: {},
      runtimeRouting: {},
      modelPolicy: {},
      mandatoryGates: [],
      intake: null,
      stopConditions: [],
      definitionOfDone: [],
      taskLedger: [
        {
          id: "planning-brief",
          phaseId: "planning",
          role: "planner",
          owner: "Codex",
          title: "Clarify the brief and execution sequence",
          description: "Planning completed.",
          status: "completed",
          attempts: 0,
          dependsOn: [],
          acceptanceCriteria: []
        },
        {
          id: "executor-retry",
          phaseId: "implementation",
          role: "executor",
          owner: "Codex",
          title: "Retry after cooldown",
          description: "Continue after the retry window opens.",
          status: "waiting_retry",
          attempts: 1,
          dependsOn: ["planning-brief"],
          acceptanceCriteria: [],
          nextRetryAt
        }
      ],
      nextActions: []
    };

    await mkdir(runDirectory, { recursive: true });
    await writeFile(runStatePath, `${JSON.stringify(runStateFixture, null, 2)}\n`, "utf8");

    const panel = await startPanelServer({
      workspaceDir: workspaceRoot,
      port: 0
    });

    try {
      const status = await getJson(`${panel.url}/api/status`);
      assert.equal(status.overview.latestRun?.summary?.waitingRetryTasks, 1);
      assert.equal(status.overview.latestRun?.waitingRetry?.earliestNextRetryAt, nextRetryAt);
      assert.deepEqual(status.overview.latestRun?.waitingRetry?.scheduledTaskIds, ["executor-retry"]);

      const pageHtml = await getText(panel.url);
      assert.match(pageHtml, /id="resumeNowBtn"/);
      assert.match(pageHtml, /Resume now/);
      assert.match(pageHtml, /Next retry at/);
      assert.match(pageHtml, /scheduleAutoResume\(overviewPayload\.overview\)/);
      assert.match(pageHtml, /Auto resume after waiting_retry/);
    } finally {
      await panel.close();
    }
  });

  console.log("Panel tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
