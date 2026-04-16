# AI Factory Starter

[![CI](https://github.com/schmidtkaylan39-cpu/autocase/actions/workflows/ci.yml/badge.svg)](https://github.com/schmidtkaylan39-cpu/autocase/actions/workflows/ci.yml)
[![Release Readiness](https://github.com/schmidtkaylan39-cpu/autocase/actions/workflows/release-readiness.yml/badge.svg)](https://github.com/schmidtkaylan39-cpu/autocase/actions/workflows/release-readiness.yml)

This repository is a local starter for a multi-AI software factory workflow. It focuses on reproducible handoffs, dispatch execution, and release-grade verification evidence.

The repository can still be driven from source with `node src/index.mjs`, and it now also exposes an installable CLI entrypoint as `ai-factory-starter`.

## Current Runtime Positioning

This is the current intended role model and routing baseline:

- `OpenClaw`: orchestrator (`automated`)
- `Cursor`: planner and reviewer surface (`hybrid`)
- `Codex`: executor (`automated`)
- `local-ci`: verifier (`automated`)
- `manual`: explicit fallback for every role

The defaults above are reflected in `src/lib/roles.mjs` and runtime routing is resolved by `src/lib/runtime-registry.mjs`.

## Architecture At A Glance

The workflow is intentionally file-first and auditable:

1. `validate`
   Validates a project spec against schema and stop rules.
2. `plan`
   Produces `execution-plan.json` and `execution-plan.md`.
3. `run`
   Creates a run workspace with:
   `run-state.json`, `report.md`, `task-briefs/*`, `roles.json`, `spec.snapshot.json`.
4. `handoff`
   Generates runnable handoff packages for `ready` tasks:
   `*.prompt.md`, `*.handoff.json`, `*.handoff.md`, `*.launch.ps1`, plus expected `results/*.result.json`.
5. `dispatch` (`dry-run` or `execute`)
   Runs auto-executable launchers, validates result artifact contract, writes dispatch reports, and in `execute` mode syncs outcomes back into run artifacts.

Core run ledger:

- `planning-brief`
- `implement-*`
- `review-*`
- `verify-*`
- `delivery-package`

Dependencies unlock through `refreshRunState()` based on upstream `completed` status.

## Runtime Routing And Dispatch Behavior

Runtime selection is role-based and doctor-aware. Current preferences:

- `orchestrator`: `openclaw -> manual`
- `planner`: `cursor -> manual`
- `reviewer`: `cursor -> manual`
- `executor`: `codex -> manual`
- `verifier`: `local-ci -> manual`

Important behavior:

- `dispatch dry-run` reports `would_execute` or `would_skip`.
- `dispatch execute` auto-executes only `openclaw`, `codex`, and `local-ci`.
- `cursor` remains hybrid by design and is currently not auto-executed by dispatch.
- `run` persists the workspace root into `run-state.json`, so later `handoff` and `tick` calls keep launcher paths stable even when they are invoked from another directory.
- Result artifact contract requires:
  `status` (`completed|failed|blocked`), `summary`, `changedFiles[]`, `verification[]`, `notes[]`.
- In `execute` mode, dispatch maps outcomes back into run ledger:
  `completed -> completed`, `failed -> failed`, `incomplete -> blocked`.
- When run files are present, dispatch updates `run-state.json` and regenerates `report.md`.

## GitHub Governance

Recommended steady state for a published repo:

- protect `main` as the release branch
- keep agent work on `codex/*` or other task branches
- require the four CI checks from `.github/workflows/ci.yml` before merge
- use `.github/pull_request_template.md` plus release-readiness evidence for promotions

One-time bootstrap for a fresh remote:

1. Push the current green working branch.
2. Create and push `main` from that green commit.
3. In GitHub settings, switch the default branch to `main`.
4. Add branch protection for `main`.

The detailed contributor and operator flow is documented in `CONTRIBUTING.md`.

## Release Verification (Delivery Baseline)

Use this as the minimum release gate before promoting changes.

Cross-platform split:

- Linux and Windows readiness are enforced in CI matrix (`.github/workflows/ci.yml`) for both quality checks and example smoke.
- Windows soak is enforced in release-readiness workflow (`.github/workflows/release-readiness.yml`) as the long-run burn-in lane.

Baseline command set:

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

For release-candidate burn-in (3 consecutive rounds):

```bash
npm run burnin
```

`npm run burnin` runs build/lint/typecheck/test/integration/e2e/doctor in 3 rounds and writes summary evidence to `reports/release-burnin-summary.json`.

`npm run pack:check` creates a tarball, installs it into a temporary workspace, and verifies that the packaged `ai-factory-starter` binary can run `--help`, `--version`, `init`, and `validate`.

CI matrix and soak role split:

- `CI / quality-matrix (ubuntu-latest, windows-latest)`: build, lint, typecheck, test, e2e.
- `CI / quality-matrix (ubuntu-latest, windows-latest)`: workflow validation, build, lint, typecheck, test, e2e.
- `CI / example-smoke-matrix (ubuntu-latest, windows-latest)`: validate/plan/run/report/handoff/dispatch example flow.
- `Release Readiness / burnin-soak (windows-latest)`: repeated full burn-in + example pipeline soak for release confidence.
- `Release Readiness / doctor-observability (windows-latest, non-blocking)`: runtime telemetry and external dependency visibility.

Recommended release evidence to keep with the candidate:

- `reports/release-burnin-summary.json`
- `reports/runtime-doctor.json`
- `runs/<run-id>/handoffs/dispatch-results.json`
- `runs/<run-id>/run-state.json`
- `runs/<run-id>/report.md`

Collaboration hygiene:

- line endings are normalized via `.gitattributes` / `.editorconfig` for Windows + Linux collaboration
- pull requests can use `.github/pull_request_template.md` to keep validation and release evidence consistent

## Quick Start

```bash
npm run init
npm run validate:example
npm run plan:example
npm run run:example
npm run report:example
npm run doctor
npm run handoff:example
npm run dispatch:example
npm test
```

Installed CLI usage:

```bash
ai-factory-starter --help
ai-factory-starter --version
```

To test full dispatch loop on a run:

```bash
node src/index.mjs dispatch runs/example-run/handoffs/index.json execute
```

## CLI Commands

```bash
node src/index.mjs init [targetDir]
node src/index.mjs validate <specPath>
node src/index.mjs plan <specPath> [outputDir]
  node src/index.mjs run <specPath> [outputDir] [runId]
  node src/index.mjs report <runStatePath>
  node src/index.mjs task <runStatePath> <taskId> <status> [note]
  node src/index.mjs result <runStatePath> <taskId> <resultPath>
  node src/index.mjs retry <runStatePath> <taskId> [reason] [delayMinutes]
  node src/index.mjs tick <runStatePath> [doctorReportPath] [outputDir]
  node src/index.mjs doctor [outputDir]
  node src/index.mjs handoff <runStatePath> [outputDir] [doctorReportPath]
  node src/index.mjs dispatch <handoffIndexPath> [dry-run|execute]
```

## Repository Layout

- `src/`: CLI and runtime/workflow implementation.
- `config/`: factory role and gate configuration.
- `prompts/`: role prompt templates.
- `examples/`: runnable sample specs.
- `templates/`: intake and policy templates.
- `docs/`: architecture and lifecycle details.
- `scripts/`: smoke, burn-in, and utility scripts.
- `tests/`: unit/integration-style command tests.

## Runtime Health Notes

`doctor` writes:

- `reports/runtime-doctor.json`
- `reports/runtime-doctor.md`

Checks include:

- OpenClaw command presence, gateway reachability, and service/runtime signals
- Cursor CLI availability
- Codex CLI plus auth readiness (`codex login status`)
- local-ci verifier script completeness:
  `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`
