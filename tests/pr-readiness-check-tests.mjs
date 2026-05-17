import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  parseChangedFiles,
  parseMarkdownSections,
  parseNumstat,
  summarizeDiffFacts,
  validatePullRequestBody
} from "../scripts/check-pr-readiness.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function completePullRequestBody() {
  return `## Summary

- Adds a focused AI workflow readiness gate.

## Issue / Objective

- Closes: #123
- Task mode: M
- Task state: review-ready
- Objective: Prevent unclear AI tasks from reaching merge.
- Acceptance checks:
  - [x] PR body includes objective, validation, and handoff evidence.

## AI Execution Notes

- Agent/runtime used: Codex local
- Model/effort used: Codex executor \`codex\`, high; Web GPT \`gpt-5.5\`, high
- Fallback model used: No fallback model used
- Files intentionally changed: GitHub workflow and readiness checker
- Files intentionally not touched: Runtime behavior and release artifacts
- Stop rules or constraints honored: no secrets, no unrelated runtime edits

## Validation

- [x] npm run validate:workflows
- [x] npm test

## Validation Evidence

- Commands run: npm run validate:workflows; node tests/pr-readiness-check-tests.mjs
- Result: passed
- Skipped checks and reason: full release-ready skipped; not release-impacting

## Release Evidence

- [ ] reports/release-burnin-summary.json attached or summarized
- [ ] reports/runtime-doctor.json attached or summarized when relevant
- [ ] example smoke outcome summarized
- [x] Not release-impacting

## Risk / Handoff

- Cross-platform impact: none expected
- External warnings or non-blocking follow-ups: No external warnings.
- Next conversation should know: PR readiness check enforces non-empty evidence fields
`;
}

function bodyWithTaskMode(mode) {
  return completePullRequestBody().replace("- Task mode: M", `- Task mode: ${mode}`);
}

