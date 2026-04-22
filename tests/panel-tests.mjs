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
      assert.match(pageHtml, /End point: Create artifacts\/reports\/summary\.md from local sales\.json\./);
      assert.match(pageHtml, /Success criteria:/);
      assert.match(pageHtml, /Input source: sales\.json\./);
      assert.match(pageHtml, /Out of scope: do not modify sales\.json; do not send email; do not call external APIs\./);
      assert.match(pageHtml, /終點只要寫交付結果或輸出檔名；像「不要改原檔」這種限制，寫在「非範圍」就好。/);
      assert.match(pageHtml, /id="runIdInput"/);
      assert.match(pageHtml, /id="maxRoundsInput" value="20"/);
      assert.match(pageHtml, /id="confirmationInput"/);
      assert.match(pageHtml, /id="assistantCard"/);
      assert.match(pageHtml, /id="assistantStepBadge"/);
      assert.match(pageHtml, /id="assistantQuestion"/);
      assert.match(pageHtml, /id="assistantHint"/);
      assert.match(pageHtml, /id="assistantAnswer"/);
      assert.match(pageHtml, /id="assistantMirror"/);
      assert.match(pageHtml, /id="assistantSummary"/);
      assert.match(pageHtml, /id="assistantReflectBtn"/);
      assert.match(pageHtml, /id="assistantRewriteBtn"/);
      assert.match(pageHtml, /id="assistantLoadBtn"/);
      assert.match(pageHtml, /id="assistantBackBtn"/);
      assert.match(pageHtml, /id="assistantNextBtn"/);
      assert.match(pageHtml, /id="assistantApplyBtn"/);
      assert.match(pageHtml, /id="assistantApplyRunBtn"/);
      assert.match(pageHtml, /id="assistantResetBtn"/);
      assert.match(pageHtml, /id="startCheckCard"/);
      assert.match(pageHtml, /id="startCheckHint"/);
      assert.match(pageHtml, /id="startCheckSummary"/);
      assert.match(pageHtml, /id="previewCard"/);
      assert.match(pageHtml, /id="previewHint"/);
      assert.match(pageHtml, /id="previewSummary"/);
      assert.match(pageHtml, /id="humanStatusCard"/);
      assert.match(pageHtml, /id="humanStatusHint"/);
      assert.match(pageHtml, /id="humanStatusSummary"/);
      assert.match(pageHtml, /id="resultCard"/);
      assert.match(pageHtml, /id="resultHint"/);
      assert.match(pageHtml, /id="resultSummary"/);
      assert.match(pageHtml, /id="toastStack"/);
      assert.match(pageHtml, /id="progressHeadline"/);
      assert.match(pageHtml, /id="progressPercent"/);
      assert.match(pageHtml, /id="progressTrack"/);
      assert.match(pageHtml, /id="progressBar"/);
      assert.match(pageHtml, /id="progressCaption"/);
      assert.match(pageHtml, /id="applyWorkspaceBtn"/);
      assert.match(pageHtml, /id="previewIntakeBtn"/);
      assert.match(pageHtml, /id="quickStartBtn"/);
      assert.match(pageHtml, /id="abandonTaskBtn"/);
      assert.match(pageHtml, /id="primaryActions"/);
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
      assert.match(pageHtml, /class="assistant-details"/);
      assert.match(pageHtml, /id="assistantMoreActions"/);
      assert.match(pageHtml, /id="advancedActions"/);
      assert.match(pageHtml, /id="startCheckCard" hidden/);
      assert.match(pageHtml, /id="resultCard" hidden/);
      assert.match(pageHtml, /Step 1\/2: analyze start\/end in plain language/);
      assert.match(pageHtml, /Step 2\/2: execute after human confirmation/);
      assert.match(pageHtml, /Quick start paused: clarify task details first/);
      assert.match(pageHtml, /Quick start paused: waiting for human confirmation/);
      assert.match(pageHtml, /Quick start failed/);
      assert.match(pageHtml, /一鍵開始：正在分析需求/);
      assert.match(pageHtml, /一鍵開始：已送出執行/);
      assert.match(pageHtml, /function renderPreviewSummary\(preview, title = "分析完成"\)/);
      assert.match(pageHtml, /confirmationInput\.value = confirmationToken/);
      assert.match(pageHtml, /previewCard\.scrollIntoView/);
      assert.match(pageHtml, /function startProgressRefresh\(intervalMs = 3000\)/);
      assert.match(pageHtml, /function stopProgressRefresh\(\)/);
      assert.match(pageHtml, /function showToast\(kind, title, message, options = \{\}\)/);
      assert.match(pageHtml, /function setTransientProgress\(headline, caption, options = \{\}\)/);
      assert.match(pageHtml, /function summarizeInteractionActor\(overview = latestOverview\)/);
      assert.match(pageHtml, /function renderHumanConfirmationChecklist\(preview\)/);
      assert.match(pageHtml, /function renderFlowSteps\(activeStep = 1\)/);
      assert.match(pageHtml, /function buildNewTaskDraftOverview\(overview = latestOverview\)/);
      assert.match(pageHtml, /function clearDraftTaskMode\(\)/);
      assert.match(pageHtml, /function deriveDisplayedOverview\(overview\)/);
      assert.match(pageHtml, /function prepareForNewTaskDraft\(\)/);
      assert.match(pageHtml, /function summarizeRunProgress\(overview\)/);
      assert.match(pageHtml, /function summarizeOverviewStatus\(overview\)/);
      assert.match(pageHtml, /function summarizeOverviewProgressKey\(overview\)/);
      assert.match(pageHtml, /function shouldAutoRefreshOverview\(overview = latestOverview\)/);
      assert.match(pageHtml, /function syncLiveStatusRefresh\(overview = latestOverview\)/);
      assert.match(pageHtml, /function maybeNotifyOverviewChange\(overview\)/);
      assert.match(pageHtml, /function appendLogEntry\(title, value, options = \{\}\)/);
      assert.match(pageHtml, /function syncOperationLogWithOverview\(overview\)/);
      assert.match(pageHtml, /function previewProtectsOriginalInput\(preview\)/);
      assert.match(pageHtml, /function renderStartCheckCard\(preview = latestPreview\)/);
      assert.match(pageHtml, /function renderHumanStatusCard\(overview = latestOverview\)/);
      assert.match(pageHtml, /function buildAssistantReflection\(stepKey, answer\)/);
      assert.match(pageHtml, /function rewriteAssistantAnswerForStep\(stepKey, answer\)/);
      assert.match(pageHtml, /function renderAssistantMirror\(message, title = "我理解的是…對嗎？"\)/);
      assert.match(pageHtml, /function renderResultCard\(overview = latestOverview\)/);
      assert.match(pageHtml, /function parseAssistantStateFromRequest\(requestText\)/);
      assert.match(pageHtml, /function buildAssistantRequestText\(\)/);
      assert.match(pageHtml, /function assistantHasMinimumFields\(\)/);
      assert.match(pageHtml, /function renderAssistantSummary\(\)/);
      assert.match(pageHtml, /function renderAssistantWizard\(\)/);
      assert.match(pageHtml, /function persistAssistantAnswer\(\)/);
      assert.match(pageHtml, /function loadAssistantFromRequestInput\(options = \{\}\)/);
      assert.match(pageHtml, /function resetAssistantWizard\(\)/);
      assert.match(pageHtml, /function applyAssistantToRequestInput\(\)/);
      assert.match(pageHtml, /let lastLoggedProgressKey = null/);
      assert.match(pageHtml, /const browserTimeZone = Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone \|\| "local"/);
      assert.match(pageHtml, /toast\.dataset\.toastKey = dedupeKey/);
      assert.match(pageHtml, /actor-banner/);
      assert.match(pageHtml, /confirm-checklist/);
      assert.match(pageHtml, /flow-grid/);
      assert.match(pageHtml, /wizard-shell/);
      assert.match(pageHtml, /wizard-step/);
      assert.match(pageHtml, /wizard-summary/);
      assert.match(pageHtml, /目前互動對象/);
      assert.match(pageHtml, /lastObservedStatusKey === null/);
      assert.match(pageHtml, /statusSummary\.key === lastObservedStatusKey/);
      assert.match(pageHtml, /showToast\(statusSummary\.kind, statusSummary\.title, statusSummary\.message/);
      assert.match(pageHtml, /appendLogEntry\(\(interactionActor\.actor \|\| "系統"\) \+ " 狀態更新"/);
      assert.match(pageHtml, /syncOperationLogWithOverview\(overview\)/);
      assert.match(pageHtml, /右側目前狀態會自動刷新/);
      assert.match(pageHtml, /currentTaskNote: sanitizeTaskNote\(latestRun\.activity\?\.currentTask\?\.latestNote\)/);
      assert.match(pageHtml, /pendingTasks: summary\.pendingTasks \?\? 0/);
      assert.match(pageHtml, /timeZone: browserTimeZone/);
      assert.match(pageHtml, /window\.prompt\(/);
      assert.match(pageHtml, /confirmationInput\?\.value\?\.trim\(\)/);
      assert.match(pageHtml, /const successCriteriaSummary = Array\.isArray\(preview\.endPoint\?\.successTargets\)/);
      assert.match(pageHtml, /const outOfScopeSummary = Array\.isArray\(preview\.endPoint\?\.outOfScope\)/);
      assert.match(pageHtml, /\\nSuccess criteria: /);
      assert.match(pageHtml, /\\nOut of scope: /);
      assert.match(pageHtml, /document\.getElementById\("quickStartBtn"\)\.addEventListener\("click", runQuickStartSafe\)/);
      assert.match(pageHtml, /document\.getElementById\("previewIntakeBtn"\)\.addEventListener\("click", previewIntake\)/);
      assert.match(pageHtml, /assistantAnswer\.addEventListener\("input", \(\) =>/);
      assert.match(pageHtml, /assistantReflectBtn\.addEventListener\("click", \(\) =>/);
      assert.match(pageHtml, /assistantRewriteBtn\.addEventListener\("click", \(\) =>/);
      assert.match(pageHtml, /assistantLoadBtn\.addEventListener\("click", \(\) =>/);
      assert.match(pageHtml, /abandonTaskBtn\.addEventListener\("click", \(\) =>/);
      assert.match(pageHtml, /assistantBackBtn\.addEventListener\("click", \(\) =>/);
      assert.match(pageHtml, /assistantNextBtn\.addEventListener\("click", \(\) =>/);
      assert.match(pageHtml, /assistantApplyBtn\.addEventListener\("click", \(\) =>/);
      assert.match(pageHtml, /assistantApplyRunBtn\.addEventListener\("click", async \(\) =>/);
      assert.match(pageHtml, /assistantResetBtn\.addEventListener\("click", \(\) =>/);
      assert.match(pageHtml, /renderPreviewSummary\(preview, [\s\S]*?renderStartCheckCard\(preview\);/);
      assert.match(pageHtml, /applyAssistantToRequestInput\(\);[\s\S]*await runQuickStartSafe\(\);/);
      assert.match(pageHtml, /assistantReflectBtn[\s\S]*?rewriteAssistantAnswerForStep\(step\.key, currentValue\)/);
      assert.match(pageHtml, /assistantReflectBtn[\s\S]*?buildAssistantReflection\(step\.key, currentValue\)/);
      assert.match(pageHtml, /assistantRewriteBtn[\s\S]*?rewriteAssistantAnswerForStep\(step\.key, assistantAnswer\?\.value \?\? ""\)/);
      assert.match(pageHtml, /prepareForNewTaskDraft\(\);/);
      assert.match(pageHtml, /loadAssistantFromRequestInput\(\{ silent: true \}\);/);
      assert.match(pageHtml, /invokeAction\(\s*"quick-start-safe"/);
      assert.match(pageHtml, /startProgressRefresh\(\)/);
      assert.match(pageHtml, /stopProgressRefresh\(\)/);
      assert.match(pageHtml, /const displayedOverview = deriveDisplayedOverview\(overviewPayload\.overview\);/);
      assert.match(pageHtml, /function renderStatus\(overview\) \{[\s\S]*?latestOverview = overview;[\s\S]*?renderResultCard\(overview\);/);
      assert.match(pageHtml, /renderHumanStatusCard\(overview\);/);
      assert.match(pageHtml, /showToast\("info", "正在分析需求"/);
      assert.match(pageHtml, /showToast\("info", "已送出執行"/);
      assert.match(pageHtml, /setTransientProgress\("GPT 正在思考"/);
      assert.match(pageHtml, /setTransientProgress\("系統正在執行"/);
      assert.match(pageHtml, /scheduleAutoResume\(displayedOverview\)/);
      assert.match(pageHtml, /syncLiveStatusRefresh\(displayedOverview\)/);
      assert.match(pageHtml, /maybeNotifyOverviewChange\(overview\)/);
      assert.match(pageHtml, /refreshStatus\(\)\.catch/);

      const primaryActions = pageHtml.match(/id="primaryActions"[\s\S]*?<button /g);
      assert.ok(primaryActions);
      const primarySection = pageHtml.match(/<div class="actions primary-actions" id="primaryActions">([\s\S]*?)<\/div>/);
      assert.ok(primarySection);
      const primaryButtonCount = (primarySection[1].match(/<button /g) ?? []).length;
      assert.ok(primaryButtonCount <= 4);
    } finally {
      await panel.close();
    }
  });

  await runTest("panel status API exposes active task progress for the latest run", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-progress-"));
    const runDirectory = path.join(workspaceRoot, "runs", "progress-run");
    const runStatePath = path.join(runDirectory, "run-state.json");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      runStatePath,
      `${JSON.stringify(
        {
          version: 1,
          runId: "progress-run",
          projectName: "Progress test",
          workspacePath: workspaceRoot,
          createdAt: "2026-04-22T05:00:00.000Z",
          updatedAt: "2026-04-22T05:01:00.000Z",
          status: "in_progress",
          taskLedger: [
            {
              id: "planning-brief",
              phaseId: "planning",
              role: "planner",
              owner: "GPT Runner",
              title: "Clarify the brief and execution sequence",
              status: "completed",
              dependsOn: [],
              notes: ["2026-04-22T05:00:30.000Z dispatch:completed"]
            },
            {
              id: "implement-feature",
              phaseId: "implementation",
              role: "executor",
              owner: "Codex",
              title: "Implement the requested summary output",
              status: "in_progress",
              dependsOn: ["planning-brief"],
              notes: ["2026-04-22T05:01:00.000Z dispatch:claimed 123"]
            },
            {
              id: "review-feature",
              phaseId: "review",
              role: "reviewer",
              owner: "Independent reviewer",
              title: "Review the requested summary output",
              status: "pending",
              dependsOn: ["implement-feature"]
            }
          ],
          nextActions: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const panel = await startPanelServer({
      workspaceDir: workspaceRoot,
      port: 0
    });

    try {
      const status = await getJson(`${panel.url}/api/status`);
      assert.equal(status.overview.latestRun?.summary?.runId, "progress-run");
      assert.equal(status.overview.latestRun?.activity?.currentTask?.id, "implement-feature");
      assert.equal(status.overview.latestRun?.activity?.currentTask?.role, "executor");
      assert.equal(status.overview.latestRun?.activity?.nextTask?.id, "review-feature");
      assert.equal(status.overview.latestRun?.activity?.lastCompletedTask?.id, "planning-brief");
      assert.match(status.overview.latestRun?.activity?.currentTask?.latestNote ?? "", /dispatch:claimed 123/);
    } finally {
      await panel.close();
    }
  });

  await runTest("panel status API exposes human readiness summary from validation results", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-human-readiness-"));
    const reportsDirectory = path.join(workspaceRoot, "reports");
    await mkdir(reportsDirectory, { recursive: true });
    await writeFile(
      path.join(reportsDirectory, "validation-results.json"),
      `${JSON.stringify(
        {
          profile: "repo",
          readyForHuman: false,
          blockedBy: [
            'Validation ran with the "repo" profile only. Run `npm run selfcheck:release-ready` before human handoff or "可實戰" claims.'
          ],
          criticalGates: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const panel = await startPanelServer({
      workspaceDir: workspaceRoot,
      port: 0
    });

    try {
      const status = await getJson(`${panel.url}/api/status`);
      const validationSummary = status.overview.validationSummary;
      const humanReadiness = status.overview.humanReadiness;

      assert.equal(validationSummary?.profile, "repo");
      assert.equal(validationSummary?.readyForHuman, false);
      assert.equal(humanReadiness?.readyForHuman, false);
      assert.equal(humanReadiness?.state, "not-validated");
      assert.match(humanReadiness?.title ?? "", /尚未完成 release-ready 驗證/);
      assert.match((humanReadiness?.blockers ?? []).join("\n"), /repo 級驗證.*release-ready/);
      assert.match(humanReadiness?.recommendedAction ?? "", /npm run selfcheck:release-ready/);
    } finally {
      await panel.close();
    }
  });

  await runTest("panel status API exposes latestRun.quickStartResultCard when evidence exists", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-result-card-"));
    const inputPath = path.join(workspaceRoot, "data", "rick.json");
    const outputPath = path.join(workspaceRoot, "artifacts", "generated", "rick-summary.md");
    const runDirectory = path.join(workspaceRoot, "runs", "result-card-run");
    const runStatePath = path.join(runDirectory, "run-state.json");
    const evidencePath = path.join(runDirectory, "quick-start-run-evidence.json");
    const inputContent = JSON.stringify(
      [
        { month: "2026-01", profit: 1200, win: true },
        { month: "2026-02", profit: -300, win: false }
      ],
      null,
      2
    );
    const outputContent = [
      "# rick summary",
      "整體勝率：50%",
      "每月獲利：2026-01 = 1200；2026-02 = -300",
      "每一筆資料都已列出"
    ].join("\n");

    await mkdir(path.dirname(inputPath), { recursive: true });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await mkdir(runDirectory, { recursive: true });
    await writeFile(inputPath, inputContent, "utf8");
    await writeFile(outputPath, outputContent, "utf8");

    const inputStats = await stat(inputPath);
    const inputSha256 = createHash("sha256").update(inputContent, "utf8").digest("hex");

    await writeFile(
      runStatePath,
      `${JSON.stringify(
        {
          version: 1,
          runId: "result-card-run",
          projectName: "Result card test",
          workspacePath: workspaceRoot,
          createdAt: "2026-04-22T06:00:00.000Z",
          updatedAt: "2026-04-22T06:05:00.000Z",
          status: "completed",
          taskLedger: [],
          nextActions: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          requestedNoInputModification: true,
          requestedInputLabels: ["rick.json"],
          outputPath,
          inputFiles: [
            {
              path: inputPath,
              exists: true,
              sha256: inputSha256,
              size: inputStats.size,
              modifiedAt: inputStats.mtime.toISOString()
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const panel = await startPanelServer({
      workspaceDir: workspaceRoot,
      port: 0
    });

    try {
      const status = await getJson(`${panel.url}/api/status`);
      const resultCard = status.overview.latestRun?.quickStartResultCard;

      assert.equal(status.overview.latestRun?.summary?.runId, "result-card-run");
      assert.equal(resultCard?.requestedNoInputModification, true);
      assert.equal(resultCard?.didModifyInputFiles, false);
      assert.deepEqual(resultCard?.modifiedInputFiles, []);
      assert.equal(resultCard?.inputFiles?.[0]?.workspacePath, "data/rick.json");
      assert.equal(resultCard?.outputFile?.workspacePath, "artifacts/generated/rick-summary.md");
      assert.ok(Array.isArray(resultCard?.outputFile?.highlights));
      assert.equal(resultCard?.outputFile?.highlights?.includes("整體勝率：50%"), true);
      assert.equal(resultCard?.outputFile?.highlights?.includes("每一筆資料都已列出"), true);
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
      assert.match(pageHtml, /scheduleAutoResume\(displayedOverview\)/);
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
