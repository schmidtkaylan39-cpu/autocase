# Failure Injection Playbook

Snapshot date: 2026-04-22 (Asia/Shanghai).

This playbook turns the failure-injection plan into an execution order that engineers can pick up directly.
It is for the next hardening round, not for the current docs-only package.

## Lane Ownership

Keep these lanes separate unless one owner explicitly takes the whole family:

| Lane | Scope | Hotspots you own |
| --- | --- | --- |
| Lane A | FI-01 and FI-02 control-plane corruption | `src/lib/commands.mjs`, `src/lib/run-state.mjs`, `src/lib/dispatch.mjs`, `tests/run-tests.mjs`, `tests/dispatch-matrix-tests.mjs` |
| Lane B | FI-03 verifier/local-ci matrix | `src/lib/handoffs.mjs`, `src/lib/dispatch.mjs`, `tests/dispatch-matrix-tests.mjs`, `tests/run-tests.mjs` |
| Lane C | FI-04 doctor-to-runtime drift | `src/lib/doctor.mjs`, `src/lib/runtime-registry.mjs`, `scripts/e2e-smoke.mjs`, `tests/doctor-tests.mjs`, `tests/live-roundtrip-acceptance-tests.mjs` |
| Lane D | FI-05 shared-output collision | acceptance/release scripts plus isolation docs | `scripts/live-roundtrip-acceptance.mjs`, `scripts/panel-browser-smoke.mjs`, `scripts/release-burnin.mjs`, isolation docs |
| Lane E | FI-06 and FI-07 opt-in runtime and Windows edge cases | runtime registry/handoff tests or Windows release scripts | `src/lib/runtime-registry.mjs`, `src/lib/handoffs.mjs`, `tests/runtime-registry-tests.mjs`, `tests/release-windows-exe-tests.mjs` |

## Start Order

1. FI-01 and FI-02 together
2. FI-03
3. FI-04
4. FI-05
5. FI-06
6. FI-07

Do not start FI-05 soak/output collision drills before FI-01 through FI-04 settle, or overnight evidence becomes harder to interpret.

## Preflight For Every Lane

- Start from a fresh branch and worktree.
- Reserve one active write owner for the lane.
- Use dedicated output paths for any acceptance or soak side work.
- Capture the smallest reproducible failing command before expanding the matrix.
- Decide the acceptance check before editing:
  - target unit/integration test
  - autonomous regression if the lane touches session behavior
  - doc sync if state names or runtime behavior changed

## Scenario Cards

### FI-01: Run-State Corruption

Goal:

- prove that truncated, invalid, or zero-byte `run-state.json` fails closed

Inject:

- truncate `run-state.json` before `tick`
- write invalid JSON before `retry`
- write zero bytes before autonomous reads

Expected outcome:

- no silent task promotion
- failure classified as `artifact_invalid`
- readable error/debug evidence remains available

Fast validation:

```bash
node tests/run-tests.mjs
node tests/autonomous-run-tests.mjs
```

### FI-02: Handoff And Dispatch Control-Plane Corruption

Goal:

- prove malformed handoff/dispatch control-plane files are rejected before mutation

Inject:

- truncate `handoffs/index.json`
- remove descriptor fields like `launcherPath` or `resultPath`
- corrupt `dispatch-results.json` before a reader consumes it

Expected outcome:

- dispatch fails fast
- no descriptor executes from malformed input
- autonomous does not loop on unreadable control-plane evidence

Fast validation:

```bash
node tests/dispatch-matrix-tests.mjs
node tests/autonomous-run-tests.mjs
```

### FI-03: Verifier / Local-CI Failure Matrix

Goal:

- make per-gate fail/hang/no-artifact/late-artifact behavior explicit

Inject:

- `build` fails
- `lint` fails
- `typecheck` hangs
- `test` exits non-zero without a result artifact
- `test:integration` or `test:e2e` writes a late artifact after timeout

Expected outcome:

- one authoritative task outcome per scenario
- stale or late artifacts are not reused silently
- failure-feedback includes gate identity and retryability signal

Fast validation:

```bash
node tests/dispatch-matrix-tests.mjs
node tests/run-tests.mjs
```

### FI-04: Doctor-To-Runtime Drift

Goal:

- prove that a green doctor report does not hide real runtime drift

Inject:

- expired login after doctor passes
- model-denied or quota-denied first execution
- mixed `429`, timeout, and `502` within one acceptance flow

Expected outcome:

- bounded retry
- explicit failure classification
- no silent route confusion

Fast validation:

```bash
node tests/doctor-tests.mjs
node tests/live-roundtrip-acceptance-tests.mjs
npm run test:e2e
```

## Evidence Bundle Per Scenario

For every failed drill, capture:

- what failed
- failure category
- the smallest artifact or log fragment that proves it
- the next best recovery step

Preferred categories:

- `artifact_invalid`
- `timeout`
- `environment_mismatch`
- `verification_failed`
- `logic_bug`
- `unknown`

## Stop Rules

- Stop the lane immediately if it starts mutating unrelated hotspot files.
- Stop after two consecutive failures with the same unexplained root cause.
- If a lane requires the same hotspot file family as another active lane, sequence the work instead of parallelizing it.

## Related Docs

- [failure-injection-test-plan.md](failure-injection-test-plan.md)
- [next-round-execution-pack.md](next-round-execution-pack.md)
- [workspace-isolation-sop.zh-TW.md](workspace-isolation-sop.zh-TW.md)
