# Dispatch

## Purpose

`dispatch` consumes a handoff index and decides whether each ready task should be:

- reported only in `dry-run` mode
- executed through its generated launcher in `execute` mode

The implementation lives in `src/lib/dispatch.mjs`.

## Inputs

`dispatchHandoffs(indexPath, mode)` reads:

- `handoffs/index.json`
- each descriptor's `launcherPath`
- each descriptor's optional `resultPath`

## Modes

### `dry-run`

No launcher is executed.

For each descriptor, the result is:

- `would_execute` if the runtime is auto-executable
- `would_skip` if the runtime is currently treated as manual or hybrid

### `execute`

Each descriptor is processed in order.

- If the runtime is not auto-executable, the task is marked `skipped`.
- If the runtime is auto-executable, the generated launcher is run with the platform shell runtime:
  - `.ps1` via `powershell.exe` on Windows
  - `.sh` via `bash` on Linux/macOS (or `AI_FACTORY_LAUNCHER_SHELL_COMMAND` when explicitly overridden)
- Before launch, any existing file at `resultPath` is removed so stale artifacts cannot be reused. If the task is already `in_progress` and a valid current-hand off artifact already exists, dispatch consumes that artifact instead of deleting it and rerunning the launcher.
- Before launch, `dispatch` claims the task as `in_progress` in the run-state when the expected run artifacts are available.

## Auto-executable runtimes

These runtimes are currently executed automatically:

- `openclaw`
- `gpt-runner`
- `local-ci`
- `codex`

These runtimes are currently not executed automatically:

- `cursor`
- `manual`

## Result statuses

In `execute` mode, a task can end up in one of these states:

- `completed`
  - the launcher exited successfully
  - and `resultPath` exists after execution
  - and the result artifact matches the expected schema and handoff identity
- `incomplete`
  - the launcher exited successfully
  - but no result artifact was written
  - or the result artifact was invalid
  - or the runtime reported a `blocked` artifact without an automation continuation decision
- `continued`
  - the launcher exited successfully
  - the result artifact was valid
  - the runtime reported a `blocked` artifact with a valid `automationDecision`
  - dispatch applied that decision back into the run-state, for example reopening implementation or scheduling a timed retry
- `failed`
  - the launcher threw an error or timed out
- `skipped`
  - the runtime is not auto-executable

In `dry-run` mode, the statuses are:

- `would_execute`
- `would_skip`

## Output files

`dispatch` writes two files next to the handoff index:

- `dispatch-results.json`
- `dispatch-results.md`

The JSON file contains:

- a summary block
- one result record per task
- a `runStateSync` block in `execute` mode when a sibling run directory contains `run-state.json`

The Markdown file is a readable report of the same data.

## Result artifact contract

When `resultPath` exists, `dispatch` parses and validates the JSON artifact.

The expected fields are:

- `runId`
  - must match the descriptor/run being executed
- `taskId`
  - must match the descriptor task
- `handoffId`
  - must match the specific handoff attempt
- `status`
  - one of `completed`, `failed`, or `blocked`
- `summary`
  - a string
- `changedFiles`
  - an array
- `verification`
  - an array
- `notes`
  - an array
- optional `automationDecision`
  - a machine-readable follow-up action used only with `status: "blocked"`
  - current actions are `retry_task`, `rework_feature`, and `replan_feature`

If the artifact shape is invalid, the dispatch result is `incomplete`.
If the artifact belongs to another run, task, or handoff, the dispatch result is also `incomplete`.

## Run-state sync behavior

In `execute` mode, `dispatch` looks for the parent run directory of the handoff folder.

If `run-state.json` exists there:

- `completed` dispatch results are written back as task status `completed`
- `failed` dispatch results are written back as task status `failed`
- `incomplete` dispatch results are written back as task status `blocked`
- `continued` dispatch results apply their `automationDecision` and may reopen tasks as `ready`, `pending`, or `waiting_retry`

If `execution-plan.json` also exists, `report.md` is regenerated from the updated run state.

## Important current behavior

`dispatch` still does not:

- inspect git diff, logs, or test quality beyond launcher success
- infer semantic quality from the changed files or verification notes
- auto-execute `cursor` or `manual` tasks

Its current job is narrower:

- run launchers when allowed
- validate result artifacts
- sync execution outcomes back into run artifacts when the expected run files exist
- write a dispatch report

## Example

```bash
node src/index.mjs dispatch runs/example-run/handoffs/index.json dry-run
node src/index.mjs dispatch runs/example-run/handoffs/index.json execute
```
