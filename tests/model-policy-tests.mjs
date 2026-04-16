import assert from "node:assert/strict";

import { selectModelForTask } from "../src/lib/model-policy.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  await runTest("planner defaults to gpt-5.4 without escalation signals", async () => {
    const selection = selectModelForTask(
      {
        id: "planning-brief",
        role: "planner",
        title: "Clarify the brief",
        description: "Break requirements into work items.",
        acceptanceCriteria: ["must be clear"],
        attempts: 0,
        retryCount: 0
      },
      {
        status: "planned"
      }
    );

    assert.equal(selection.preferredModel, "gpt-5.4");
    assert.equal(selection.escalated, false);
    assert.equal(selection.selectionMode, "default");
  });

  await runTest("planner escalates to gpt-5.4-pro after repeated retries", async () => {
    const selection = selectModelForTask(
      {
        id: "planning-brief",
        role: "planner",
        title: "Clarify the brief",
        description: "Break requirements into work items.",
        acceptanceCriteria: ["must be clear"],
        attempts: 1,
        retryCount: 2
      },
      {
        status: "in_progress"
      }
    );

    assert.equal(selection.preferredModel, "gpt-5.4-pro");
    assert.equal(selection.escalated, true);
    assert.match(selection.selectionReason, /retryCount/i);
  });

  await runTest("reviewer escalates to gpt-5.4-pro on attention-required runs", async () => {
    const selection = selectModelForTask(
      {
        id: "review-release-gates",
        role: "reviewer",
        title: "Review release gating and dispatch risk",
        description: "Inspect dispatch and release safety.",
        acceptanceCriteria: ["must be safe"],
        attempts: 0,
        retryCount: 0
      },
      {
        status: "attention_required"
      }
    );

    assert.equal(selection.preferredModel, "gpt-5.4-pro");
    assert.equal(selection.escalated, true);
    assert.ok(selection.triggers.some((trigger) => /attention_required/i.test(trigger)));
  });

  await runTest("executor remains on codex even when the run is attention-required", async () => {
    const selection = selectModelForTask(
      {
        id: "implement-dispatch-fix",
        role: "executor",
        title: "Implement dispatch fix",
        description: "Patch dispatch logic.",
        acceptanceCriteria: ["must pass"],
        attempts: 3,
        retryCount: 2,
        notes: ["dispatch:failed"]
      },
      {
        status: "attention_required"
      }
    );

    assert.equal(selection.preferredModel, "codex");
    assert.equal(selection.escalated, false);
    assert.equal(selection.autoSwitch, false);
  });

  console.log("Model policy tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
