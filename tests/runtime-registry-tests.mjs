import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dispatchHandoffs } from "../src/lib/dispatch.mjs";
import { ensureDirectory, writeJson } from "../src/lib/fs-utils.mjs";
import { buildHandoffDescriptor } from "../src/lib/handoffs.mjs";
import { normalizeRuntimeChecks, pickRuntimeForRole } from "../src/lib/runtime-registry.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function createDescriptorFixture({
  role,
  taskId,
  doctorReport
}) {
  const workspacePath = "C:/workspace/demo";
  const outputDir = "C:/workspace/demo/runs/example/handoffs";
  const promptPath = path.join(outputDir, `${taskId}.prompt.md`);
  const briefPath = path.join(outputDir, `${taskId}.brief.md`);
  const resultPath = path.join(outputDir, "results", `${taskId}.result.json`);

  return buildHandoffDescriptor({
    workspacePath,
    spec: {
      projectName: "Runtime Routing Demo",
      summary: "Validate runtime routing behavior."
    },
    runState: {
      runId: "routing-run",
      mandatoryGates: ["build", "lint", "typecheck", "unit test", "integration test", "e2e test"]
    },
    plan: {
      phases: [{ id: "implementation" }]
    },
    task: {
      id: taskId,
      role,
      title: `Task for ${role}`,
      description: `Execute ${role} work.`,
      dependsOn: [],
      acceptanceCriteria: ["must pass"]
    },
    rolePromptTemplate: "# role prompt",
    promptPath,
    briefPath,
    resultPath,
    doctorReport
  });
}

