# Handoffs

## Purpose

`handoff` turns every `ready` task in a run into a runtime-ready package.

The implementation lives in:

- `src/lib/commands.mjs`
- `src/lib/handoffs.mjs`
- `src/lib/runtime-registry.mjs`

## Source data

`createRunHandoffs()` reads:

- `run-state.json`
- `execution-plan.json`
- `spec.snapshot.json`
- `reports/runtime-doctor.json` when it exists

If no doctor report is available, runtime checks fall back to "not installed" for automated tools, except `manual`, which is always considered available.

## Which tasks get a handoff

Only tasks with status `ready` are included.

`handoff` does not:

- change task status
- unlock new tasks
- write back to `run-state.json`

It only creates artifacts for tasks that are already ready.

## Runtime selection

Runtime selection is based on:

- the task role
- normalized doctor results
- the preference order in `src/lib/runtime-registry.mjs`

Current preference order:

- `orchestrator`: `openclaw`, then `manual`
- `planner`: `cursor`, then `manual`
- `reviewer`: `cursor`, then `manual`
- `executor`: `codex`, then `manual`
- `verifier`: `local-ci`, then `manual`

The first runtime with `ok: true` is selected.

If no automated runtime is ready, the task falls back to `manual`.

## Files generated per ready task

For each ready task, `handoff` writes:

- `<taskId>.prompt.md`
- `<taskId>.handoff.json`
- `<taskId>.handoff.md`
- `<taskId>.launch.ps1`

It also reserves a result path under:

- `handoffs/results/<taskId>.result.json`

And it writes an aggregate index:

- `handoffs/index.json`

## Prompt document contents

Each generated prompt includes:

- the role prompt template
- run and project context
- execution rules
- the exact required result artifact path
- the required JSON shape:
  - `status`
  - `summary`
  - `changedFiles`
  - `verification`
  - `notes`
- the task brief path

## Launcher behavior by runtime

### `openclaw`

The launcher reads the generated prompt and runs:

```powershell
openclaw agent --local --json --thinking medium --message $message
```

### `cursor`

The launcher opens Cursor with the workspace, brief, and prompt paths.

This is currently treated as a hybrid surface for planning or review, not a fully automated worker.

After Cursor finishes and writes the required `result.json`, apply it back into the run with:

```bash
node src/index.mjs result runs/example-run/run-state.json <taskId> runs/example-run/handoffs/results/<taskId>.result.json
```

If Cursor hits a transient failure such as rate limiting, timeout, or a server-side error, do not mark the task complete.
Schedule a timed retry instead:

```bash
node src/index.mjs retry runs/example-run/run-state.json <taskId> "请求频率过高，请稍后重试" 3
```

Timed retries move the task to `waiting_retry`; the next `report` or `handoff` refresh will return it to `ready` once the retry time has elapsed.

### `codex`

The launcher changes into the workspace, reads the prompt, and pipes it into:

```powershell
codex -a never exec -C . -s workspace-write -
```

### `local-ci`

The launcher changes into the workspace and maps `mandatoryGates` to known npm commands:

- `build` -> `npm run build`
- `lint` -> `npm run lint`
- `typecheck` -> `npm run typecheck`
- `unit test` -> `npm test`
- `integration test` -> `npm run test:integration`
- `e2e test` -> `npm run test:e2e`

If no gate maps to a command, it falls back to:

```powershell
npm test
```

### `manual`

The launcher only prints the prompt and brief locations for manual handling.

Manual handlers should still write the same result artifact contract and apply it with the `result` command above.

## Descriptor contents

Each handoff descriptor records:

- task identity
- selected runtime
- selection status and reason
- alternative runtimes and their doctor status
- task summary and acceptance criteria
- prompt, brief, and result paths
- the generated launcher script text

## Example

```bash
node src/index.mjs handoff runs/example-run/run-state.json
```
