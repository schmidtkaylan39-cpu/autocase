import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dispatchHandoffs } from "../src/lib/dispatch.mjs";
import { ensureDirectory, writeJson } from "../src/lib/fs-utils.mjs";
import { buildHandoffDescriptor, getLauncherMetadata } from "../src/lib/handoffs.mjs";
import { normalizeRuntimeChecks, pickRuntimeForRole, resolveRuntimePreferences } from "../src/lib/runtime-registry.mjs";

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
  doctorReport,
  runState = {},
  platform = process.platform
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
      mandatoryGates: ["build", "lint", "typecheck", "unit test", "integration test", "e2e test"],
      ...runState
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
    doctorReport,
    platform
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
      "gpt-runner": { ok: true },
      cursor: { ok: true },
      codex: { ok: true },
      "local-ci": { ok: true },
      manual: { ok: true }
    };

    const defaultOrchestratorSelection = pickRuntimeForRole("orchestrator", allReady);
    assert.equal(defaultOrchestratorSelection.runtimeId, "gpt-runner");
    assert.match(defaultOrchestratorSelection.reason, /is ready for this role/i);
    assert.equal(pickRuntimeForRole("planner", allReady).runtimeId, "gpt-runner");
    assert.equal(pickRuntimeForRole("reviewer", allReady).runtimeId, "gpt-runner");
    assert.equal(pickRuntimeForRole("executor", allReady).runtimeId, "codex");
    assert.equal(pickRuntimeForRole("verifier", allReady).runtimeId, "local-ci");

    const orchestratorOverride = {
      roleOverrides: {
        orchestrator: ["openclaw", "manual"]
      }
    };
    const overrideOrchestratorSelection = pickRuntimeForRole("orchestrator", allReady, orchestratorOverride);
    assert.equal(overrideOrchestratorSelection.runtimeId, "openclaw");
    assert.match(overrideOrchestratorSelection.reason, /explicitly enabled/i);

    const plannerChecks = {
      openclaw: { ok: true },
      "gpt-runner": { ok: false },
      cursor: { ok: false },
      codex: { ok: true },
      "local-ci": { ok: true },
      manual: { ok: true }
    };
    const plannerSelection = pickRuntimeForRole("planner", plannerChecks);

    assert.equal(plannerSelection.runtimeId, "manual");
    assert.equal(plannerSelection.status, "fallback");
    assert.match(plannerSelection.reason, /falls back to manual handling/i);
  });

  await runTest("runtime routing can explicitly opt planner and reviewer roles into cursor", async () => {
    const runtimeRouting = {
      roleOverrides: {
        planner: ["cursor", "manual"],
        reviewer: ["cursor", "manual", "codex"]
      }
    };

    assert.deepEqual(resolveRuntimePreferences("planner", runtimeRouting), {
      preferences: ["cursor", "manual"],
      source: "override"
    });
    assert.deepEqual(resolveRuntimePreferences("reviewer", runtimeRouting), {
      preferences: ["cursor", "manual"],
      source: "override"
    });

    const allReady = {
      cursor: { ok: true },
      manual: { ok: true }
    };
    const plannerSelection = pickRuntimeForRole("planner", allReady, runtimeRouting);

    assert.equal(plannerSelection.runtimeId, "cursor");
    assert.equal(plannerSelection.status, "ready");
    assert.match(plannerSelection.reason, /explicitly enabled/i);
  });

  await runTest("buildHandoffDescriptor uses gpt-runner as the default planner surface when available", async () => {
    const descriptorFixture = {
      role: "planner",
      taskId: "planning-brief",
      doctorReport: {
        checks: [
          {
            id: "gpt-runner",
            installed: true,
            ok: true,
            source: "C:/tools/codex.cmd"
          }
        ]
      }
    };
    const windowsDescriptor = createDescriptorFixture({
      ...descriptorFixture,
      platform: "win32"
    });
    const linuxDescriptor = createDescriptorFixture({
      ...descriptorFixture,
      platform: "linux"
    });

    for (const descriptor of [windowsDescriptor, linuxDescriptor]) {
      assert.equal(descriptor.runtime.id, "gpt-runner");
      assert.equal(descriptor.runtime.mode, "automated");
      assert.equal(descriptor.runtime.selectionStatus, "ready");
      assert.equal(descriptor.model.preferredModel, "gpt-5.4");
      assert.equal(descriptor.model.selectionMode, "default");
      assert.match(descriptor.runtime.selectionReason, /GPT Runner is ready/i);
      assert.equal(descriptor.paths.workspacePath, "C:/workspace/demo");
      assert.ok(descriptor.promptText.includes("- workspaceRoot: C:/workspace/demo"));
      assert.ok(descriptor.promptText.includes("# Workspace Root Path\nC:/workspace/demo"));
    }

    assert.equal(windowsDescriptor.launcher.language, "powershell");
    assert.match(
      windowsDescriptor.launcherScript,
      /\$prompt \| & codex -m 'gpt-5\.4' -a never exec -C \. -s workspace-write -/i
    );

    assert.equal(linuxDescriptor.launcher.language, "bash");
    assert.match(
      linuxDescriptor.launcherScript,
      /printf "%s" "\$prompt" \| codex -m 'gpt-5\.4' -a never exec -C \. -s workspace-write -/i
    );
  });

  await runTest("manual planner or reviewer surfaces are skipped by dispatch execute when explicitly forced", async () => {
    const descriptor = createDescriptorFixture({
      role: "reviewer",
      runState: {
        runtimeRouting: {
          roleOverrides: {
            reviewer: ["manual"]
          }
        }
      },
      taskId: "review-spec-intake",
      doctorReport: {
        checks: [
          {
            id: "gpt-runner",
            installed: true,
            ok: true,
            source: "C:/tools/codex.cmd"
          }
        ]
      }
    });

    assert.equal(descriptor.runtime.id, "manual");
    assert.equal(descriptor.runtime.mode, "manual");
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
          handoffId: descriptor.handoffId,
          launcherPath: path.join(handoffDir, `${descriptor.taskId}.launch${getLauncherMetadata().extension}`),
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

  await runTest("cursor runtime becomes intentionally reachable through runtimeRouting overrides", async () => {
    const descriptor = createDescriptorFixture({
      role: "planner",
      taskId: "planning-brief",
      runState: {
        runtimeRouting: {
          roleOverrides: {
            planner: ["cursor", "manual"]
          }
        }
      },
      doctorReport: {
        checks: [
          {
            id: "gpt-runner",
            installed: true,
            ok: true,
            source: "C:/tools/codex.cmd"
          },
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
    assert.match(descriptor.runtime.selectionReason, /explicitly enabled/i);
    assert.match(descriptor.launcherScript, /\bcursor -n\b/i);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-runtime-cursor-override-"));
    const handoffDir = path.join(tempDir, "handoffs");
    const indexPath = path.join(handoffDir, "index.json");

    await ensureDirectory(handoffDir);
    await writeJson(indexPath, {
      generatedAt: new Date().toISOString(),
      runId: "runtime-cursor-override-run",
      readyTaskCount: 1,
      descriptors: [
        {
          taskId: descriptor.taskId,
          runtime: descriptor.runtime,
          handoffId: descriptor.handoffId,
          launcherPath: path.join(handoffDir, `${descriptor.taskId}.launch${getLauncherMetadata().extension}`),
          resultPath: path.join(handoffDir, "results", `${descriptor.taskId}.result.json`)
        }
      ]
    });

    const dryRunResult = await dispatchHandoffs(indexPath, "dry-run");
    const executeResult = await dispatchHandoffs(indexPath, "execute");

    assert.equal(dryRunResult.results[0].status, "would_skip");
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
            id: "gpt-runner",
            installed: true,
            ok: true
          }
        ]
      }
    });

    assert.equal(descriptor.runtime.id, "gpt-runner");
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
    assert.match(descriptor.launcherScript, /Preferred model: /);

    if (process.platform === "win32") {
      assert.equal(descriptor.launcher.language, "powershell");
      assert.match(descriptor.launcherScript, /Set-Location -LiteralPath 'C:\/workspace\/\$demo & path'/);
      assert.match(
        descriptor.launcherScript,
        /Get-Content -Raw -LiteralPath 'C:\/handoffs\/prompt ''\$demo'' & work\.md'/
      );
      assert.match(descriptor.launcherScript, /\$prompt \| & codex -a never exec -C \. -s workspace-write -/);
    } else {
      assert.equal(descriptor.launcher.language, "bash");
      assert.match(descriptor.launcherScript, /cd 'C:\/workspace\/\$demo & path'/);
      assert.match(
        descriptor.launcherScript,
        /prompt=\$\(cat 'C:\/handoffs\/prompt '"'"'\$demo'"'"' & work\.md'\)/
      );
      assert.match(descriptor.launcherScript, /printf "%s" "\$prompt" \| codex -a never exec -C \. -s workspace-write -/);
    }
  });

  await runTest("launcher metadata matches the requested platform", async () => {
    assert.deepEqual(getLauncherMetadata("win32"), {
      extension: ".ps1",
      language: "powershell"
    });
    assert.deepEqual(getLauncherMetadata("linux"), {
      extension: ".sh",
      language: "bash"
    });
  });

  await runTest("routing docs stay aligned with automated gpt-runner planner and reviewer selection", async () => {
    const handoffsDoc = await readFile(new URL("../docs/handoffs.md", import.meta.url), "utf8");
    const architectureDoc = await readFile(new URL("../docs/architecture.md", import.meta.url), "utf8");

    assert.match(handoffsDoc, /- `planner`: `gpt-runner`, then `manual`/);
    assert.match(handoffsDoc, /- `reviewer`: `gpt-runner`, then `manual`/);
    assert.match(handoffsDoc, /- `orchestrator`: `gpt-runner`, then `manual`/);
    assert.match(handoffsDoc, /Codex CLI using the preferred GPT model/i);
    assert.match(handoffsDoc, /Cursor remains available as an auxiliary human IDE or spot-check surface/i);
    assert.match(handoffsDoc, /runtimeRouting\.roleOverrides/);

    assert.match(architectureDoc, /- planner: `gpt-runner`, then `manual`/);
    assert.match(architectureDoc, /- reviewer: `gpt-runner`, then `manual`/);
    assert.match(architectureDoc, /- orchestrator: `gpt-runner`, then `manual`/);
    assert.match(architectureDoc, /GPT runner drives default autonomous orchestration, planning, and review loops/i);
    assert.match(architectureDoc, /Cursor remains an auxiliary human IDE \/ spot-check surface/i);
    assert.match(architectureDoc, /runtimeRouting\.roleOverrides/);
  });

  console.log("All runtime-registry tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
