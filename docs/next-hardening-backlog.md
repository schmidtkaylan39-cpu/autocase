# Next Hardening Backlog

Snapshot date: 2026-04-22 (Asia/Shanghai).

This is a docs-only planning artifact for the next hardening round. It does not change code, tests, panel behavior, runtime routing, dispatch behavior, or autonomous flow behavior.

Start with [next-round-execution-pack.md](next-round-execution-pack.md) for the recommended order, hotspot ownership, and branch/worktree operating rules.

## What Is Already Hardened

- Dispatch/state safety is already beyond the basics:
  - result schema and handoff identity validation
  - stale result cleanup before launch
  - restart recovery when a valid current result already exists
  - timeout handling
  - large stderr tail capture
  - prompt hash checks
  - retry-budget and circuit-breaker guards
  - idempotency and concurrent dispatch locking
  - run-state/report sync after `dispatch execute`
- Autonomous recovery is already directly tested:
  - blocked planner/reviewer/delivery recovery
  - orphaned and stale lock reclamation
  - no-progress breaker behavior
  - failure-feedback artifact generation
  - terminal summary/checkpoint/debug bundle output
- The default route is already exercised end to end:
  - `gpt-runner` planner/reviewer through Codex CLI
  - `codex` executor
  - `local-ci` verifier
  - isolated autonomous E2E scenarios for baseline, timeout recovery, `502 Bad Gateway`, and interruption recovery
- Release/readiness coverage is already substantial:
  - Linux + Windows CI matrix
  - package installability smoke
  - Windows backup/release smoke
  - release burn-in lane
  - progressive rollout helper
  - published release evidence artifacts
- Workspace/output isolation already has an explicit SOP:
  - dedicated output roots for long-running validation
  - warnings against shared `reports/`, `tmp/`, browser profiles, and release artifacts

## What Is Still At Basics

- `doctor` is still a readiness probe, not proof that a runtime can finish a real task under current credentials, model availability, or external provider health.
- Failure taxonomy and incident SOPs are documented well, but much of that guidance is still operational policy rather than continuously enforced failure injection.
- Optional routes remain less proven than the default route:
  - `openclaw`
  - `cursor`
  - manual result-application paths
- `local-ci` readiness is stronger than before, but the doctor still checks script presence and launcher readiness more than real gate behavior.
- Long-duration confidence exists for release burn-in, but most direct fault drills are still short-run or single-scenario rather than overnight stateful soak.
- Some docs still drift from the real routing baseline, especially around planner/reviewer/orchestrator defaults.

## Failure Modes Still Not Directly Tested

1. Control-plane artifact corruption:
   - truncated or partially written `run-state.json`
   - truncated or partially written `handoffs/index.json`
   - truncated or partially written `dispatch-results.json`
2. Verifier-specific late or partial artifact behavior:
   - gate fails after some gates already passed
   - gate hangs with no result artifact
   - gate times out but a late result arrives afterward
3. Doctor false-positive drift:
   - runtime looks ready during `doctor`
   - first real task fails because login expired, model access changed, or provider permissions drifted
4. Cross-run shared-output contamination:
   - two long-running validations share `reports/`, `tmp/`, or the same output root
   - one run reads stale evidence from another run
5. Non-default runtime route failures:
   - `openclaw` opt-in route
   - `cursor` override route
   - manual/hybrid result application after delay or operator interruption
6. Long-path, locked-file, and permission edge cases in Windows release/package flows

## Recommended Next Task Order

| Rank | Task | Why This Comes Next | Primary Hotspots | Best Validation |
| --- | --- | --- | --- | --- |
| 1 | Add control-plane artifact corruption drills | This is the largest remaining gap around the highest-risk surfaces: `run-state`, handoff index, and dispatch result files. | `src/lib/run-state.mjs`, `src/lib/commands.mjs`, `src/lib/dispatch.mjs`, `tests/run-tests.mjs`, `tests/dispatch-matrix-tests.mjs` | targeted failure-injection tests plus one autonomous regression case |
| 2 | Add verifier/local-ci failure matrix | The verifier path is part of the default route, but most direct evidence is happy-path or generic missing-artifact coverage. | `src/lib/handoffs.mjs`, `src/lib/dispatch.mjs`, `tests/dispatch-matrix-tests.mjs`, `tests/run-tests.mjs` | per-gate fail/hang/no-artifact/late-artifact scenarios |
| 3 | Add doctor-to-runtime drift drills | This closes the gap between probe-time readiness and first real execution under degraded auth/provider conditions. | `src/lib/doctor.mjs`, `src/lib/runtime-registry.mjs`, `scripts/e2e-smoke.mjs`, `tests/doctor-tests.mjs`, `tests/live-roundtrip-acceptance-tests.mjs` | simulated expired auth/model denial/429+5xx sequences |
| 4 | Stand up an overnight soak lane for the default route | The default route is the main release surface, and it now has enough harness support to justify long-run flake hunting. | `scripts/release-burnin.mjs`, `scripts/e2e-smoke.mjs`, `scripts/live-roundtrip-acceptance.mjs` | dedicated overnight burn-in, repeated E2E, and live acceptance runs with isolated outputs |
| 5 | Reduce merge hotspots before the next broad reliability round | More hardening work will keep colliding unless the shared lifecycle/test/doc surfaces are isolated better. | `src/lib/commands.mjs`, `src/lib/dispatch.mjs`, `tests/run-tests.mjs`, `tests/dispatch-matrix-tests.mjs`, `README.md`, `docs/architecture.md` | smaller feature-scoped test files plus doc-sync checklist |
| 6 | Add non-default runtime route drills | Important, but behind the default route in priority because it is opt-in today. | `src/lib/runtime-registry.mjs`, `src/lib/handoffs.mjs`, `tests/runtime-registry-tests.mjs`, `tests/dispatch-matrix-tests.mjs` | end-to-end override scenarios for `openclaw`, `cursor`, and manual follow-up |
| 7 | Extend Windows release/package stress cases | Valuable for release confidence, but less urgent than default-route control-plane reliability. | `scripts/release-windows-exe.mjs`, `tests/release-windows-exe-tests.mjs` | long-path, locked-file, retry, and repeated packaging smoke |

## Overnight-Friendly Candidates

Best fits for overnight execution:

- repeated `quality` burn-in with a dedicated summary file
- repeated `example` burn-in with a dedicated summary file
- repeated `npm run test:e2e`
- `npm run acceptance:live` with a dedicated `--output-root`
- `npm run acceptance:panel:browser:full` with a dedicated `--output-root`
- Windows-only `backup:project` and `release:win` smoke with dedicated output directories

Not good to run in parallel with other shared-output jobs:

- `npm run selfcheck`
- anything that rewrites the default `reports/runtime-doctor.json`
- anything that rewrites the default `reports/validation-results.json`

## Notes For The Next Round

- Keep the next implementation round focused on the default route first.
- Treat `result`, `retry`, `tick`, `handoff`, and `dispatch` as one conflict family even when the task looks narrower.
- If the next round touches lifecycle semantics, pair code changes with:
  - lifecycle docs
  - dispatch/run tests
  - release/readiness docs when behavior becomes externally visible
