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

Launcher scripts use `run-state.json.workspacePath`, which is captured when the run is created.
That keeps the workspace target stable even if later `handoff` or `tick` commands are invoked from a different shell location.

If no doctor report is available, runtime checks fall back to "not installed" for automated tools, except `manual`, which is always considered available.

## Which tasks get a handoff

`handoff` refreshes the run state first, rewrites `report.md`, and then includes every task whose effective status is `ready`.

That means `handoff` can:

- promote expired `waiting_retry` tasks back to `ready`
- write the refreshed ledger back into `run-state.json`
- regenerate `report.md` before writing handoff artifacts

## Runtime selection

Runtime selection is based on:

- the task role
- normalized doctor results
- the preference order in `src/lib/runtime-registry.mjs`

Current preference order:

- `orchestrator`: `openclaw`, then `manual`
- `planner`: `manual`
- `reviewer`: `manual`
- `executor`: `codex`, then `manual`
- `verifier`: `local-ci`, then `manual`

Automated roles select the first non-manual runtime with `ok: true`.
Planner/reviewer work is intentionally manual-only in the default routing table, so Cursor is not auto-selected even when it is available.

If you need an emergency human-side Cursor route, set `runtimeRouting.roleOverrides` in `config/factory.config.json`, for example:

```json
{
  "runtimeRouting": {
    "roleOverrides": {
      "planner": ["cursor", "manual"],
      "reviewer": ["cursor", "manual"]
    }
  }
}
```

If no automated runtime is ready, the task falls back to `manual`.

## Files generated per ready task

For each ready task, `handoff` writes:

- `<taskId>.prompt.md`
- `<taskId>.handoff.json`
- `<taskId>.handoff.md`
- `<taskId>.launch.ps1` on Windows or `<taskId>.launch.sh` on non-Windows

It also reserves a result path under:

- `handoffs/results/<taskId>.<handoffId>.result.json`

And it writes an aggregate index:

- `handoffs/index.json`

Role prompt templates are resolved from the installed package itself, not from the caller's current working directory. That keeps `handoff` and `tick` usable when the CLI is invoked from another folder.

## Prompt document contents

Each generated prompt includes:

- the role prompt template
- run and project context
- preferred model metadata and model-selection reason
- execution rules
- the exact required result artifact path
- the required JSON shape:
  - `runId`
  - `taskId`
  - `handoffId`
  - `status`
  - `summary`
  - `changedFiles`
  - `verification`
  - `notes`
- the workspace root path
- the task brief path

## Launcher behavior by runtime

### `openclaw`

The launcher reads the generated prompt and runs:

```powershell
openclaw agent --local --json --thinking medium --message $message
```

### `cursor`

Cursor remains available as an auxiliary human IDE or spot-check surface, but it is not auto-selected by the default planner/reviewer routing in this starter.

The remaining Cursor launcher path is intentionally live only through an explicit `runtimeRouting.roleOverrides` opt-in.

After an auxiliary surface finishes and writes the required `result.json`, apply it back into the run with:

```bash
node src/index.mjs result runs/example-run/run-state.json <taskId> runs/example-run/handoffs/results/<taskId>.<handoffId>.result.json
```

If a follow-up surface hits a transient failure such as rate limiting, timeout, or a server-side error, do not mark the task complete.
Schedule a timed retry instead:

```bash
node src/index.mjs retry runs/example-run/run-state.json <taskId> "request frequency too high, please retry later" 3
```

Timed retries move the task to `waiting_retry`; the next `tick`, `report`, or `handoff` refresh will return it to `ready` once the retry time has elapsed. If a hybrid surface exhausts its retry budget, the task can be parked in `blocked` with a cooldown and later reopened by the same refresh pass.

For orchestrator-style polling, prefer:

```bash
node src/index.mjs tick runs/example-run/run-state.json
```

That refreshes retry windows and rebuilds the handoff index in one step.

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

The launcher prints the workspace root along with the prompt and brief locations for manual handling.

Manual handlers should still write the same result artifact contract and apply it with the `result` command above.

## Descriptor contents

Each handoff descriptor records:

- run identity and a per-handoff `handoffId`
- task identity
- selected runtime
- selected model
- selection status and reason
- alternative runtimes and their doctor status
- task summary and acceptance criteria
- workspace, prompt, brief, and result paths
- the generated launcher script text

## Example

```bash
node src/index.mjs handoff runs/example-run/run-state.json
```
