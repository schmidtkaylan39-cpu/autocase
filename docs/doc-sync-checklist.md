# Doc Sync Checklist

Snapshot date: 2026-04-22 (Asia/Shanghai).

Use this checklist whenever behavior, routing, lifecycle, autonomous operation, or long-run validation changes.

## Canonical Docs By Surface

| Surface | Canonical doc | Must re-check these docs too |
| --- | --- | --- |
| run/task lifecycle | `docs/run-lifecycle.md` | `docs/architecture.md`, `docs/24h-autonomous-ops-runbook.md`, `docs/checkpoint-and-resume-basics.md`, `README.md` |
| dispatch semantics | `docs/dispatch.md` | `docs/architecture.md`, `docs/24h-autonomous-ops-runbook.md`, `docs/failure-injection-playbook.md`, `README.md` |
| runtime selection and handoff content | `docs/handoffs.md` | `docs/model-routing.md`, `docs/architecture.md`, `README.md` |
| model selection inside the chosen runtime | `docs/model-routing.md` | `docs/handoffs.md`, `docs/architecture.md`, `README.md` |
| autonomous stop/resume behavior | `docs/24h-autonomous-ops-runbook.md` and `docs/checkpoint-and-resume-basics.md` | `docs/overnight-operator-checklist.md`, `docs/next-round-execution-pack.md` |
| workspace isolation and soak operation | `docs/workspace-isolation-sop.zh-TW.md` and `docs/soak-test-operating-checklist.md` | `docs/soak-test-plan.md`, `docs/overnight-operator-checklist.md` |
| next-round sequencing and hotspot ownership | `docs/next-round-execution-pack.md` | `docs/shared-hotspots-and-merge-risks.md`, `docs/next-hardening-backlog.md` |

## File-Triggered Sync Matrix

If one of these code surfaces changes, review the matching docs in the same PR:

| Code/test surface changed | Minimum doc set to re-check |
| --- | --- |
| `src/lib/run-state.mjs` | `docs/run-lifecycle.md`, `docs/24h-autonomous-ops-runbook.md`, `docs/checkpoint-and-resume-basics.md`, `docs/shared-hotspots-and-merge-risks.md` |
| `src/lib/commands.mjs` | `docs/run-lifecycle.md`, `docs/handoffs.md`, `docs/24h-autonomous-ops-runbook.md`, `docs/shared-hotspots-and-merge-risks.md` |
| `src/lib/dispatch.mjs` | `docs/dispatch.md`, `docs/24h-autonomous-ops-runbook.md`, `docs/failure-injection-playbook.md`, `docs/shared-hotspots-and-merge-risks.md` |
| `src/lib/handoffs.mjs` or `src/lib/runtime-registry.mjs` | `docs/handoffs.md`, `docs/model-routing.md`, `docs/architecture.md`, `README.md` |
| `src/lib/doctor.mjs` | `docs/architecture.md`, `docs/24h-autonomous-ops-runbook.md`, `docs/release-readiness.md`, `docs/soak-test-operating-checklist.md` |
| `src/lib/autonomous-run.mjs` | `docs/24h-autonomous-ops-runbook.md`, `docs/checkpoint-and-resume-basics.md`, `docs/overnight-operator-checklist.md` |
| `scripts/live-roundtrip-acceptance.mjs`, `scripts/panel-browser-smoke.mjs`, `scripts/release-burnin.mjs`, or `scripts/release-windows-exe.mjs` | `docs/soak-test-plan.md`, `docs/soak-test-operating-checklist.md`, `docs/workspace-isolation-sop.zh-TW.md`, `docs/release-readiness.md` |
| `tests/run-tests.mjs` or `tests/dispatch-matrix-tests.mjs` | `docs/shared-hotspots-and-merge-risks.md`, `docs/next-round-execution-pack.md` if the test surface or ownership plan changed |

## Mandatory Pre-Merge Questions

- Did the PR change task status, run status, dispatch result status, terminal state, or resume mode language?
- If runtime defaults changed, did both `docs/handoffs.md` and `docs/model-routing.md` change together?
- If README was updated, was the canonical doc updated first?
- If a long-running command writes output, is the output-root or output-dir rule still documented?
- If a failure category or stop reason changed, is the same label reflected in the operator-facing docs?

## Known Drift Signals

Stop and resync docs if you see any of these:

- planner/reviewer/orchestrator described as `manual` primary while runtime registry says `gpt-runner`
- `blocked`, `attention_required`, and `exhausted` used interchangeably
- `report.md` described as source of truth
- `doctor` described as proof of successful task completion
- soak commands shown without dedicated output paths
- README or architecture describing behavior that canonical docs no longer describe

## Lowest-Risk Editing Pattern

1. Update code and tests first.
2. Update the canonical doc for that surface.
3. Update derivative docs in the same branch before merge.
4. Re-read the exact state names and runtime order from code before finalizing docs.
