# AI Collaboration Workflow

## Purpose

This workflow turns Codex plus GitHub into a repeatable engineering loop:
clear task intake, isolated branches, objective validation, reviewable PRs, and
handoffs that survive a lost chat session.

## Source Of Truth

Use this order when facts conflict:

1. Local git state and repository files.
2. Generated JSON/JSONL artifacts and validation reports.
3. Markdown handoffs, runbooks, and PR descriptions.
4. Chat history.

Chat is useful for coordination, but it is not the execution ledger.

## Standard Loop

1. Classify the task as S, M, or L mode.
2. Use the lightest allowed intake for that mode.
3. Create a branch, preferably `codex/<short-task-name>` for Codex-owned implementation work.
4. Ask Codex to read `AGENTS.md`, the task packet, and all named files before editing.
5. Keep the change small enough to review in one PR.
6. Run the smallest relevant validation first, then broaden when the touched surface is shared or risky.
7. Open a PR with the repository PR template filled out when the change is intended to merge.
8. Let CI be the merge gate and release-readiness be the promotion gate.
9. Leave handoff notes that include changed files, validation, skipped checks, and remaining risk.

## Definition Gates

Every task uses a lightweight Definition of Ready before implementation:

- one clear outcome
- named source-of-truth files or artifacts
- explicit in-scope and out-of-scope areas
- observable acceptance checks
- named validation evidence
- clear stop rules

Every PR uses a Definition of Done before review:

- only intended files changed
- acceptance checks complete
- validation evidence listed
- skipped checks explained
- release impact selected
- handoff notes included

The `PR Readiness` workflow checks the PR body for these proof fields. Draft PRs
are allowed to skip the check; ready PRs should fill the template instead of
leaving placeholders.

## Task Size Modes

Use the lightest mode that is safe. If uncertain, choose the next heavier mode.

| Mode | Use For | Intake | Validation |
| --- | --- | --- | --- |
| S: Small fix | docs, copy, comments, tiny low-risk config; max 2 files | `templates/one-line-task.template.md`; no Web GPT needed | smallest relevant check, usually `git diff --check` |
| M: Standard task | normal feature, bug, test, template, or checker work; max 3 files or 300 diff lines | AI task issue or Web-to-Codex candidate packet | focused validation plus PR readiness |
| L: Large or high-risk | runtime, release, security, secrets, trading, migration, destructive, public API/schema, or anything above M limits | full AI task issue with Ready/Done gates | broad validation, CI, and release-ready gate when claimed |

S-mode must stop and upgrade when it touches forbidden risk areas, exceeds two
files, or cannot prove completion with a simple validation step. M-mode must
split before implementation when a Web GPT candidate exceeds three files or 300
diff lines. L-mode keeps explicit human-readable requirements and risk notes;
do not optimize it primarily for token savings.

`PR Readiness` validates the declared task mode against the PR diff:

- S fails when more than 2 files, more than 80 changed lines, or high-risk paths
  or wording appear.
- M fails when more than 3 files, more than 300 changed lines, or high-risk
  paths or wording appear.
- L is required for runtime, release, security, secrets, trading, migration,
  destructive, public API/schema, workflow behavior, or oversized changes.

Use the examples under `templates/examples/` when starting from a blank task:

- `s-mode-one-line-task.example.md`
- `m-mode-web-to-codex-candidate.example.md`
- `l-mode-ai-task.example.md`

## Task State And Model Effort

Every task packet and review-ready PR should declare three things before work is
treated as ready: task mode, task state, and model/effort plan. This keeps Web
GPT token-heavy drafting and Codex local execution explicit instead of relying
on chat memory.

Allowed task states:

- `draft`: missing objective, scope, acceptance, validation, or stop rules.
- `candidate-ready`: Web GPT produced a candidate packet for Codex to verify.
- `ready`: task passes the Definition of Ready and Codex may implement.
- `in-progress`: Codex is editing files or running validation.
- `blocked`: external access, credentials, human approval, or a stop rule is
  required.
- `validation-failed`: a patch exists, but required checks failed.
- `review-ready`: validation evidence exists and the PR body is complete.
- `complete`: accepted or merged, with handoff complete.

Use this default model/effort matrix:

| Codex Mode | Candidate Drafting Hint | Codex / Local Execution | Planner / Reviewer |
| --- | --- | --- | --- |
| S | optional; skip by default | `codex`, medium (`中`) | none unless unclear |
| M | `gpt-5.5`, high (`高`); fallback `gpt-5.4` | `codex`, medium/high (`中`/`高`) | `gpt-5.5`, high when design or review is useful |
| L | `gpt-5.5`, xhigh (`超高`) for design/risk plan; fallback `gpt-5.4` | `codex`, high/xhigh (`高`/`超高`) | `gpt-5.5`, xhigh; fallback `gpt-5.4` |

Effort escalation rule:

- Use medium for clear S-mode docs/templates or tiny reversible changes.
- Use high for normal code, tests, checker logic, integration work, or after a
  failed validation attempt.
- Use xhigh for L-mode work, architecture decisions, root-cause debugging,
  release/security/secrets/trading/destructive/public API/schema changes, or
  repeated failures.

The PR body must state the actual model/runtime and effort used. If a requested
model is unavailable in the current account or surface, record the fallback
instead of pretending the preferred model ran.

Ready PRs should use task state `review-ready` after validation evidence exists.
Draft PRs may stay `draft`, `candidate-ready`, `ready`, `in-progress`,
`blocked`, or `validation-failed` while the PR readiness workflow is skipped.

## Token-Saving Output Policy

Use the local `caveman` skill family as an output compression layer, not as a
decision layer. Human clarity stays above token savings.