async function main() {
  await runTest("parses second-level markdown sections", async () => {
    const sections = parseMarkdownSections(completePullRequestBody());

    assert.equal(sections.has("summary"), true);
    assert.equal(sections.has("issue / objective"), true);
    assert.match(sections.get("validation evidence") ?? "", /Commands run/);
  });

  await runTest("accepts a complete PR body", async () => {
    const result = validatePullRequestBody(completePullRequestBody());

    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  await runTest("PR template includes readiness fields", async () => {
    const template = await readFile(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");

    assert.match(template, /- Task mode: S \/ M \/ L/);
    assert.match(template, /- Task state: review-ready/);
    assert.match(template, /- Model\/effort used:/);
    assert.match(template, /- Fallback model used:/);
    assert.match(template, /## Validation Evidence/);
    assert.match(template, /## Risk \/ Handoff/);
  });

  await runTest("accepts the filled PR readiness example", async () => {
    const body = await readFile(new URL("../templates/examples/pr-readiness-filled-body.example.md", import.meta.url), "utf8");
    const result = validatePullRequestBody(body, {
      diffFacts: summarizeDiffFacts({
        changedFiles: ["docs/ai-collaboration-workflow.md"],
        numstat: [
          {
            path: "docs/ai-collaboration-workflow.md",
            added: 8,
            deleted: 0
          }
        ]
      })
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  await runTest("accepts M mode for small non-risk diffs with release evidence boilerplate", async () => {
    const nonRiskBody = completePullRequestBody()
      .replace("Adds a focused AI workflow readiness gate.", "Adds a focused AI task readiness note.")
      .replace("Prevent unclear AI tasks from reaching merge.", "Clarify the AI task readiness note.")
      .replace("no secrets, no unrelated runtime edits", "no secrets, no unrelated cleanup");
    const result = validatePullRequestBody(nonRiskBody, {
      diffFacts: summarizeDiffFacts({
        changedFiles: ["docs/ai-collaboration-workflow.md", "templates/one-line-task.template.md"],
        numstat: [
          {
            path: "docs/ai-collaboration-workflow.md",
            added: 20,
            deleted: 0
          },
          {
            path: "templates/one-line-task.template.md",
            added: 10,
            deleted: 0
          }
        ]
      })
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  await runTest("rejects an empty PR body", async () => {
    const result = validatePullRequestBody("");

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /empty/i);
  });

  await runTest("rejects missing objective evidence", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- Objective: Prevent unclear AI tasks from reaching merge.", "- Objective:")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Objective.*filled/i);
  });

  await runTest("rejects missing task mode", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- Task mode: M\n", "")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /missing.*Task mode/i);
  });

  await runTest("rejects invalid task mode", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- Task mode: M", "- Task mode: medium")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Task mode.*S, M, or L/i);
  });

  await runTest("rejects missing task state", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- Task state: review-ready\n", "")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /missing.*Task state/i);
  });

  await runTest("rejects invalid task state", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- Task state: review-ready", "- Task state: almost done")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Task state.*one of/i);
  });

  await runTest("rejects non-review-ready task state for ready PR", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- Task state: review-ready", "- Task state: ready")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /ready pull requests.*review-ready/i);
  });

  await runTest("rejects task state placeholder list", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- Task state: review-ready", "- Task state: draft / candidate-ready / ready / in-progress / blocked / validation-failed / review-ready / complete")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Task state.*one of/i);
  });

  await runTest("rejects missing model effort", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- Model/effort used: Codex executor `codex`, high; Web GPT `gpt-5.5`, high\n", "")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /missing.*Model\/effort used/i);
  });

  await runTest("rejects vague model effort", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- Model/effort used: Codex executor `codex`, high; Web GPT `gpt-5.5`, high", "- Model/effort used: AI helped")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /model\/runtime and effort/i);
  });

  await runTest("rejects unchecked acceptance evidence", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- [x] PR body includes objective", "- [ ] PR body includes objective")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Acceptance checks/i);
  });

  await runTest("rejects missing release-impact decision", async () => {
    const result = validatePullRequestBody(
      completePullRequestBody().replace("- [x] Not release-impacting", "- [ ] Not release-impacting")
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Release Evidence/i);
  });

  await runTest("parses changed files and numstat diff facts", async () => {
    const facts = summarizeDiffFacts({
      changedFiles: parseChangedFiles("docs/a.md\nscripts/check-pr-readiness.mjs\n"),
      numstat: parseNumstat("10\t2\tdocs/a.md\n-\t-\tassets/binary.png\n")
    });

    assert.deepEqual(facts.files, ["assets/binary.png", "docs/a.md", "scripts/check-pr-readiness.mjs"]);
    assert.equal(facts.fileCount, 3);
    assert.equal(facts.diffLines, 12);
  });

  await runTest("rejects S mode when diff changes too many files", async () => {
    const result = validatePullRequestBody(bodyWithTaskMode("S"), {
      diffFacts: summarizeDiffFacts({
        changedFiles: ["docs/a.md", "docs/b.md", "docs/c.md"],
        numstat: []
      })
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Task mode S.*2 changed files/i);
  });

  await runTest("rejects M mode when diff exceeds candidate size", async () => {
    const result = validatePullRequestBody(bodyWithTaskMode("M"), {
      diffFacts: summarizeDiffFacts({
        changedFiles: ["scripts/a.mjs", "tests/a-tests.mjs"],
        numstat: [
          {
            path: "scripts/a.mjs",
            added: 301,
            deleted: 0
          }
        ]
      })
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Task mode M.*300 changed lines/i);
  });

  await runTest("rejects non-L mode for high-risk paths", async () => {
    const result = validatePullRequestBody(bodyWithTaskMode("M"), {
      diffFacts: summarizeDiffFacts({
        changedFiles: [".github/workflows/pr-readiness.yml"],
        numstat: []
      })
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Task mode M.*high-risk path/i);
  });

  await runTest("accepts L mode for high-risk or large diffs", async () => {
    const result = validatePullRequestBody(bodyWithTaskMode("L"), {
      diffFacts: summarizeDiffFacts({
        changedFiles: [".github/workflows/pr-readiness.yml", "src/lib/panel.mjs", "scripts/a.mjs", "tests/a-tests.mjs"],
        numstat: [
          {
            path: "src/lib/panel.mjs",
            added: 500,
            deleted: 0
          }
        ]
      })
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  console.log("PR readiness check tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
