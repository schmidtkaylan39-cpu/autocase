# Codex Handoff Package

## Current Goal

Set up a stronger Codex plus GitHub operating loop so AI-assisted work starts
from structured issues, lands in reviewable PRs, runs objective validation, and
leaves enough handoff context for a fresh conversation. The latest round upgraded
this from a templates-only baseline toward a 95-point workflow with readiness
gates, autonomy defaults, PR body enforcement, and Caveman-based output
compression rules. The latest small follow-up added the Web-to-Codex candidate
template, Web GPT prompt template, size limit, S/M/L task modes, PR task-mode
enforcement, S/M/L examples, diff-based mode validation, and explicit task
state plus model/effort declarations for Web GPT and Codex.

## Workspace / Repo State

- cwd: `C:\Users\Administrator\.codex\worktrees\b628\New project`
- branch: `codex/signalproof-mvp`
- HEAD: `f5af478ff2b68723dee69ca93923474ae301a7fa`
- dirty files from this round:
  - `.github/ISSUE_TEMPLATE/config.yml`
  - `.github/ISSUE_TEMPLATE/ai_task.yml`
  - `.github/ISSUE_TEMPLATE/bug_report.yml`
  - `.github/codex/prompts/implement-task.md`
  - `.github/workflows/pr-readiness.yml`
  - `.github/pull_request_template.md`
  - `CONTRIBUTING.md`
  - `docs/ai-collaboration-workflow.md`
  - `docs/CODEX_HANDOFF_20260517_AI_WORKFLOW.md`
  - `docs/model-routing.md`
  - `package.json`
  - `scripts/check-pr-readiness.mjs`
  - `tests/pr-readiness-check-tests.mjs`
  - `templates/one-line-task.template.md`
  - `templates/web-gpt-candidate-prompt.template.md`
  - `templates/web-to-codex-candidate.template.md`
  - `templates/examples/s-mode-one-line-task.example.md`
  - `templates/examples/m-mode-web-to-codex-candidate.example.md`
  - `templates/examples/l-mode-ai-task.example.md`
- note: the worktree already contained many unrelated dirty and untracked
  runtime, docs, logs, scripts, tests, exports, and prompt files before this
  round. They were not modified for this AI workflow setup.

## Completed

- Added GitHub issue forms for AI implementation tasks and bug reports.
- Disabled blank issues so new work starts from structured intake.
- Added a Codex issue-implementation prompt under `.github/codex/prompts/`.
- Expanded the PR template with issue/objective, AI execution notes,
  validation evidence, skipped checks, release impact, and handoff fields.
- Added `docs/ai-collaboration-workflow.md` as the operator-facing workflow.
- Linked the new workflow from `CONTRIBUTING.md`.
- Added Definition of Ready and Definition of Done fields to the AI task issue
  template.
- Added autonomy defaults: inspect first, ask at most three high-impact batched
  questions, and use conservative repo-native defaults for low-risk reversible
  choices.
- Added a PR readiness checker and `check:pr-readiness` npm script.
- Added `.github/workflows/pr-readiness.yml` to enforce objective, acceptance,
  validation, release-impact, and handoff evidence on ready PRs.
- Added focused tests for the PR readiness checker.
- Added Caveman token-saving policy: compress routine status, review, commit,
  and handoff output while keeping requirements, acceptance, risks, security,
  release, secrets, trading, and irreversible actions explicit.
- Added Web-to-Codex candidate flow and template so Web GPT can draft focused
  candidate patches while Codex remains the local integration and validation
  authority.
- Added copy-ready Web GPT prompt template to reduce repeated prompt writing and
  force Web GPT output into the candidate packet format.
- Added S/M/L task modes and a One-Line Task template so tiny low-risk work can
  stay light while standard and high-risk work keep stronger gates.
- Added PR readiness enforcement for `Task mode: S / M / L`.
- Added diff-based task-mode validation so S/M PRs fail when changed file count,
  changed line count, high-risk paths, or high-risk wording require a heavier
  mode.
