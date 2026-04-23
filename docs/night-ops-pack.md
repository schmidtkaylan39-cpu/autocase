# Night Ops Pack

This pack consolidates the docs-only handoff for unattended and overnight autonomous runs.
It keeps the night-before review, the next-morning triage, the runtime-failure deep dive, and the canonical state vocabulary in one place.

## Reading Order

1. Before handing work to an unattended loop, use [Night Run Review Checklist](night-run-review-checklist.md).
2. On the morning handoff, start with [Morning Triage Checklist](morning-triage-checklist.md).
3. If the issue looks like runtime, doctor, or verifier drift, switch to [Runtime Failure Triage](runtime-failure-triage.md).
4. If any state label or truth source feels ambiguous, treat [State Surface Audit](state-surface-audit.md) as canonical.

## Canonical Rules For This Pack

- `run-state.json` is the source of truth for durable run rollup and task status.
- `artifacts/autonomous-debug/terminal-summary.json` is the source of truth for autonomous terminal state.
- `artifacts/autonomous-debug/checkpoint.json.resume` is the source of truth for resume guidance.
- `handoffs*/dispatch-results.json` is the source of truth for attempt-level dispatch outcomes.
- `report.md` is a convenience view, not the final truth source.
- `reports/runtime-doctor.json` is readiness evidence, not success evidence.

## Scope

This pack only consolidates the existing docs work around morning triage, runtime failure triage, and state-surface interpretation.
It does not introduce new control-flow behavior.
