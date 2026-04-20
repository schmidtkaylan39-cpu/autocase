# AI Factory Starter Agent Map

This file is the short working map for agents operating in this repository.
Read it before making broad changes.

## Startup Loop

1. Read the task brief, this file, and any file paths explicitly mentioned by the task.
2. Inspect the real workspace before planning or editing.
3. Read the exact files you expect to modify before changing them.
4. Define completion in terms of runnable verification, not intuition.
5. Prefer small, auditable changes with explicit evidence.

## Environment Rules

- Assume the real source of truth is the local workspace, not your prior memory.
- Do not invent missing files. If a file is named, open it.
- If a task mentions tests or scripts, run the closest relevant verification before declaring success.
- Preserve existing user changes unless the task explicitly asks to overwrite them.
- Default to full agent autonomy: do not ask the human to take action unless execution is blocked by a capability, permission, or environment limit the agent cannot resolve directly.
- If blocked, immediately escalate to GPT-5.4 for support; only ask the human after that escalation path is exhausted.

## Role Contracts

### Planner

Produce a concise proposal contract before broad work when the task is ambiguous, risky, or spans multiple files.

Proposal contract sections:

- objective
- assumptions
- likely touched files
- acceptance checks
- major risks or blockers

### Reviewer

Prefer concrete findings over summaries.
Challenge weak acceptance criteria, missing verification, and unsafe assumptions.
Leave behind a structured findings artifact when the round is review-heavy.

### Executor

Read the current files first, then implement.
If the task is non-trivial, restate the execution contract in a few lines before wide edits.
Do not claim full-project completion from a local subtask.
Prefer emitting patch notes and a Codex-ready execution prompt for the next loop when that would reduce ambiguity.

### Verifier

Use objective evidence: build, lint, typecheck, test, integration, e2e, or other task-specific checks.
If a gate was not run, say so explicitly.
Capture validation results in a structured form when the round is intended for handoff or release review.

## Round Outputs

For significant rounds, prefer leaving behind the same core artifacts:

- `findings`
- `patch-notes`
- `codex-prompt`
- `review-bundle`
- `validation-results`

Treat these as the common handoff layer between GPT-5.4 planning/review work,
Codex implementation work, and human/operator acceptance.

## Failure Feedback

When work fails or stalls, prefer structured reasons over emotional language.

Use one of these categories when possible:

- `rate_limit`
- `timeout`
- `missing_dependency`
- `environment_mismatch`
- `artifact_invalid`
- `verification_failed`
- `logic_bug`
- `unknown`

For each failure, capture:

- what failed
- the most likely category
- the smallest relevant evidence
- the next best recovery step

## Memory Hygiene

- Keep run notes concise and non-duplicative.
- Summarize repeated failures instead of appending the same long story.
- Prefer pointers to source files over dumping large file contents into notes.

## Repository-Specific Priorities

- Preserve dispatch/run-state correctness.
- Keep runtime routing and model routing explicit.
- Treat `result`, `retry`, `tick`, `handoff`, and `dispatch` as high-risk surfaces.
- Keep Windows/Linux behavior aligned unless a platform difference is explicitly intended.

## Workflow Spine

Prefer reasoning in this order:

1. `intake`
2. `analyze`
3. `patch`
4. `validate`
5. `review`
6. `bundle`
7. `accept` / `retry` / `block`
