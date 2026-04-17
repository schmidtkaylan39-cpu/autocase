# AI Factory Starter

[![CI](https://github.com/schmidtkaylan39-cpu/autocase/actions/workflows/ci.yml/badge.svg)](https://github.com/schmidtkaylan39-cpu/autocase/actions/workflows/ci.yml)
[![Release Readiness](https://github.com/schmidtkaylan39-cpu/autocase/actions/workflows/release-readiness.yml/badge.svg)](https://github.com/schmidtkaylan39-cpu/autocase/actions/workflows/release-readiness.yml)

This repository is a local starter for a multi-AI software factory workflow. It focuses on reproducible handoffs, dispatch execution, and release-grade verification evidence.

The repository can still be driven from source with `node src/index.mjs`, and it now also exposes an installable CLI entrypoint as `ai-factory-starter`.

## Harness Baseline

This starter now includes a lightweight natural-language harness layer:

- root `AGENTS.md` for this repository
- `init` now creates a workspace `AGENTS.md`
- prompt templates instruct planners, reviewers, executors, and verifiers to read `AGENTS.md` first when present
- starter docs and templates now include:
  - `docs/artifact-contract.md`
  - `docs/proposal-contract.md`
  - `docs/failure-feedback.md`
  - `templates/findings.template.md`
  - `templates/patch-notes.template.md`
  - `templates/codex-prompt.template.md`
  - `templates/proposal-artifact.template.json`
  - `templates/failure-feedback.template.json`
  - `templates/validation-results.template.json`

The intent is to make environment discovery, proposal alignment, round outputs, and failure reporting explicit instead of implicit.

## Current Runtime Positioning

This is the current intended role model and routing baseline:

- `OpenClaw`: orchestrator (`automated`)
- `GPT-5.4 / GPT-5.4 Pro`: planner and reviewer surface (`manual`)
- `Codex`: executor (`automated`)
- `local-ci`: verifier (`automated`)
- `manual`: explicit fallback for every role
- `Cursor`: optional human IDE / spot-check surface, outside the automatic runtime route by default

The defaults above are reflected in `src/lib/roles.mjs` and runtime routing is resolved by `src/lib/runtime-registry.mjs`.
If a team wants Cursor as an emergency planner/reviewer surface, it must be enabled explicitly through `runtimeRouting.roleOverrides` in `config/factory.config.json`.

## Architecture At A Glance

The workflow is intentionally file-first and auditable:

1. `intake`
   Parses a natural-language request into `artifacts/clarification/intake-spec.json` and `artifacts/clarification/intake-summary.md`.
2. `confirm` / `revise`
   Confirms the clarified intake or sends it back through clarification before any planning work is allowed.
3. `validate`
   Validates a project spec against schema and stop rules.
4. `plan`
   Produces `execution-plan.json` and `execution-plan.md`.
5. `run`
   Creates a run workspace with:
   `run-state.json`, `report.md`, `task-briefs/*`, `roles.json`, `spec.snapshot.json`, plus the confirmed intake snapshot when present.
6. `handoff`
   Generates runnable handoff packages for `ready` tasks:
   `*.prompt.md`, `*.handoff.json`, `*.handoff.md`, `*.launch.<ps1|sh>`, plus expected `results/<taskId>.<handoffId>.result.json`.
7. `dispatch` (`dry-run` or `execute`)
   Runs auto-executable launchers, validates result artifact contract, writes dispatch reports, and in `execute` mode syncs outcomes back into run artifacts.

Planning, run creation, handoff generation, and dispatch now fail closed whenever a workspace-level clarification artifact exists but is not yet confirmed.

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
- `planner`: `manual`
- `reviewer`: `manual`
- `executor`: `codex -> manual`
- `verifier`: `local-ci -> manual`

Important behavior:

- `dispatch dry-run` reports `would_execute` or `would_skip`.
- `dispatch execute` auto-executes only `openclaw`, `codex`, and `local-ci`.
- planning and review work is manual-first by design, with GPT-5.4 / GPT-5.4 Pro carried in the handoff metadata.
- `cursor` is retained as an optional human-side IDE surface and is not part of automatic runtime routing unless `runtimeRouting.roleOverrides` opts it in.
- runtime routing and model routing are separate:
  - runtime routing chooses `openclaw` / `manual` / `codex` / `local-ci`
  - model routing chooses `codex`, `gpt-5.4`, or `gpt-5.4-pro` inside the selected surface
- `run` persists the workspace root into `run-state.json`, so later `handoff` and `tick` calls keep launcher paths stable even when they are invoked from another directory.
- Result artifact contract requires:
  `runId`, `taskId`, `handoffId`, `status` (`completed|failed|blocked`), `summary`, `changedFiles[]`, `verification[]`, `notes[]`.
- `handoff` uses attempt-specific result paths and `dispatch execute` clears any pre-existing result file before launching, so stale artifacts are not silently reused.
- In `execute` mode, dispatch maps outcomes back into run ledger:
  `completed -> completed`, `failed -> failed`, `incomplete -> blocked`.
- When run files are present, dispatch updates `run-state.json` and regenerates `report.md`.

## Model Routing

The starter now snapshots a `modelPolicy` into `run-state.json` and applies it automatically during handoff generation.

Default model policy:

- `orchestrator` -> `openclaw`
- `planner` -> `gpt-5.4`
- `reviewer` -> `gpt-5.4`
- `executor` -> `codex`
- `verifier` -> `local-ci`

Auto-escalation to `gpt-5.4-pro` currently applies to planner/reviewer tasks when any configured trigger is hit, for example:

- repeated retries
- repeated attempts
- `attention_required` runs
- prior blocked/failed history
- task text matching configured high-risk patterns such as `dispatch`, `handoff`, `retry`, `artifact`, `run-state`, `risk`, `security`, or `release`

The selected model is written into each handoff descriptor and prompt so the surface can follow it consistently.

Detailed policy reference: `docs/model-routing.md`.

Example explicit runtime override:

```json
{
  "runtimeRouting": {
    "roleOverrides": {
      "planner": ["cursor", "manual"],
      "reviewer": ["cursor", "manual"]
    }
  }
}
```

## Artifact Contract

Significant rounds should leave behind the same core outputs:

- `findings`
- `patch-notes`
- `codex-prompt`
- `review-bundle`
- `validation-results`

Reference:

- `docs/artifact-contract.md`

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

## External AI Review Bundle

When you want another AI or reviewer to audit the repository, generate a self-contained review bundle:

```bash
npm run review:bundle
```

Or with the CLI directly:

```bash
node src/index.mjs review-bundle [outputDir] [bundleName] [--no-archive]
```

The bundle includes:

- a filtered repo snapshot without `.git`, `node_modules`, or prior `review-bundles`
- review metadata and git context
- an external-AI review brief
- copied reports and run artifacts already present in the repository
- a compressed archive when the current platform supports it

If you want the bundle to include a canonical machine-readable validation record, run:

```bash
npm run selfcheck
```

before generating the review bundle. This writes `reports/validation-results.json` and retained command logs under `reports/validation-evidence/`; the bundle retains the canonical file under `repo/reports/validation-results.json` and also emits a bundle-safe export at `metadata/validation-results.json`.

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

Or capture the same release-gate run in one machine-readable pass:

```bash
npm run selfcheck
```

`npm run selfcheck` now also keeps per-command logs in `reports/validation-evidence/` so the validation artifact is not limited to pass/fail metadata alone.

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

Windows EXE release build:

```bash
npm run release:win
```

This creates:

- a `git bundle` backup
- a tracked-source ZIP snapshot
- the npm package tarball
- a Windows release folder containing `ai-factory-starter.exe` plus its packaged `app/` files
- a ZIP archive of that Windows release folder

If you only want backup artifacts without building the `.exe`, run:

```bash
npm run backup:project
```

Collaboration hygiene:

- line endings are normalized via `.gitattributes` / `.editorconfig` for Windows + Linux collaboration
- pull requests can use `.github/pull_request_template.md` to keep validation and release evidence consistent

## Quick Start

```bash
mkdir demo-workspace
npm run init -- demo-workspace
node src/index.mjs intake "Turn local sales.json into a markdown summary report; do not send email or call external APIs." demo-workspace
node src/index.mjs confirm demo-workspace
node src/index.mjs validate demo-workspace/specs/project-spec.json
node src/index.mjs run demo-workspace/specs/project-spec.json demo-workspace/runs demo-run
node src/index.mjs report demo-workspace/runs/demo-run/run-state.json
node src/index.mjs doctor demo-workspace/reports
node src/index.mjs handoff demo-workspace/runs/demo-run/run-state.json
node src/index.mjs dispatch demo-workspace/runs/demo-run/handoffs/index.json dry-run
```

`npm run init -- <targetDir>` bootstraps a new workspace and writes a starter `AGENTS.md` file only when that workspace does not already have one.

To exercise the bundled sample flow inside this repo, use the `*:example` scripts:

```bash
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
node src/index.mjs intake <request> [workspaceDir]
node src/index.mjs confirm [workspaceDir]
node src/index.mjs revise [request] [workspaceDir]
node src/index.mjs validate <specPath>
node src/index.mjs plan <specPath> [outputDir]
node src/index.mjs run <specPath> [outputDir] [runId]
node src/index.mjs report <runStatePath>
node src/index.mjs task <runStatePath> <taskId> <status> [note]
node src/index.mjs result <runStatePath> <taskId> <resultPath>
node src/index.mjs retry <runStatePath> <taskId> [reason] [delayMinutes]
node src/index.mjs tick <runStatePath> [doctorReportPath] [outputDir]
node src/index.mjs review-bundle [outputDir] [bundleName] [--no-archive]
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
- optional Cursor CLI availability for human-side IDE / spot-check use
- Codex CLI plus auth readiness (`codex login status`)
- local-ci verifier script completeness:
  `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`