- Added copy-ready S, M, and L examples under `templates/examples/`.
- Added explicit task-state and model/effort policy:
  - task packets declare mode, state, and model/effort plan.
  - Web GPT candidate drafting prefers `gpt-5.5` and falls back to `gpt-5.4`.
  - Codex remains the local executor and verifier-facing integration surface.
  - medium/high/xhigh effort maps to small, standard, and high-risk work.
- Updated PR readiness enforcement so ready PRs must use `Task state:
  review-ready` or `complete`, must name the actual model/runtime and effort
  used, and must state whether a fallback model was used.
- Updated `docs/model-routing.md` so the orchestrator table matches the
  configured default `gpt-5.5` route and documents task-level effort labels.
- Cleaned the Web GPT copy/paste templates to use ASCII-only effort labels
  (`medium`, `high`, `xhigh`) so PowerShell display encoding cannot corrupt
  the text copied into Web GPT.
- Clarified the Web-to-Codex split: Web GPT does not decide or own M-mode. It
  only drafts a candidate. The pasted-back packet now has `Web GPT Draft
  Metadata` plus `Codex Execution Instructions`; Codex verifies the suggested
  task mode locally and may downgrade, upgrade, split, or reject it.
- Simplified required human-facing defaults:
  - PR template now defaults `Task state` to `review-ready`.
  - PR template includes usable `Model/effort used` and `Fallback model used`
    examples instead of blank fields.
  - Web GPT prompt now forbids prefaces, summaries, checklist recaps, apologies,
    and extra commentary outside the candidate packet.

## Verification Run

- `git diff --check -- .github/ISSUE_TEMPLATE .github/codex/prompts/implement-task.md .github/pull_request_template.md docs/ai-collaboration-workflow.md CONTRIBUTING.md`
  - result: passed
- `npm run validate:workflows`
  - result: passed; validated `ci.yml`, `codex-autofix.yml`, `pr-readiness.yml`,
    and `release-readiness.yml`; rerun passed after diff-based S/M/L classifier
    workflow update
- Node/YAML parse check for `.github/ISSUE_TEMPLATE/*.yml`
  - result: passed for `ai_task.yml`, `bug_report.yml`, and `config.yml`
- `node tests/pr-readiness-check-tests.mjs`
  - result: passed after diff-based S/M/L classifier update
- `npx eslint scripts/check-pr-readiness.mjs tests/pr-readiness-check-tests.mjs`
  - result: passed after diff-based S/M/L classifier update
- `node tests/pr-readiness-check-tests.mjs`
  - result: passed after task-state and model/effort readiness enforcement
    update
- `npx eslint scripts/check-pr-readiness.mjs tests/pr-readiness-check-tests.mjs`
  - result: passed after task-state and model/effort readiness enforcement
    update
- `npm run validate:workflows`
  - result: passed after task-state and model/effort documentation/checker
    update; validated `ci.yml`, `codex-autofix.yml`, `pr-readiness.yml`, and
    `release-readiness.yml`
- Node/YAML parse check for `.github/ISSUE_TEMPLATE/*.yml`
  - result: passed after adding task mode, initial task state, and model/effort
    plan fields to `ai_task.yml`
- `rg -n "[^\x00-\x7F]" templates/web-gpt-candidate-prompt.template.md templates/web-to-codex-candidate.template.md`
  - result: no matches after ASCII-only Web GPT template cleanup
- `git diff --no-index --check` against an empty temp file for
  `templates/web-gpt-candidate-prompt.template.md` and
  `templates/web-to-codex-candidate.template.md`
  - result: passed after ASCII-only Web GPT template cleanup
- `rg` check for stale Web GPT/M-mode wording in the Web GPT templates, workflow
  doc, and Codex implementation prompt
  - result: no stale `M-mode candidate drafting` or `Task Mode` sections remain
    in the Web GPT templates; only `Codex task mode` remains in the pasted-back
    Codex instruction section
- `git diff --no-index --check` against an empty temp file for
  `templates/web-gpt-candidate-prompt.template.md`,
  `templates/web-to-codex-candidate.template.md`,
  `docs/ai-collaboration-workflow.md`, and
  `.github/codex/prompts/implement-task.md`
  - result: passed after clarifying that only Codex owns task mode
