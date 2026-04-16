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

  await runTest("planner escalates on hyphen-delimited mixed-language dispatch tasks", async () => {
    const selection = selectModelForTask(
      {
        id: "planning-brief",
        role: "planner",
        title: "dispatch-安全审查",
        description: "Review dispatch safety in a mixed-language brief.",
        acceptanceCriteria: [],
        attempts: 0,
        retryCount: 0
      },
      {
        status: "planned"
      }
    );

    assert.equal(selection.preferredModel, "gpt-5.4-pro");
    assert.equal(selection.escalated, true);
    assert.ok(selection.triggers.some((trigger) => /dispatch/i.test(trigger)));
  });

  await runTest("planner does not escalate on mixed-script words without a real separator", async () => {
    const mixedScriptSelection = selectModelForTask(
      {
        id: "planning-brief",
        role: "planner",
        title: "αdispatchβ",
        description: "Greek letters wrap the pattern, so it is not a standalone token.",
        acceptanceCriteria: [],
        attempts: 0,
        retryCount: 0
      },
      {
        status: "planned"
      }
    );

    const adjacentCjkSelection = selectModelForTask(
      {
        id: "planning-brief",
        role: "planner",
        title: "dispatch安全审查",
        description: "CJK text is directly adjacent, so there is no token boundary.",
        acceptanceCriteria: [],
        attempts: 0,
        retryCount: 0
      },
      {
        status: "planned"
      }
    );

    assert.equal(mixedScriptSelection.preferredModel, "gpt-5.4");
    assert.equal(mixedScriptSelection.escalated, false);
    assert.equal(adjacentCjkSelection.preferredModel, "gpt-5.4");
    assert.equal(adjacentCjkSelection.escalated, false);
  });

  console.log("Model policy tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
