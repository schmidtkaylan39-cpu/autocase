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

### Executor

Read the current files first, then implement.
If the task is non-trivial, restate the execution contract in a few lines before wide edits.
Do not claim full-project completion from a local subtask.

### Verifier

Use objective evidence: build, lint, typecheck, test, integration, e2e, or other task-specific checks.
If a gate was not run, say so explicitly.

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
