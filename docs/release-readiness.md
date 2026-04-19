# Release Readiness

This document captures the current release baseline for the multi-AI software factory starter and what must be verified before go-live.

Snapshot date: 2026-04-18 (Asia/Shanghai).

## What Is Already Completed

- CLI command surface is in place and wired end-to-end:
  - `init`, `intake`, `confirm`, `revise`, `validate`, `plan`, `run`, `report`, `task`, `result`, `retry`, `tick`, `doctor`, `handoff`, `dispatch`, `autonomous`, `review-bundle`
- Clarification gate is now enforced ahead of planning and execution:
  - workspace-level `artifacts/clarification/intake-spec.json`
  - workspace-level `artifacts/clarification/intake-summary.md`
  - fail-closed blocking on `plan`, `run`, `handoff`, `dispatch`, `task update`, `retry`, `tick`, and result application until confirmation
- Run lifecycle artifacts are generated and maintained:
  - `execution-plan.json`, `run-state.json`, `report.md`, task briefs, handoff descriptors, launchers
- Dispatch execute loopback is implemented:
  - launcher execution
  - result artifact schema validation
  - `run-state.json` sync (`completed`/`failed`/`blocked`, plus `continued` when a valid automation decision is applied)
  - `report.md` regeneration when run artifacts are present
- Tests cover dispatch execute outcomes (missing artifact, invalid artifact, valid artifact, automated continuation decisions, generated `gpt-runner` launchers, and generated `local-ci` verifier launchers) and verify run-state/report sync.
- E2E smoke now exercises the real `autonomous` CLI route in an isolated workspace with a fake Codex surface and fixture local-ci scripts, including deterministic fault drills:
  - baseline roundtrip
  - timeout recovery
  - injected `502 Bad Gateway` recovery
  - interruption recovery from stale in-progress execution locks
- Packaged CLI installability is covered by `npm run pack:check`, which validates tarball contents and executes the installed binary.
- Packaged Windows acceptance smoke script now supports a self-contained autonomous EXE pass with fixture Codex and fixture local-ci scripts.
- Local CI verifier contract is standardized on six required scripts:
  - `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`
- GitHub Actions CI baseline exists at `.github/workflows/ci.yml` and enforces build/lint/typecheck/tests plus example pipeline smoke.
- GitHub Actions CI uses Windows+Linux matrix in `.github/workflows/ci.yml`:
  - `quality-matrix`: `ubuntu-latest` and `windows-latest`
  - `example-smoke-matrix`: `ubuntu-latest` and `windows-latest`
- Release readiness is split across `.github/workflows/release-readiness.yml`:
  - `quick-readiness`: `ubuntu-latest` + `windows-latest` release gate with Windows packaging smoke
  - `burnin-soak`: high-duration repeated burn-in lane
  - `doctor-observability`: non-blocking runtime observability lane

## Required Pre-Release Checks

Run all commands from repository root:

```bash
npm run validate:workflows
npm run build
npm run pack:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run doctor
```

`npm run validate:workflows` is also a semantic guard for `.github/workflows/release-readiness.yml` and fails if Windows `backup:project` or `release:win` smoke commands are missing (or not Windows-scoped).
`npm run test:e2e` is the autonomous CLI canary and should stay green whenever `autonomous` handoff/tick/dispatch behavior changes. It now runs baseline plus timeout/502/interruption fault-injection scenarios.

On a Windows release host, also run packaging smoke:

```bash
npm run backup:project -- --output-dir reports/release-readiness/backup-smoke
npm run release:win -- --output-dir reports/release-readiness/windows-release-smoke
```

Recommended staged canary with SLO guardrails and a rollback hook:

```bash
npm run rollout:progressive -- --run-command "npm run test:e2e" --phase canary:5:2 --phase ramp:20:3 --phase full:100:3 --min-success-rate 0.95 --max-failure-count 0 --max-consecutive-failures 1 --rollback-command "<host-specific rollback command>" --summary-file reports/release-readiness/progressive-rollout-summary.json
```

Replace `<host-specific rollback command>` with the environment-specific promotion revert or traffic rollback command before using this gate for a live release.

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
- Windows readiness: rely on CI matrix (`windows-latest`) quality + example smoke jobs, plus the release-readiness backup smoke path and full `release:win` smoke path.
- Windows soak confidence: rely on release-readiness `burnin-soak` for repeated long-run stability.

Review bundle note:

- the exported review bundle carries source plus validation evidence, not an already installed `node_modules` tree
- external reviewers who want to rerun repo-level checks from `repo/` should run `npm ci` first
- `review-bundle` now fails closed on dirty worktrees by default; use `--allow-dirty` only when you intentionally need a dirty snapshot
- publish rounds should retain a lightweight in-repo release evidence artifact at `docs/releases/vX.Y.Z.evidence.json`

Published release note:

- after a release is published, keep a lightweight in-repo evidence artifact under `docs/releases/<tag>.evidence.json`
- that artifact should record the published release URL, asset download URLs, asset hashes, and the validation summary captured at promotion time

## External Non-Blocking Warnings

In the default autonomous GPT-5.4 + Codex route, OpenClaw is optional. The following OpenClaw audit items are therefore treated as non-blocking unless a team explicitly routes orchestration to OpenClaw:

- `gateway.trusted_proxies_missing`
- `gateway.nodes.deny_commands_ineffective`

Observed runtime note that may appear together with healthy probe:

- `gatewayReachable: true` with `serviceRunning: false` can appear in doctor output; this is currently informational if RPC probe is healthy.

Why non-blocking for now:

- current default workflow gates on gpt-runner/Codex/local-ci readiness plus CLI behavior and artifact contracts, not full OpenClaw deployment hardening
- these warnings do not currently prevent local orchestration and dispatch workflows from completing

## Design Choices (Not Bugs)

- planner/reviewer/orchestrator work now defaults to `gpt-runner`, which executes `gpt-5.4` / `gpt-5.4-pro` through Codex CLI; Cursor is retained only as an auxiliary human IDE / spot-check surface.
- `dispatch` reports runtime artifact status `blocked` as dispatch result `incomplete` unless a valid `automationDecision` is present, in which case it reports `continued`; during run-state sync it either maps to task status `blocked` or applies the requested retry/rework/replan transition.
- `dispatch execute` claims auto-executable tasks as `in_progress` before launcher execution begins.
- `doctor` validates runtime readiness and required script presence; packaged acceptance and autonomous E2E smoke provide the higher-level proof that those runtimes can complete tasks end-to-end.
- `dispatch` does not infer semantic code quality from diffs or logs beyond launcher outcome and artifact schema contract.

## Go-Live Decision Rule

Starter can be considered release-ready when:

- all required checks pass
- example smoke passes
- CI matrix passes on both `ubuntu-latest` and `windows-latest`
- release-readiness Windows `burnin-soak` passes for the target round count
- dispatch execute loopback tests stay stable across repeated runs
- only the known external non-blocking warnings above remain
