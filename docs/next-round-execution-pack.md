# Next-Round Execution Pack

Snapshot date: 2026-04-22 (Asia/Shanghai).

This is the starting point for the next hardening round.
It is intentionally operational: what is already real, what is still thin, where merge risk is highest, and what order should happen next.

## Start Here Tomorrow

If only one engineer starts tomorrow, begin with a dedicated control-plane worktree for FI-01 and FI-02:

- control-plane artifact corruption in `run-state.json`
- handoff/dispatch control-plane corruption in `handoffs/index.json` and `dispatch-results.json`

Why this goes first:

- it targets the highest-risk correctness surfaces first
- it blocks less downstream work than dispatch/autonomous refactors would
- it produces the clearest next signal for verifier, doctor-drift, and soak work

Primary files for that first lane:

- `src/lib/commands.mjs`
- `src/lib/run-state.mjs`
- `src/lib/dispatch.mjs`
- `tests/run-tests.mjs`
- `tests/dispatch-matrix-tests.mjs`

Do not mix that lane with unrelated routing, panel, or release work.

## Current Hardening Baseline

### Already beyond basics

- Default route coverage is real, not aspirational:
  - `gpt-runner` for planner/reviewer/orchestrator
  - `codex` for executor
  - `local-ci` for verifier
- Dispatch/run-state hardening already includes:
  - result schema and handoff identity validation
  - stale-result cleanup before launch
  - restart recovery with current-result reuse
  - timeout handling
  - retry-budget and circuit-breaker guards
  - dispatch-to-run-state sync
- Autonomous recovery already has direct evidence for:
  - blocked planner/reviewer/executor recovery
  - stale/orphan lock reclamation
  - no-progress circuit behavior
  - terminal summary, checkpoint, and debug-bundle output
- Release/readiness work is already substantial:
  - Linux + Windows CI matrix
  - installability smoke
  - Windows backup/release smoke
  - release burn-in lane
- Workspace/output isolation is already documented and should be treated as mandatory operating policy, not optional advice.

### Still basics or still thin

- `doctor` is still a readiness probe, not proof that a runtime can finish a real task under current auth, quota, or provider health.
- The default route is much more proven than opt-in routes:
  - `openclaw`
  - `cursor`
  - delayed manual result application
- Failure taxonomy is documented, but direct failure injection is still thinner than the written policy for:
  - control-plane corruption
  - verifier-gate hang/fail/late-artifact cases
  - doctor-to-runtime drift
- Overnight confidence exists for burn-in and acceptance, but most fault drills are still short-lived rather than stateful overnight soak.
- Some docs still require explicit sync to avoid drift, especially around routing and state-surface language.

## State Surfaces That Must Not Be Conflated

| Surface | Values today | Source of truth | Use it for | Common mistake |
| --- | --- | --- | --- | --- |
| task status | `pending`, `ready`, `waiting_retry`, `in_progress`, `completed`, `failed`, `blocked` | `runs/<run-id>/run-state.json` -> `taskLedger[]` | per-task actionability | treating it as the same thing as run/session status |
| run status | `planned`, `in_progress`, `completed`, `attention_required` | `runs/<run-id>/run-state.json` -> `status` | aggregate run rollup | reading it as the autonomous terminal outcome |
| dispatch result status | `would_execute`, `would_skip`, `completed`, `continued`, `incomplete`, `failed`, `skipped` | `handoffs*/dispatch-results.json` | one dispatch attempt outcome | mapping it 1:1 to task status |
| autonomous terminal state | `done`, `blocked`, `exhausted` | `artifacts/autonomous-debug/terminal-summary.json` | session stop classification | treating `blocked` as the same thing as `attention_required` |
| checkpoint resume state | `none`, `manual`, `immediate`, `scheduled` | `artifacts/autonomous-debug/checkpoint.json` -> `resume` | next resume action | assuming `canResume: true` means "safe to rerun immediately" |

Two extra rules matter here:

- `report.md` is a convenience artifact, not the final source of truth.
- `reports/runtime-doctor.json` proves readiness only; it does not prove successful execution.

## Recommended Execution Order