- `git diff --no-index --check` against an empty temp file for
  `.github/pull_request_template.md`,
  `templates/web-gpt-candidate-prompt.template.md`, and
  `docs/CODEX_HANDOFF_20260517_AI_WORKFLOW.md`
  - result: passed after simplifying required PR defaults and tightening Web
    GPT no-extra-commentary rules
- `npm run check:pr-readiness` with `PR_DRAFT=true`
  - result: passed; draft PRs skip enforcement
- `npm test`
  - result: failed in existing `tests/panel-tests.mjs` expectation for panel
    HTML text (`Start: Local workspace contains sales.json...`); focused
    readiness tests had already passed. The worktree already had unrelated
    dirty panel/runtime files before this round.
- `npm run lint`
  - result: failed on pre-existing unrelated lint issues, including
    `scripts/verify-summary.mjs`, `tests/panel-one-click-smoke-tests.mjs`, and
    untracked `tmp/caveman/**`. Targeted lint for the new checker/test passed.
- `git diff --check -- docs/ai-collaboration-workflow.md .github/codex/prompts/implement-task.md docs/CODEX_HANDOFF_20260517_AI_WORKFLOW.md`
  - result: passed, but plain `git diff --check` does not cover untracked files
    until they are staged or marked intent-to-add
- `git diff --no-index --check` against an empty temp file for
  `docs/ai-collaboration-workflow.md`,
  `.github/codex/prompts/implement-task.md`, and
  `docs/CODEX_HANDOFF_20260517_AI_WORKFLOW.md`
  - result: passed for the Caveman subplan update
- `git diff --no-index --check` against an empty temp file for
  `templates/one-line-task.template.md`,
  `templates/examples/s-mode-one-line-task.example.md`,
  `templates/examples/m-mode-web-to-codex-candidate.example.md`,
  `templates/examples/l-mode-ai-task.example.md`,
  `templates/web-gpt-candidate-prompt.template.md`,
  `templates/web-to-codex-candidate.template.md`,
  `.github/pull_request_template.md`,
  `.github/ISSUE_TEMPLATE/ai_task.yml`,
  `docs/model-routing.md`,
  `scripts/check-pr-readiness.mjs`,
  `tests/pr-readiness-check-tests.mjs`,
  `docs/ai-collaboration-workflow.md`,
  `.github/codex/prompts/implement-task.md`, and
  `docs/CODEX_HANDOFF_20260517_AI_WORKFLOW.md`
  - result: passed after task-state and model/effort enforcement update

## Remaining / Next Steps

- Review the templates in GitHub after push to confirm labels and issue forms
  render as expected.
- Optionally create repository labels: `ai-task` and `bug`.
- Protect `main` with the existing CI checks plus `PR Body Readiness` when the
  workflow is pushed and confirmed in GitHub.
- Resolve unrelated existing panel/lint failures before treating the whole repo
  as globally green.

## Key Files And Artifacts

- `.github/ISSUE_TEMPLATE/ai_task.yml`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/codex/prompts/implement-task.md`
- `.github/workflows/pr-readiness.yml`
- `.github/pull_request_template.md`
- `docs/ai-collaboration-workflow.md`
- `CONTRIBUTING.md`
- `scripts/check-pr-readiness.mjs`
- `tests/pr-readiness-check-tests.mjs`
- `package.json`
- `templates/one-line-task.template.md`
- `templates/web-gpt-candidate-prompt.template.md`
- `templates/web-to-codex-candidate.template.md`
- `templates/examples/s-mode-one-line-task.example.md`
- `templates/examples/m-mode-web-to-codex-candidate.example.md`
- `templates/examples/l-mode-ai-task.example.md`
- `docs/model-routing.md`

## Risks / Do Not Do

- Do not reset, checkout, clean, or overwrite user changes without explicit
  request.
- Do not expose secrets, tokens, cookies, session credentials, or full account
  IDs.
- Do not assume the old conversation can be restored.
- Use local files, git state, validation artifacts, and generated reports as
  the source of truth.

## Starter Prompt For Next Conversation

Read `AGENTS.md` and `docs/CODEX_HANDOFF_20260517_AI_WORKFLOW.md` first. Confirm
the current git state, review the listed workflow files, and continue from the
next steps. Do not rely on restoring the old conversation.