- Requirements, specifications, acceptance checks, stop rules, risk warnings,
  security notes, release decisions, secrets handling, trading operations, and
  irreversible actions must stay normal and explicit.
- Status updates should be short, usually one or two sentences, and should name
  what changed, what was learned, or what is next.
- Review comments may use `caveman-review`: one actionable finding per line with
  location, problem, and fix.
- Commit messages may use `caveman-commit`: terse Conventional Commits format
  without AI attribution.
- Handoffs may be compressed, but must preserve goal, completed work, next step,
  key paths, validation results, skipped checks, and remaining risk.
- Use `caveman-compress` only for dedicated memory or prose documents after
  preserving a backup and reviewing the diff. Do not compress important
  engineering specifications, approval artifacts, JSON truth files, code, or
  logs.

## Web-to-Codex Candidate Flow

Use Web GPT as a fast candidate drafter when it saves time or tokens. Do not
treat Web GPT output as local execution truth.

Web GPT does not own S/M/L classification. It drafts the candidate. The packet
pasted back to Codex may include Codex execution instructions such as `Codex
task mode: M`, but Codex must verify, downgrade, upgrade, split, or reject that
mode against local repo state and PR readiness rules.

Recommended handoff:

1. Paste `templates/web-gpt-candidate-prompt.template.md` into Web GPT.
2. Web GPT fills `templates/web-to-codex-candidate.template.md`.
3. Codex reads the candidate plus repo truth.
4. Codex applies, rewrites, or rejects the candidate based on local files.
5. Codex runs validation and reports changed files, skipped checks,
   assumptions, and residual risk.

Candidate size limit:

- max 3 files
- max 300 diff lines
- no long logs, screenshots, or full-file dumps unless the file is new and small
- larger candidates must be split into smaller tasks before implementation

Good Web GPT output is a focused candidate patch with assumptions and validation
commands. Bad Web GPT output is a large code dump that expects Codex to discover
the objective after the fact.

## Issue Quality Bar

A high-quality AI task issue answers:

- What should be true when this is complete?
- Which files, docs, artifacts, or logs are authoritative?
- Which areas are allowed or forbidden?
- What commands prove the change?
- What should stop the agent from guessing?
- What should the next conversation know if context is lost?

## PR Quality Bar

A PR is review-ready when:

- the summary names the user-visible or operator-visible effect
- acceptance checks are mapped to evidence
- intended files are separated from files intentionally left untouched
- validation commands and results are listed
- skipped checks have reasons
- handoff notes are enough for another agent or reviewer to resume

Do not use panel smoke, artifact presence, or a passing subset as release-ready
authority unless the documented release-ready gate produced a current successful
result for the baseline under review.

## Validation Ladder

Use the smallest rung that proves the change, then climb only when needed:

- Docs/templates only: `git diff --check`, `npm run validate:workflows` when `.github/workflows` changed.
- Workflow changes: `npm run validate:workflows`.
- Shared source changes: `npm run build`, `npm run lint`, `npm run typecheck`, `npm test`.
- CLI/runtime behavior: add focused tests, then run `npm test` and the relevant smoke command.
- Release or human-ready claims: `npm run selfcheck:release-ready` must be the authority.

## Codex Prompt Pattern

Use `.github/codex/prompts/implement-task.md` for issue implementation work.
Use `.github/codex/prompts/fix-ci.md` only for failed CI repair.

The prompt should always force:

- repo-state inspection before edits
- exact file reads before edits
- a readiness gate before implementation
- concise status updates without compressing requirements or risks
- at most three batched high-impact questions
- conservative defaults for low-risk reversible choices
- minimal scoped patches
- objective validation evidence
- explicit skipped checks and residual risk
- a handoff note

## GitHub Automation Map

- `.github/workflows/ci.yml` runs quality and example smoke checks on push and PR.
- `.github/workflows/pr-readiness.yml` checks that ready PRs contain objective, validation, release-impact, and handoff evidence.
- `.github/workflows/codex-autofix.yml` attempts a Codex PR after failed CI on non-Codex branches.
- `.github/workflows/release-readiness.yml` runs deeper promotion evidence on dispatch or schedule.
- `.github/pull_request_template.md` keeps PR evidence consistent.
- `.github/ISSUE_TEMPLATE/ai_task.yml` converts vague requests into executable tasks.
- `templates/one-line-task.template.md` keeps S-mode tasks light without losing
  done criteria, forbidden scope, or validation.
- `templates/web-gpt-candidate-prompt.template.md` gives Web GPT a copy-ready
  prompt that outputs candidate packets instead of prose or oversized patches.
- `templates/web-to-codex-candidate.template.md` keeps Web GPT drafts small,
  explicit, and locally verifiable.
- `templates/examples/` gives copy-ready S, M, and L examples.

## Safety Rules

- Never commit secrets, tokens, cookies, credentials, or full account IDs.
- Never reset, clean, checkout, or overwrite unrelated user changes without explicit approval.
- Never claim full project completion from a narrow local patch.
- Never turn draft debug notes into execution truth.
- Never let chat memory override local artifacts.

## Definition Of A 100-Point AI Round

An AI-assisted round is excellent when:

- the task used the lightest safe S/M/L mode
- the task started from a clear issue or execution contract
- the branch contains only related changes
- validation evidence exists and matches the touched surface
- PR readiness passes without placeholders
- routine updates and handoffs are concise without losing proof
- Web GPT candidates stay within size limits or get split before local work
- CI can independently judge the PR
- handoff notes let a fresh conversation continue without restored chat history
- risks and skipped checks are visible instead of hidden