| Order | Task | Why now | Primary hotspots | Best validation |
| --- | --- | --- | --- | --- |
| 1 | FI-01 + FI-02 control-plane corruption drills | Highest correctness risk and highest leverage for later lanes | `src/lib/commands.mjs`, `src/lib/run-state.mjs`, `src/lib/dispatch.mjs`, `tests/run-tests.mjs`, `tests/dispatch-matrix-tests.mjs` | targeted run/dispatch tests plus one autonomous regression |
| 2 | FI-03 verifier/local-ci failure matrix | Default route includes verifier, but direct fail/hang/late-artifact evidence is still thin | `src/lib/handoffs.mjs`, `src/lib/dispatch.mjs`, `tests/dispatch-matrix-tests.mjs`, `tests/run-tests.mjs` | per-gate fail/hang/no-artifact/late-artifact scenarios |
| 3 | FI-04 doctor-to-runtime drift drills | Closes the gap between probe-time readiness and real execution | `src/lib/doctor.mjs`, `src/lib/runtime-registry.mjs`, `scripts/e2e-smoke.mjs`, `tests/doctor-tests.mjs`, `tests/live-roundtrip-acceptance-tests.mjs` | simulated expired auth/model denial/429+5xx sequences |
| 4 | Overnight soak lane setup and first controlled run | After the highest-risk fault drills land, soak can hunt flake instead of masking correctness gaps | `scripts/release-burnin.mjs`, `scripts/e2e-smoke.mjs`, `scripts/live-roundtrip-acceptance.mjs` | isolated overnight burn-in + acceptance outputs |
| 5 | Merge-hotspot reduction plan into implementation tickets | Prevents the next broad hardening round from colliding in the same files again | `src/lib/commands.mjs`, `src/lib/dispatch.mjs`, `tests/run-tests.mjs`, `tests/dispatch-matrix-tests.mjs`, shared docs | smaller feature-scoped files plus doc-sync enforcement |

## Branch And Worktree Rules

Use one write lane per worktree.

- One task lane = one branch + one worktree + one active write owner.
- Detached `HEAD` is acceptable for reading a baseline commit, not for new implementation work.
- Long-running validation should use a dedicated validation worktree when it writes any of:
  - `reports/`
  - `tmp/`
  - browser profiles
  - release output directories
- Two conversations may read the same repository, but they must not both write to the same worktree.
- If two lanes need the same hotspot file family, sequence them instead of parallelizing them.

Recommended lane split for the next round:

1. Control-plane failure injection lane
2. Verifier matrix lane
3. Doctor/runtime drift lane
4. Soak/acceptance lane
5. Docs sync / hotspot-reduction lane

Use [workspace-isolation-sop.zh-TW.md](workspace-isolation-sop.zh-TW.md) for the concrete operating rules.

## Planned Hotspot Reduction

These are planning targets only for a later round.
Do not treat them as part of the current docs package.

| Current hotspot | Planned split | Why it helps |
| --- | --- | --- |
| `src/lib/commands.mjs` | split into intake/spec commands, run/report/tick commands, and handoff/result/retry commands | reduces collisions between lifecycle work and hybrid/manual follow-up work |
| `src/lib/dispatch.mjs` | split launcher execution, artifact validation, automatic retry policy, and run-state sync/report writing | lets dispatch policy and execution plumbing evolve independently |
| `tests/run-tests.mjs` | split into run-creation, handoff generation, result-application/retry, and tick/report suites | avoids unrelated lifecycle tests colliding in one file |
| `tests/dispatch-matrix-tests.mjs` | split into artifact validation, launcher failure handling, and concurrency/idempotency suites | lowers text conflict rate for dispatch work |
| `README.md` + `docs/architecture.md` | keep behavior tables in canonical docs and shrink README to operator-facing summary | reduces doc drift and repeated behavior prose |

## Related Docs

- [shared-hotspots-and-merge-risks.md](shared-hotspots-and-merge-risks.md)
- [doc-sync-checklist.md](doc-sync-checklist.md)
- [failure-injection-playbook.md](failure-injection-playbook.md)
- [soak-test-operating-checklist.md](soak-test-operating-checklist.md)
- [workspace-isolation-sop.zh-TW.md](workspace-isolation-sop.zh-TW.md)
