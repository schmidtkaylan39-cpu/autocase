# Architecture

This repository is a local CLI starter for a multi-runtime software factory workflow.
It creates plans, run state, handoff packages, dispatch reports, and can sync
dispatch execution outcomes back into the run ledger when the run artifacts are present.

## Current Command Flow

The CLI currently supports these stages:

1. `validate`
   Checks whether a project spec matches the expected schema.
2. `plan`
   Builds `execution-plan.json` and `execution-plan.md`.
3. `run`
   Creates a run directory, snapshots the spec, writes a plan, writes role metadata,
   writes `run-state.json`, writes `report.md`, and creates task briefs.
4. `task`
   Updates one task status in `run-state.json` and refreshes downstream task readiness.
5. `result`
   Validates a result artifact for a hybrid or manual task and applies it back into `run-state.json`.
6. `retry`
   Schedules a timed retry window for transient hybrid-surface failures such as Cursor rate limits or timeouts.
7. `tick`
   Refreshes the run state, releases expired retry windows back to `ready`, regenerates `report.md`, and rebuilds the current handoff index.
8. `doctor`
   Checks runtime readiness for OpenClaw, Cursor, Codex, and local CI.
9. `handoff`
   Creates prompt files, handoff descriptors, Markdown summaries, launcher scripts,
   and expected result artifact paths for every task that is currently `ready`.
10. `dispatch`
   Runs launcher scripts in `dry-run` or `execute` mode, validates result artifacts,
   writes dispatch reports, and syncs supported outcomes into `run-state.json`.

## Task Model

`run-state.json` is built from the project spec and execution plan. The task ledger
always follows the same pattern:

- `planning-brief`
  Starts as `ready`.
- `implement-<feature-id>`
  Starts as `pending` and depends on `planning-brief`.
- `review-<feature-id>`
  Starts as `pending` and depends on `implement-<feature-id>`.
- `verify-<feature-id>`
  Starts as `pending` and depends on `review-<feature-id>`.
- `delivery-package`
  Starts as `pending` and depends on all verification tasks.

`refreshRunState()` unlocks any `pending` task whose dependencies are all
`completed`. The `task` command can update any supported task status directly,
and `dispatch execute` can also write back `completed`, `failed`, and blocked
outcomes derived from dispatch results.

## Role Labels Versus Runtime Routing

The execution plan and the default factory config use these high-level labels:

- orchestrator: `OpenClaw`
- planner: `Cursor / Claude`
- executor: `Codex`
- reviewer: `Independent reviewer session or Cursor / Claude`
- verifier: `CI / automated test system`

Those labels are descriptive. Actual runtime routing is decided later by
`src/lib/runtime-registry.mjs` and the doctor report.

## Runtime Definitions

The runtime registry currently defines:

- `openclaw`
  - mode: `automated`
  - roles: `orchestrator`
- `cursor`
  - mode: `hybrid`
  - roles: `planner`, `reviewer`
- `codex`
  - mode: `automated`
  - roles: `executor`
- `local-ci`
  - mode: `automated`
  - roles: `verifier`
- `manual`
  - mode: `manual`
  - roles: all roles

Runtime preference order is currently:

- orchestrator: `openclaw`, then `manual`
- planner: `cursor`, then `manual`
- reviewer: `cursor`, then `manual`
- executor: `codex`, then `manual`
- verifier: `local-ci`, then `manual`

This now aligns the starter with its intended operating model:

- OpenClaw orchestrates
- Cursor / Claude stays the planning and review surface
- Codex executes implementation work
- local CI verifies

## How Handoff Generation Works

`createRunHandoffs()` reads:

- the run state
- the execution plan
- the spec snapshot
- the runtime doctor report

Before writing handoffs, it refreshes the run state and regenerates `report.md`.
The run state also persists the original workspace root, and handoff launchers use that stored path instead of the caller's current shell directory.

For each `ready` task it writes:

- `<task-id>.prompt.md`
- `<task-id>.handoff.json`
- `<task-id>.handoff.md`
- `<task-id>.launch.ps1`
- `results/<task-id>.result.json` as the expected output location
- `index.json` as the handoff index

