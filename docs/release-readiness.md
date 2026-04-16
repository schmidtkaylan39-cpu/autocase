# Release Readiness

This document captures the current release baseline for the multi-AI software factory starter and what must be verified before go-live.

Snapshot date: 2026-04-16 (Asia/Shanghai).

## What Is Already Completed

- CLI command surface is in place and wired end-to-end:
  - `init`, `validate`, `plan`, `run`, `report`, `task`, `doctor`, `handoff`, `dispatch`
- Run lifecycle artifacts are generated and maintained:
  - `execution-plan.json`, `run-state.json`, `report.md`, task briefs, handoff descriptors, launchers
- Dispatch execute loopback is implemented:
  - launcher execution
  - result artifact schema validation
  - `run-state.json` sync (`completed`/`failed`/`blocked`)
  - `report.md` regeneration when run artifacts are present
- Tests cover dispatch execute outcomes (missing artifact, invalid artifact, valid artifact) and verify run-state/report sync.
- E2E smoke includes CLI-level `dispatch execute` synthetic validation.
- Local CI verifier contract is standardized on six required scripts:
  - `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`
- GitHub Actions CI baseline exists at `.github/workflows/ci.yml` and enforces build/lint/typecheck/tests plus example pipeline smoke.
- GitHub Actions CI uses Windows+Linux matrix in `.github/workflows/ci.yml`:
  - `quality-matrix`: `ubuntu-latest` and `windows-latest`
  - `example-smoke-matrix`: `ubuntu-latest` and `windows-latest`
- Release soak is split into `.github/workflows/release-readiness.yml` on `windows-latest`:
  - `burnin-soak`: high-duration repeated burn-in lane
  - `doctor-observability`: non-blocking runtime observability lane

## Required Pre-Release Checks

Run all commands from repository root:

```bash
npm run validate:workflows
npm run build
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run doctor
```

Run example pipeline smoke:

```bash
npm run validate:example
npm run plan:example
npm run run:example
npm run report:example
npm run handoff:example
npm run dispatch:example
```

Recommended release burn-in:

- execute the full check set above 3 consecutive times
- accept release only if there are no flaky failures

Recommended lane interpretation:

- Linux readiness: rely on CI matrix (`ubuntu-latest`) quality + example smoke jobs.
- Windows readiness: rely on CI matrix (`windows-latest`) quality + example smoke jobs.
- Windows soak confidence: rely on release-readiness `burnin-soak` for repeated long-run stability.

## External Non-Blocking Warnings

The following OpenClaw audit items are currently treated as non-blocking in this starter:

- `gateway.trusted_proxies_missing`
- `gateway.nodes.deny_commands_ineffective`

Observed runtime note that may appear together with healthy probe:

- `gatewayReachable: true` with `serviceRunning: false` can appear in doctor output; this is currently informational if RPC probe is healthy.

Why non-blocking for now:

- current workflow gates on CLI behavior and artifact contracts, not full OpenClaw deployment hardening
- these warnings do not currently prevent local orchestration and dispatch workflows from completing

## Design Choices (Not Bugs)

- `cursor` remains a hybrid planner/reviewer surface and is intentionally not auto-executed by `dispatch execute`.
- `dispatch` reports runtime artifact status `blocked` as dispatch result `incomplete`; during run-state sync it is mapped to task status `blocked`.
- `dispatch` does not auto-mark tasks `in_progress`; status progression is intentionally explicit.
- `doctor` validates runtime readiness and required script presence, not full task-completion capability of every runtime.
- `dispatch` does not infer semantic code quality from diffs or logs beyond launcher outcome and artifact schema contract.

## Go-Live Decision Rule

Starter can be considered release-ready when:

- all required checks pass
- example smoke passes
- CI matrix passes on both `ubuntu-latest` and `windows-latest`
- release-readiness Windows `burnin-soak` passes for the target round count
- dispatch execute loopback tests stay stable across repeated runs
- only the known external non-blocking warnings above remain