async function main() {
  await runTest("normalizeRuntimeChecks normalizes booleans, defaults, and manual runtime", async () => {
    const normalized = normalizeRuntimeChecks({
      checks: [
        {
          id: "cursor",
          installed: "yes",
          ok: 1,
          source: "/usr/local/bin/cursor"
        },
        {
          id: "local-ci",
          installed: 1,
          ok: 0,
          error: "missing test:e2e"
        },
        {
          id: "manual",
          installed: false,
          ok: false
        }
      ]
    });

    assert.equal(normalized.cursor.installed, true);
    assert.equal(normalized.cursor.ok, true);
    assert.equal(normalized.cursor.source, "/usr/local/bin/cursor");
    assert.equal(normalized.cursor.error, null);

    assert.equal(normalized["local-ci"].installed, true);
    assert.equal(normalized["local-ci"].ok, false);
    assert.equal(normalized["local-ci"].source, null);
    assert.equal(normalized["local-ci"].error, "missing test:e2e");

    assert.equal(normalized.openclaw.installed, false);
    assert.equal(normalized.openclaw.ok, false);
    assert.equal(normalized.openclaw.error, "No doctor result found.");

    assert.deepEqual(normalized.manual, {
      installed: true,
      ok: true
    });
  });

  await runTest("pickRuntimeForRole honors per-role preference order and does not cross-route roles", async () => {
    const allReady = {
      openclaw: { ok: true },
      cursor: { ok: true },
      codex: { ok: true },
      "local-ci": { ok: true },
      manual: { ok: true }
    };

    assert.equal(pickRuntimeForRole("orchestrator", allReady).runtimeId, "openclaw");
    assert.equal(pickRuntimeForRole("planner", allReady).runtimeId, "cursor");
    assert.equal(pickRuntimeForRole("reviewer", allReady).runtimeId, "cursor");
    assert.equal(pickRuntimeForRole("executor", allReady).runtimeId, "codex");
    assert.equal(pickRuntimeForRole("verifier", allReady).runtimeId, "local-ci");

    const plannerChecks = {
      openclaw: { ok: true },
      cursor: { ok: false },
      codex: { ok: true },
      "local-ci": { ok: true },
      manual: { ok: true }
    };
    const plannerSelection = pickRuntimeForRole("planner", plannerChecks);

    assert.equal(plannerSelection.runtimeId, "manual");
    assert.equal(plannerSelection.status, "fallback");
    assert.match(plannerSelection.reason, /(falls back|fallback)/i);
  });

  await runTest("buildHandoffDescriptor falls back to manual runtime when preferred runtime is not ready", async () => {
    const descriptor = createDescriptorFixture({
      role: "planner",
      taskId: "planning-brief",
      doctorReport: {
        checks: [
          {
            id: "cursor",
            installed: true,
            ok: false,
            error: "not authenticated"
          }
        ]
      }
    });

    assert.equal(descriptor.runtime.id, "manual");
    assert.equal(descriptor.runtime.mode, "manual");
    assert.equal(descriptor.runtime.selectionStatus, "fallback");
    assert.equal(descriptor.model.preferredModel, "gpt-5.4");
    assert.equal(descriptor.model.selectionMode, "default");
    assert.match(descriptor.runtime.selectionReason, /(falls back|fallback)/i);
    assert.match(descriptor.launcherScript, /Please handle this task manually/i);
  });

  await runTest("cursor hybrid surface is routed but skipped by dispatch execute", async () => {
    const descriptor = createDescriptorFixture({
      role: "reviewer",
      taskId: "review-spec-intake",
      doctorReport: {
        checks: [
          {
            id: "cursor",
            installed: true,
            ok: true,
            source: "C:/tools/cursor.exe"
          }
        ]
      }
    });

    assert.equal(descriptor.runtime.id, "cursor");
    assert.equal(descriptor.runtime.mode, "hybrid");
    assert.equal(descriptor.runtime.selectionStatus, "ready");
    assert.equal(descriptor.model.preferredModel, "gpt-5.4");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-runtime-routing-"));
    const handoffDir = path.join(tempDir, "handoffs");
    const indexPath = path.join(handoffDir, "index.json");

    await ensureDirectory(handoffDir);
    await writeJson(indexPath, {
      generatedAt: new Date().toISOString(),
      runId: "runtime-routing-run",
      readyTaskCount: 1,
      descriptors: [
        {
          taskId: descriptor.taskId,
          runtime: descriptor.runtime,
          launcherPath: path.join(handoffDir, `${descriptor.taskId}.launch.ps1`),
          resultPath: path.join(handoffDir, "results", `${descriptor.taskId}.result.json`)
        }
      ]
    });

    const dryRunResult = await dispatchHandoffs(indexPath, "dry-run");
    assert.equal(dryRunResult.results[0].status, "would_skip");

    const executeResult = await dispatchHandoffs(indexPath, "execute");
    assert.equal(executeResult.results[0].status, "skipped");
    assert.match(executeResult.results[0].note ?? "", /manual or hybrid/i);
  });

  await runTest("planner and reviewer descriptors escalate to gpt-5.4-pro when the run needs attention", async () => {
    const descriptor = buildHandoffDescriptor({
      workspacePath: "C:/workspace/demo",
      spec: {
        projectName: "Runtime Routing Demo",
        summary: "Validate runtime routing behavior."
      },
      runState: {
        runId: "routing-run",
        status: "attention_required",
        mandatoryGates: ["build", "lint"],
        modelPolicy: {
          planner: {
            defaultModel: "gpt-5.4",
            escalatedModel: "gpt-5.4-pro",
            autoSwitch: true
          }
        }
      },
      plan: {
        phases: [{ id: "planning" }]
      },
      task: {
        id: "planning-brief",
        role: "planner",
        title: "Review release risk",
        description: "Clarify the release gating and dispatch risk.",
        dependsOn: [],
        acceptanceCriteria: ["must be clear"],
        attempts: 0,
        retryCount: 0
      },
      rolePromptTemplate: "# role prompt",
      promptPath: "C:/handoffs/planning.prompt.md",
      briefPath: "C:/handoffs/planning.brief.md",
      resultPath: "C:/handoffs/results/planning.result.json",
      doctorReport: {
        checks: [
          {
            id: "cursor",
            installed: true,
            ok: true
          }
        ]
      }
    });

    assert.equal(descriptor.model.preferredModel, "gpt-5.4-pro");
    assert.equal(descriptor.model.selectionMode, "escalated");
    assert.match(descriptor.promptText, /preferredModel: gpt-5\.4-pro/);
  });

  await runTest("launcher scripts use literal paths and preserve special characters", async () => {
    const descriptor = buildHandoffDescriptor({
      workspacePath: "C:/workspace/$demo & path",
      spec: {
        projectName: "Runtime Routing Demo",
        summary: "Validate runtime routing behavior."
      },
      runState: {
        runId: "routing-run",
        mandatoryGates: ["build", "lint"]
      },
      plan: {
        phases: [{ id: "implementation" }]
      },
      task: {
        id: "implement-special",
        role: "executor",
        title: "Task with special paths",
        description: "Ensure launcher literals stay intact.",
        dependsOn: [],
        acceptanceCriteria: ["must preserve path literals"]
      },
      rolePromptTemplate: "# role prompt",
      promptPath: "C:/handoffs/prompt '$demo' & work.md",
      briefPath: "C:/handoffs/brief '$demo' & work.md",
      resultPath: "C:/handoffs/results/implement-special.result.json",
      doctorReport: {
        checks: [
          {
            id: "codex",
            installed: true,
            ok: true
          }
        ]
      }
    });

    assert.equal(descriptor.runtime.id, "codex");
    assert.equal(descriptor.model.preferredModel, "codex");
    assert.match(descriptor.launcherScript, /Set-Location -LiteralPath 'C:\/workspace\/\$demo & path'/);
    assert.match(descriptor.launcherScript, /Preferred model: /);
    assert.match(
      descriptor.launcherScript,
      /Get-Content -Raw -LiteralPath 'C:\/handoffs\/prompt ''\$demo'' & work\.md'/
    );
    assert.match(descriptor.launcherScript, /\$prompt \| & codex -a never exec -C \. -s workspace-write -/);
  });

  console.log("All runtime-registry tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
