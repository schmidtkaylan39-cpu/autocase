# Shared Hotspots And Merge Risks

Snapshot date: 2026-04-22 (Asia/Shanghai).

This document identifies the shared surfaces most likely to create future merge conflicts or behavior drift when multiple hardening tasks run in parallel.

## Highest-Risk File Hotspots

| Rank | File or family | Why it conflicts | Typical co-changes | Recommended guardrail | Planned reduction |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/lib/commands.mjs` | `run`, `report`, `task`, `retry`, `tick`, `result`, and `handoff` all converge here | `src/lib/run-state.mjs`, `docs/run-lifecycle.md`, `tests/run-tests.mjs` | one lifecycle owner lane per round | split lifecycle/report/tick from handoff/result/retry |
| 2 | `src/lib/dispatch.mjs` | launcher execution, result validation, retries, locks, and run-state sync all live together | `src/lib/result-artifact.mjs`, `docs/dispatch.md`, `tests/dispatch-matrix-tests.mjs` | do not parallelize dispatch semantics in separate branches | split execution, validation, retry policy, and sync/reporting |
| 3 | `tests/dispatch-matrix-tests.mjs` | dispatch reliability, concurrency, idempotency, and artifact cases all append into one file | `src/lib/dispatch.mjs` | one dispatch test owner at a time | split by artifact validation, launcher failure, concurrency/idempotency |
| 4 | `tests/run-tests.mjs` | run creation, handoff generation, result application, retry, tick, and dispatch smoke all append here | `src/lib/commands.mjs`, `src/lib/run-state.mjs` | one lifecycle test owner at a time | split by run creation, handoff, result/retry, tick/report |
| 5 | `src/lib/run-state.mjs` | transition rules, run-status rollup, retry release, and report data derive from the same model | `src/lib/commands.mjs`, `src/lib/autonomous-run.mjs`, `docs/run-lifecycle.md` | treat state transitions as one change family | split state model from report rendering |
| 6 | `src/lib/autonomous-run.mjs` | stop reasons, checkpointing, recovery, and terminal-state meaning drift easily | `docs/24h-autonomous-ops-runbook.md`, `docs/checkpoint-and-resume-basics.md`, `tests/autonomous-run-tests.mjs` | keep autonomous semantics in one lane | split progress diagnostics from stop/resume summarization later |
| 7 | Shared docs set | README, architecture, routing, lifecycle, and operator docs can drift on the same behavior | `README.md`, `docs/architecture.md`, `docs/handoffs.md`, `docs/model-routing.md`, `docs/run-lifecycle.md` | update canonical doc first and use doc-sync checklist | shrink README; keep behavior tables in canonical docs |

## State Surfaces That Look Similar But Are Not

| Surface | Values today | Source of truth | Why people mix it up |
| --- | --- | --- | --- |
| task status | `pending`, `ready`, `waiting_retry`, `in_progress`, `completed`, `failed`, `blocked` | `run-state.json.taskLedger[]` | it is the actionable surface, so people over-read it as session state |
| run status | `planned`, `in_progress`, `completed`, `attention_required` | `run-state.json.status` | it is an aggregate rollup, not the autonomous terminal outcome |
| dispatch result status | `completed`, `continued`, `incomplete`, `failed`, `skipped` plus dry-run values | `dispatch-results.json` | names partially overlap task outcomes but mean attempt-level results |
| autonomous terminal state | `done`, `blocked`, `exhausted` | `terminal-summary.json` | operators often collapse it into run status |
| resume mode | `none`, `manual`, `immediate`, `scheduled` | `checkpoint.json.resume` | `canResume: true` does not always mean "rerun now" |

Two rules should stay explicit:

- `report.md` is a derived view, not the final truth source.
- `reports/runtime-doctor.json` is a readiness artifact, not success proof.

## Shared Output Hotspots

These are not code files, but they are frequent conflict sources during validation:

- `reports/`
- `tmp/`
- release output directories
- browser profiles
- acceptance output roots
- run directories reused across multiple active experiments

The main risk is not just git conflict. It is evidence contamination:

- stale report reused as current evidence
- one run deleting or overwriting another run's output
- browser smoke reading the wrong profile or previous run state

## Most Likely Future Conflict Patterns

1. A dispatch reliability task and a lifecycle semantics task both touch `src/lib/commands.mjs`, `src/lib/run-state.mjs`, and `tests/run-tests.mjs`.
2. A routing task and a release/readiness task both touch `src/lib/runtime-registry.mjs`, `src/lib/handoffs.mjs`, `README.md`, and `docs/model-routing.md`.
3. A soak or acceptance task and a panel/release task both want `reports/`, `tmp/`, or browser-related output directories.
4. A docs cleanup task and a behavior change task both touch `README.md` and `docs/architecture.md`, then drift because only one side updated the derivative docs.
5. Multiple reliability tasks append new scenarios into `tests/dispatch-matrix-tests.mjs` or `tests/run-tests.mjs` at the same time.

## Concrete Drift Signals To Watch

- runtime docs disagree on whether planner/reviewer/orchestrator default to `gpt-runner` or `manual`.
- operator docs use `blocked`, `attention_required`, and `exhausted` interchangeably.
- Release/readiness docs, architecture docs, and README are all carrying overlapping descriptions of the same lifecycle and routing behavior.
- Acceptance and soak guidance can drift from the workspace-isolation SOP if output-root rules are copied into scripts/docs inconsistently.

## Recommended Coordination Rules

1. Treat lifecycle semantics, dispatch semantics, and routing semantics as three separate ownership lanes. Do not mix them casually in the same round.
2. When a task changes one of the top four hotspots, require matching doc and test updates in the same PR.
3. For long-running validation, use a separate worktree plus dedicated output paths instead of sharing the default workspace.
4. Split `tests/run-tests.mjs` and `tests/dispatch-matrix-tests.mjs` before the next broad hardening push if multiple contributors will work in parallel.
5. Choose one canonical behavior doc:
   - recommended candidates: `docs/architecture.md` or `docs/run-lifecycle.md`
   - keep README and other docs derivative from that source

## Planned Split Candidates

These are planning targets only; they are not part of the current docs package.

| Candidate | Proposed split | Why it lowers merge risk |
| --- | --- | --- |
| `src/lib/commands.mjs` | intake/spec commands, lifecycle/report/tick commands, handoff/result/retry commands | fewer unrelated edits in the same file |
| `src/lib/dispatch.mjs` | launcher execution, artifact validation, retry/circuit policy, run-state sync/report generation | dispatch lanes can change one concern at a time |
| `tests/run-tests.mjs` | run creation, handoff generation, hybrid/manual result flow, tick/report behavior | lifecycle test work no longer stacks into one file |
| `tests/dispatch-matrix-tests.mjs` | artifact validation, launcher failure handling, concurrency/idempotency | dispatch test additions stop colliding as often |
| README + architecture docs | README becomes operator-facing summary; detailed behavior lives in canonical docs | less repeated prose and less doc drift |

## Recommended Merge-Avoidance Sequence

If the next round includes multiple parallel tasks, sequence them like this:

1. lifecycle/control-plane hardening
2. dispatch-specific hardening
3. routing/model/handoff changes
4. soak/acceptance harness expansion
5. docs consolidation and cleanup

That order keeps the highest-risk state-machine changes from colliding with downstream harness and documentation changes.
