# State Surface Audit

Snapshot date: 2026-04-23 (Asia/Shanghai).

This is a docs-only audit of the current state surfaces used by the live CLI and its autonomous loop.
It does not change code, tests, panel behavior, runtime routing, dispatch behavior, or autonomous control flow.

This document is the canonical vocabulary reference for [Night Ops Pack](night-ops-pack.md), [Morning Triage Checklist](morning-triage-checklist.md), and [Runtime Failure Triage](runtime-failure-triage.md).
Use it whenever `attention_required`, `blocked`, `exhausted`, dispatch result status, or resume mode are being compared across artifacts.

## Scope And Sources

Primary source files reviewed for this audit:

- `src/lib/run-state.mjs`
- `src/lib/result-application.mjs`
- `src/lib/dispatch.mjs`
- `src/lib/autonomous-run.mjs`
- `docs/run-lifecycle.md`
- `docs/24h-autonomous-ops-runbook.md`
- `docs/checkpoint-and-resume-basics.md`
- `docs/dispatch.md`
- `docs/shared-hotspots-and-merge-risks.md`

Secondary contrast source reviewed for ambiguity only:

- `src/core/state-machine.mjs`
- `src/contracts/run-model.mjs`

## Canonical State Surfaces In The Live CLI

| Surface | Values today | Current source of truth | What it means | Primary writers |
| --- | --- | --- | --- | --- |
| `run-state.status` | `planned`, `in_progress`, `completed`, `attention_required` | `run-state.json` as refreshed by `src/lib/run-state.mjs` | aggregate run rollup | `run`, `task`, `result`, `retry`, `tick`, `handoff`, `dispatch`, `autonomous` via refreshed run-state writes |
| task status | `pending`, `ready`, `waiting_retry`, `in_progress`, `completed`, `failed`, `blocked` | `run-state.json.taskLedger[]` | per-task actionability and dependency state | `src/lib/run-state.mjs`, `src/lib/result-application.mjs`, `src/lib/dispatch.mjs` |
| autonomous terminal state | `done`, `blocked`, `exhausted` | `artifacts/autonomous-debug/terminal-summary.json` and `autonomous-summary.json` | why one autonomous session stopped | `src/lib/autonomous-run.mjs` |
| `checkpoint.resume.mode` | `none`, `manual`, `immediate`, `scheduled` | `artifacts/autonomous-debug/checkpoint.json.resume` | what kind of next autonomous entry is appropriate | `src/lib/autonomous-run.mjs` |

## What The Current Code Actually Does

### `run-state.status`

The live rollup in `src/lib/run-state.mjs` currently behaves like this:

- `attention_required` if any task is `failed` or `blocked`
- `completed` if every task is `completed`
- `in_progress` if any task is `in_progress`, `waiting_retry`, or already `completed` while the run is not finished
- `planned` when the run still only has `ready` and `pending` work

This means `run-state.status` is not a session-stop label.
It is a ledger rollup.

### Task status

The live CLI task ledger currently uses:

- `pending`
- `ready`
- `waiting_retry`
- `in_progress`
- `completed`
- `failed`
- `blocked`

Important operational meaning:

- `waiting_retry` is not terminal; refresh can promote it back to `ready`
- `blocked` can also auto-unlock later when retry metadata and cooldown conditions allow it
- `failed` and `blocked` both drive `run-state.status` to `attention_required`

### Autonomous terminal state

The live autonomous classifier in `src/lib/autonomous-run.mjs` currently behaves like this:

- `done` when the run is completed
- `blocked` when any blocked/failed task exists or the run status is `attention_required`
- `exhausted` when round budget is consumed, or work remains without blocked/failed tasks

This is session-level stop classification, not the same thing as `run-state.status`.

### `checkpoint.resume.mode`

The live resume summary in `src/lib/autonomous-run.mjs` currently behaves like this:

- `none` when terminal state is `done`
- `manual` when terminal state is `blocked`
- `immediate` when terminal state is `exhausted` and no future retry window is pending
- `scheduled` when terminal state is `exhausted` and at least one `waiting_retry` task has a future `nextRetryAt`

This is next-action guidance, not a task outcome.

## States That Are Easy To Confuse

| Looks similar | Why it gets confused | What should win |
| --- | --- | --- |
| `run-state.status = attention_required` vs terminal `blocked` | both imply intervention, but one is run rollup and the other is autonomous session stop classification | trust the artifact that matches the question: run rollup in `run-state.json`, session stop in `terminal-summary.json` |
| `run-state.status = in_progress` vs terminal `exhausted` | both can coexist when work remains | `in_progress` means the run is still alive overall; `exhausted` means only this autonomous session stopped |
| task `blocked` vs dispatch result `incomplete` | dispatch `incomplete` often maps back into task `blocked`, but they are different layers | attempt result lives in `dispatch-results.json`; durable task state lives in `run-state.json` |
| task `waiting_retry` vs resume mode `scheduled` | both point at a future retry window | `waiting_retry` is task-level state; `scheduled` is session-level resume guidance |
| `checkpointStatus = halted` vs terminal `blocked` or `exhausted` | both appear in checkpoint artifacts after a stop | `checkpointStatus` tells whether the session ended cleanly, not why it ended |

## Main Ambiguity Found

The repository currently contains two different state vocabularies:

1. The live CLI control plane under `src/lib/`, which uses:
   - run status: `planned / in_progress / completed / attention_required`
   - task status: `pending / ready / waiting_retry / in_progress / completed / failed / blocked`
   - autonomous terminal state: `done / blocked / exhausted`
2. The separate `src/core/` model, which uses:
   - run phase: `queued / ... / done / blocked / exhausted`
   - task status: `queued / ready / in_progress / completed / blocked / exhausted`

The current CLI entrypoint is wired to `src/lib/*`, not to `src/core/*`.
If future docs or patches read both models without an explicit boundary, they can mix `queued`, `planned`, `attention_required`, `blocked`, and `exhausted` as if they came from one state machine.

## Secondary Doc Drift Found

`docs/run-lifecycle.md` currently under-specifies the actual live rollup in `src/lib/run-state.mjs`.

The current code treats all of these as `in_progress`:

- any `in_progress` task
- any `waiting_retry` task
- any partially completed run with at least one `completed` task and remaining work

The current code also treats any `blocked` task as `attention_required`, not only `failed` tasks.

## Hotspot Files Called Out By This Audit

Highest-risk write hotspots for any future state-surface change:

1. `src/lib/run-state.mjs`
2. `src/lib/autonomous-run.mjs`
3. `src/lib/dispatch.mjs`
4. `src/lib/result-application.mjs`
5. `tests/run-tests.mjs`
6. `tests/dispatch-matrix-tests.mjs`
7. `tests/autonomous-run-tests.mjs`

Highest-risk doc drift hotspots for the same changes:

1. `docs/run-lifecycle.md`
2. `docs/24h-autonomous-ops-runbook.md`
3. `docs/checkpoint-and-resume-basics.md`
4. `docs/dispatch.md`
5. `docs/architecture.md`
6. `README.md`

## Audit Recommendations

1. Treat `src/lib/run-state.mjs` plus on-disk run artifacts as the canonical state vocabulary for the current shipped CLI.
2. Treat `src/core/` state names as a separate model until an explicit migration branch decides otherwise.
3. When a PR changes any state label or rollup rule, update the canonical docs for that surface in the same branch.
4. Keep `report.md` documented as a derived convenience view, not the final truth source.
5. Keep `reports/runtime-doctor.json` documented as readiness evidence, not completion evidence.
