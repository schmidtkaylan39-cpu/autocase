# Workspace Agent Map

This file is the short working map for agents operating in this workspace.
Read it before making broad changes.

## Startup Loop

1. Read the task brief, this file, and any file paths explicitly named by the task.
2. Inspect the actual workspace before planning or editing.
3. Open the files you intend to change before changing them.
4. Define completion with concrete verification.
5. Leave auditable evidence behind.

## Proposal Contract

For risky or multi-file tasks, write a concise proposal contract first:

- objective
- assumptions
- likely touched files
- acceptance checks
- major risks or blockers

## Round Outputs

For significant rounds, prefer leaving behind the same core artifacts:

- `findings`
- `patch-notes`
- `codex-prompt`
- `review-bundle`
- `validation-results`

## Execution Rules

- Do not invent missing files or behavior.
- Prefer reading the current implementation over guessing.
- If verification was requested, run it before claiming completion.
- If something fails, summarize the failure with a structured category and the next recovery step.
- Default to full agent autonomy: do not ask the human to take action unless execution is blocked by a capability, permission, or environment limit the agent cannot resolve directly.
- If blocked, immediately escalate to GPT-5.4 for support; only ask the human after that escalation path is exhausted.

## Workflow Spine

Prefer reasoning in this order:

1. `intake`
2. `analyze`
3. `patch`
4. `validate`
5. `review`
6. `bundle`
7. `accept` / `retry` / `block`

## Failure Feedback Categories

- `rate_limit`
- `timeout`
- `missing_dependency`
- `environment_mismatch`
- `artifact_invalid`
- `verification_failed`
- `logic_bug`
- `unknown`
