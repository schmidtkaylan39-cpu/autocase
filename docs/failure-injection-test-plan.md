# Failure Injection Test Plan

Snapshot date: 2026-04-22 (Asia/Shanghai).

For lane ownership, start order, and per-scenario operating rules, start with [failure-injection-playbook.md](failure-injection-playbook.md).

This plan assumes the repository already has strong direct coverage for:

- invalid/missing/mismatched result artifacts
- launcher timeouts and stale-result cleanup
- retry-budget and circuit-breaker behavior
- concurrent dispatch locking
- autonomous blocked-task recovery
- stale/orphaned lock recovery
- degraded no-progress handling
- baseline/timeout/`502`/interruption autonomous E2E scenarios

The plan below focuses only on failure modes that are still under-tested or not directly injected today.

## Priority Matrix

| ID | Priority | Failure Mode | Current Evidence | Gap To Close | Expected Outcome |
| --- | --- | --- | --- | --- | --- |
| FI-01 | P0 | `run-state.json` corruption or partial write | run-state transitions are heavily tested, but mostly with valid control-plane files | no direct test for truncated/zero-byte/half-written run-state during `tick`, `result`, `retry`, or autonomous reads | fail closed, classify as `artifact_invalid`, do not unlock downstream work, keep debug evidence |
| FI-02 | P0 | `handoffs/index.json` or `dispatch-results.json` corruption | result artifact validation is strong | control-plane handoff/dispatch files themselves are not directly fault-injected | fail closed with precise diagnostics and no stale task promotion |
| FI-03 | P0 | verifier/local-ci gate failure matrix | verifier happy path is covered; generic missing artifact cases exist | no direct matrix for per-gate fail/hang/no-artifact/late-artifact behavior | one authoritative outcome, no stale late artifact reuse, clear gate-specific notes |
| FI-04 | P0 | doctor false positive / runtime drift after doctor passes | doctor parity and readiness checks exist; planner preflight exists; e2e simulates some provider faults | no direct proof for expired auth, model denial, or provider drift between doctor and first task | bounded retry, `environment_mismatch` or `timeout`, no silent route confusion |
| FI-05 | P1 | cross-run shared-output contamination | workspace-isolation SOP exists | no direct injection where two long jobs share `reports/`, `tmp/`, or output roots | no stale evidence reuse; collision is detected or isolated |
| FI-06 | P1 | non-default runtime override failures | routing selection and skip semantics exist | `openclaw`, `cursor`, and delayed manual result application are not directly drilled end to end | clear fallback or blocked outcome without corrupting default-route state |
| FI-07 | P1 | Windows release/package path and file-lock failures | Windows release/package tests exist | long-path, locked-file, and repeated package stress failures are still thinner than default-route coverage | fail closed with actionable package/release diagnostics |

## Detailed Scenarios

## FI-01: Run-State Corruption

Inject:

- truncate `run-state.json` before `tick`
- write invalid JSON before `retry`
- write a zero-byte file before autonomous reads
- simulate partial overwrite while another process holds the file open

Validate:

- command exits non-zero
- failure category is `artifact_invalid`
- no task is silently promoted to `ready` or `completed`
- checkpoint/debug evidence remains readable if autonomous was active

Likely future files:

- `src/lib/run-state.mjs`
- `src/lib/commands.mjs`
- `tests/run-tests.mjs`
- `tests/autonomous-run-tests.mjs`

## FI-02: Handoff/Dispatch Control-Plane Corruption

Inject:

- truncate `handoffs/index.json`
- remove `launcherPath` or `resultPath` from one descriptor after generation
- corrupt `dispatch-results.json` before a later reader consumes it

Validate:

- `dispatch` fails fast with a control-plane diagnosis
- no descriptor is executed from a malformed index
- autonomous captures readable failure evidence rather than looping

Likely future files:

- `src/lib/dispatch.mjs`
- `src/lib/commands.mjs`
- `tests/dispatch-matrix-tests.mjs`
- `tests/autonomous-run-tests.mjs`

## FI-03: Verifier/Local-CI Failure Matrix

Inject:

- `build` fails
- `lint` fails
- `typecheck` hangs
- `test` exits non-zero without writing a result artifact
- `test:integration` writes a late artifact after timeout
- `test:e2e` writes an incomplete or stale artifact

Validate:

- verifier task status is correct for each case
- stale or late artifacts are ignored unless explicitly accepted by current rules
- report and run-state stay aligned
- failure-feedback records include the failing gate and retryability signal

Likely future files:

- `src/lib/handoffs.mjs`
- `src/lib/dispatch.mjs`
- `tests/dispatch-matrix-tests.mjs`
- `tests/run-tests.mjs`

## FI-04: Doctor-To-Runtime Drift

Inject:

- doctor reports `codex`/`gpt-runner` as ready
- first real planner/reviewer task fails due to expired login
- escalated model probe passes earlier, but actual execution later gets model-denied or quota-denied
- mix `429`, timeout, and `502` in the same acceptance run

Validate:

- failure classification stays consistent
- automatic retry stays bounded
- route fallback is explicit when it happens
- diagnostics preserve provider-facing evidence without pretending repo logic failed first

Likely future files:

- `src/lib/doctor.mjs`
- `src/lib/runtime-registry.mjs`
- `scripts/e2e-smoke.mjs`
- `tests/doctor-tests.mjs`
- `tests/live-roundtrip-acceptance-tests.mjs`

## FI-05: Shared Output Collision

Inject:

- run two long validations against the same `reports/` directory
- run two acceptances against the same `--output-root`
- reuse a previous run directory or browser profile intentionally

Validate:

- evidence is isolated or the collision is detected immediately
- summary files do not silently merge unrelated attempts
- operator guidance points back to the workspace-isolation SOP

Likely future files:

- `scripts/live-roundtrip-acceptance.mjs`
- `scripts/panel-browser-smoke.mjs`
- `scripts/release-burnin.mjs`
- `docs/workspace-isolation-sop.zh-TW.md`

## FI-06: Non-Default Runtime Route Failures

Inject:

- force planner/reviewer to `cursor` and omit the result artifact
- force orchestrator to `openclaw` and return a blocked/incomplete artifact
- apply a delayed manual result artifact after the original handoff has aged

Validate:

- default-route tasks are not mutated by foreign or stale follow-up
- fallback remains explicit
- docs and runtime routing stay aligned

Likely future files:

- `src/lib/runtime-registry.mjs`
- `src/lib/handoffs.mjs`
- `tests/runtime-registry-tests.mjs`
- `tests/dispatch-matrix-tests.mjs`

## FI-07: Windows Release/Package Edge Cases

Inject:

- long path output directories
- spaces and non-ASCII in release output paths
- locked target files during packaging
- repeated `release:win` against the same destination root

Validate:

- package/release scripts fail with actionable evidence
- release manifests stay correct
- no stale archive or manifest is mistaken for the current run

Likely future files:

- `scripts/release-windows-exe.mjs`
- `tests/release-windows-exe-tests.mjs`

## Recommended Order

1. FI-01 and FI-02 together
2. FI-03
3. FI-04
4. FI-05
5. FI-06
6. FI-07

That ordering keeps the next round anchored on the default route and the highest-risk shared state before expanding into opt-in surfaces.
