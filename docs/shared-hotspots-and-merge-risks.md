# Shared Hotspots And Merge Risks

Snapshot date: 2026-04-22 (Asia/Shanghai).

This document identifies the shared surfaces most likely to create future merge conflicts or behavior drift when multiple hardening tasks run in parallel.

## Highest-Risk Shared Hotspots

| Rank | Hotspot | Why It Conflicts | Typical Co-Changed Files | Recommended Guardrail |
| --- | --- | --- | --- | --- |
| 1 | Run lifecycle API | `run`, `task`, `result`, `retry`, `tick`, and `handoff` all converge on the same lifecycle/state paths | `src/lib/commands.mjs`, `src/lib/run-state.mjs`, `docs/run-lifecycle.md`, `tests/run-tests.mjs` | one owner surface per round; update lifecycle docs/tests in the same PR |
| 2 | Dispatch semantics | result validation, launcher execution, retries, stale artifact handling, lock recovery, and run-state sync all meet here | `src/lib/dispatch.mjs`, `src/lib/result-artifact.mjs`, `docs/dispatch.md`, `tests/dispatch-matrix-tests.mjs` | do not split dispatch semantics across multiple simultaneous feature branches |
| 3 | Routing and handoff contract | runtime choice, model choice, launcher text, prompt contract, and fallback behavior are tightly coupled | `src/lib/handoffs.mjs`, `src/lib/runtime-registry.mjs`, `src/lib/model-policy.mjs`, `config/factory.config.json`, `tests/runtime-registry-tests.mjs` | route all runtime/model work through one contract owner |
| 4 | Result/retry/tick transition matrix | small state-machine changes ripple into dispatch, autonomous recovery, and docs quickly | `src/lib/run-state.mjs`, `src/lib/result-application.mjs`, `src/lib/result-artifact.mjs`, `docs/artifact-contract.md`, `docs/run-lifecycle.md` | treat transition rules as one change family |
| 5 | Autonomous acceptance harness | release, CI, and reliability work all want to edit the same orchestration assumptions | `src/lib/autonomous-run.mjs`, `scripts/e2e-smoke.mjs`, `scripts/live-roundtrip-acceptance.mjs`, `tests/autonomous-run-tests.mjs`, `tests/live-roundtrip-acceptance-tests.mjs` | use dedicated worktrees and avoid unrelated edits in the same round |
| 6 | Doctor/runtime-readiness surface | shell parity, auth/readiness checks, and route selection drift together | `src/lib/doctor.mjs`, `src/lib/powershell.mjs`, `docs/runtime-doctor.md`, `tests/doctor-tests.mjs` | keep doctor changes paired with routing docs and tests |
| 7 | Shared documentation set | behavior changes often need synchronized edits across several long docs, and some tests assert doc alignment | `README.md`, `docs/architecture.md`, `docs/handoffs.md`, `docs/dispatch.md`, `docs/model-routing.md` | pick one canonical source doc and keep a doc-sync checklist |
| 8 | Large monolithic test files | unrelated features append cases into the same files, causing text conflicts even when logic is independent | `tests/run-tests.mjs`, `tests/dispatch-matrix-tests.mjs` | split by feature area before the next wide hardening round |

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

- `docs/model-routing.md` still describes planner/reviewer/orchestrator as manual-primary, while current routing docs/tests center the default route on `gpt-runner`.
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

## Recommended Merge-Avoidance Sequence

If the next round includes multiple parallel tasks, sequence them like this:

1. lifecycle/control-plane hardening
2. dispatch-specific hardening
3. routing/model/handoff changes
4. soak/acceptance harness expansion
5. docs consolidation and cleanup

That order keeps the highest-risk state-machine changes from colliding with downstream harness and documentation changes.
