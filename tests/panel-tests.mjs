import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
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

  console.log("Panel tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
