# L-Mode Example: High-Risk Runtime Change

Use the GitHub `AI implementation task` issue template for this mode.

## Objective

- Change runtime behavior only after defining exact safety boundaries and validation evidence.

## Task Mode

- L

## Task State

- ready

## Model / Effort

- Planner/reviewer: `gpt-5.5`, xhigh (`超高`); fallback `gpt-5.4`.
- Codex executor: `codex`, high/xhigh (`高`/`超高`).
- Verifier: `local-ci`, task-specific broad validation.

## Context And Source Of Truth

- `AGENTS.md`
- relevant `src/` runtime files
- relevant `tests/` coverage
- current validation artifacts under `reports/` or `logs/`

## Scope

Allowed:
- named runtime files only
- focused tests for the changed behavior

Out of scope:
- secrets, credentials, cookies, full account IDs
- release promotion claims
- unrelated panel, docs, or preflight cleanup

## Acceptance Checks

- [ ] Behavior change is covered by focused tests.
- [ ] Existing runtime contracts still pass.
- [ ] Validation evidence is listed in the PR.
- [ ] Human-readable risk and rollback notes are included.

## Expected Validation Commands

- `npm run build`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- task-specific smoke or release-ready command when claimed

## Stop Rules

- Stop if secrets or credentials are needed.
- Stop if the change crosses into a forbidden module.
- Stop if validation requires unavailable external access.
- Stop if the task cannot prove completion with local evidence.
