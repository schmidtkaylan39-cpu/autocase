# S-Mode Example: Small Docs Fix

## Task

- Fix the typo in `docs/ai-collaboration-workflow.md` under the Web-to-Codex section.

## Task State

- ready

## Model / Effort

- Codex executor: `codex`, medium (`中`).
- Web GPT: not used.

## Done When

- The typo is corrected and no unrelated text changes are made.

## Do Not Touch

- `src/`
- `tests/`
- `.github/workflows/`

## Validation

- `git diff --check -- docs/ai-collaboration-workflow.md`

## S-Mode Guard

- Max 2 files.
- No runtime, release, security, secrets, trading, migration, destructive,
  public API, schema, or workflow behavior changes.
- If the task grows, stop and upgrade to M or L mode.