Each prompt tells the selected runtime to write a JSON result artifact to the exact
`resultPath`. The prompt asks for these fields:

- `status`
- `summary`
- `changedFiles`
- `verification`
- `notes`

## Launcher Behavior

The generated launcher script depends on the selected runtime.

### OpenClaw

The launcher:

- reads the prompt file
- runs `openclaw agent --local --json --thinking medium --message $message`

### Cursor

The launcher:

- opens the workspace, brief, and prompt in Cursor
- is treated as a hybrid surface for planning or review work

`dispatch execute` does not auto-run Cursor tasks. They are currently treated as
manual or semi-manual follow-up.

### Codex

The launcher:

- changes to the workspace directory
- reads the prompt file
- pipes the prompt into `codex -a never exec -C . -s workspace-write -`

### Local CI

The launcher:

- changes to the workspace directory
- expands `mandatoryGates` into shell commands

Current gate-to-command mapping is:

- `build` -> `npm run build`
- `lint` -> `npm run lint`
- `typecheck` -> `npm run typecheck`
- `unit test` -> `npm test`
- `integration test` -> `npm run test:integration`
- `e2e test` -> `npm run test:e2e`

If no commands are produced, the launcher falls back to `npm test`.

### Manual

The launcher prints the prompt and brief paths and expects a human to continue.

## Dispatch Semantics

`dispatch` reads the handoff index and writes:

- `dispatch-results.json`
- `dispatch-results.md`

In `dry-run` mode:

- `openclaw`, `codex`, and `local-ci` are reported as `would_execute`
- `cursor` and `manual` are reported as `would_skip`

In `execute` mode:

- `openclaw`, `codex`, and `local-ci` are auto-executed
- `cursor` and `manual` are marked as `skipped`

Execution result states are currently:

- `completed`
  Launcher exited successfully and the expected result artifact exists with a valid schema.
- `incomplete`
  Launcher exited successfully but no valid result artifact was produced.
- `failed`
  Launcher execution itself failed.
- `skipped`
  Runtime is currently treated as manual or hybrid only.

Hybrid/manual follow-up now has a matching CLI-side retry path:

- `node src/index.mjs retry <runStatePath> <taskId> [reason] [delayMinutes]`
  schedules `waiting_retry` for transient surface failures
- `node src/index.mjs tick <runStatePath> [doctorReportPath] [outputDir]`
  re-opens tasks whose retry window has expired and rebuilds current handoffs
- `node src/index.mjs result <runStatePath> <taskId> <resultPath>`
  validates and applies a finished hybrid/manual artifact

When `dispatch execute` finds a sibling `run-state.json`, it also:

- maps `completed` dispatch results to task status `completed`
- maps `failed` dispatch results to task status `failed`
- maps `incomplete` dispatch results to task status `blocked`
- rewrites `report.md` when `execution-plan.json` is present

For `cursor` or `manual` follow-up, the same result contract can now be applied with:

```bash
node src/index.mjs result runs/example-run/run-state.json planning-brief runs/example-run/handoffs/results/planning-brief.result.json
```

For transient Cursor-side failures such as rate limits, timeout prompts, or server errors, schedule a timed retry with:

```bash
node src/index.mjs retry runs/example-run/run-state.json planning-brief "request frequency too high, please retry later" 3
```

`dispatch` still does not:

- inspect git diffs
- confirm semantic test quality beyond the recorded result artifact and launcher outcome

## Runtime Doctor Dependency

Handoff generation uses the runtime doctor report by default from:

- `reports/runtime-doctor.json`

If that report is missing, the loader returns an empty check list. Runtime
normalization then treats all non-manual runtimes as not ready, so routing falls
back to `manual`.

## Config Sources

The default role and gate configuration comes from:

- `config/factory.config.json`
- `src/lib/roles.mjs`

Current default mandatory gates are:

- `build`
- `lint`
- `typecheck`
- `unit test`
- `integration test`
- `e2e test`

Those gates are copied into verifier tasks and into generated local CI launchers.

## Known Gaps In The Current Implementation

The current codebase still has these important behavior gaps:

- `dispatch` does not mark tasks `in_progress` automatically
- `cursor` remains a hybrid runtime and is not auto-executed by `dispatch`
