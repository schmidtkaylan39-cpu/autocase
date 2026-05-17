# Implement GitHub Issue Task

You are implementing a concrete repository task from a GitHub issue or PR.

Read first:

- `AGENTS.md`
- `CONTRIBUTING.md`
- `.github/pull_request_template.md`
- the linked issue body and every file path named by the issue
- any `One-Line Task` packet linked by the prompt
- any `Web-to-Codex Candidate` packet linked by the issue or prompt

## Operating rules

1. Treat local files, git state, and generated artifacts as the source of truth.
2. Check `git status --short --branch` before editing.
3. Read the exact files you expect to modify before changing them.
4. Keep the patch tightly scoped to the issue objective and acceptance checks.
5. Preserve unrelated dirty worktree changes.
6. Do not write secrets, tokens, cookies, credentials, or full account IDs into artifacts, logs, comments, issues, or PRs.
7. Do not claim `ready for human` unless the repository release-ready authority explicitly proves it.

## Readiness gate

Before editing, confirm the task has:

- one clear objective
- named source-of-truth files, docs, artifacts, or logs
- explicit allowed and out-of-scope areas
- observable acceptance checks
- validation commands or evidence
- stop rules

If the task fails this gate, do not implement. Return the missing fields and a smaller suggested task shape.

## Task size mode

Classify the task before implementation:

- S: small low-risk docs, copy, comments, or tiny config work; max 2 files.
- M: standard feature, bug, test, template, or checker work; max 3 files or 300 diff lines.
- L: runtime, release, security, secrets, trading, migration, destructive,
  public API/schema, workflow behavior, or anything above M limits.

S-mode may use a `One-Line Task` packet with only: task, done when, do not
touch, and validation. Stop and upgrade when S-mode touches forbidden risk
areas, exceeds two files, or needs broader validation. When uncertain, choose
the next heavier mode.

## Task state and model effort

Before editing, declare:

- Task mode: S, M, or L.
- Task state: `draft`, `candidate-ready`, `ready`, `in-progress`, `blocked`,
  `validation-failed`, `review-ready`, or `complete`.
- Model/effort plan: the runtime/model and effort level expected for drafting,
  execution, review, and validation.

Default model/effort policy:

- S-mode: Web GPT is optional and usually skipped. Use Codex executor `codex`
  with medium (`中`) effort unless the repo context is unclear.
- Web GPT candidate drafting metadata may prefer `gpt-5.5` with high (`高`)
  effort, falling back to `gpt-5.4` if unavailable. Codex decides whether the
  pasted-back packet is valid S, M, or L work. For M-mode execution, Codex runs
  locally with medium/high (`中`/`高`) effort.
- L-mode: planning/review should target `gpt-5.5` with xhigh (`超高`) effort,
  falling back to `gpt-5.4` if unavailable. Codex executes locally with
  high/xhigh (`高`/`超高`) effort and explicit stop rules.

Use high effort for code, tests, checker logic, integration, or any failed
validation follow-up. Use xhigh for high-risk work: runtime, release, security,
secrets, trading, migration, destructive actions, public API/schema changes,
architecture, root-cause debugging, or repeated failures.

In the final report and PR body, state the actual model/runtime and effort used.
If the preferred model was not available, record the fallback plainly.

## Question policy

- Inspect the repo before asking questions.
- Ask at most three batched questions before implementation.
- Ask only for high-risk, irreversible, contradictory, scope-changing, external-account, credential, cost, public API, schema, or user-flow decisions.
- Do not ask about discoverable repo facts, existing file locations, local patterns, naming details, or test commands.
- For low-risk, reversible choices that match existing repo patterns, choose the conservative default and report it under assumptions.
- Once implementation starts, do not resume step-by-step questioning unless a stop rule is hit.

## Output compression

- Keep exploratory status updates short, usually one or two sentences.
- Use file paths, artifact names, commands, and validation results instead of pasted file dumps or long logs.
- Final reports must keep the required sections, but avoid long explanations when the evidence is clear.
- Handoffs may be terse, but must preserve goal, completed work, next step, key paths, validation run, skipped checks, and remaining risk.
- `caveman-review` style is acceptable for review findings: location, problem, fix.
- `caveman-commit` style is acceptable for commit messages: terse Conventional Commits format.
- Do not over-compress requirements, acceptance checks, stop rules, security warnings, release decisions, secrets handling, trading operations, destructive actions, migrations, or public API/schema changes.
- Do not run `caveman-compress` on repository files unless the task explicitly asks to compress a dedicated memory or prose document and the original is backed up.

## Web-to-Codex candidates

If the task includes a Web GPT candidate patch, code block, or design:

- Treat it as a candidate, not source of truth.
- Treat any pasted-back `Codex task mode` as an instruction to verify, not as
  proof that the mode is correct.
- Verify every touched path against local repo state before editing.
- Reuse candidate code only when it fits existing repo patterns and acceptance checks.
- Rewrite or discard candidate code when local context proves a better path.
- Stop and request a split when the candidate exceeds 3 files or 300 diff lines.
- Report which candidate assumptions were accepted, changed, or rejected.

## Implementation loop

1. Restate the objective, allowed scope, acceptance checks, and stop rules.
2. Inspect the code/docs/artifacts named in the issue.
3. Make the smallest auditable change.
4. Run the smallest validation command set that proves the change.
5. Run broader validation only when the touched surface justifies it.
6. Update docs or templates only when they are part of the requested outcome.

## Validation command map

- Workflow validation: `npm run validate:workflows`
- Build: `npm run build`
- Package smoke: `npm run pack:check`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Integration: `npm run test:integration`
- E2E: `npm run test:e2e`
- Release-ready authority: `npm run selfcheck:release-ready`

## Stop instead of guessing

Stop and report a blocker when:

- the issue objective conflicts with `AGENTS.md`
- required files or artifacts are missing
- validation requires unavailable credentials or external account access
- the fix requires touching an explicitly forbidden area
- the worktree contains related changes you cannot safely distinguish from your own

## Final report

Use these sections:

## summary

## changed files

## validation

## skipped checks

## risks and next steps

## handoff
