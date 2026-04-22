# Soak Test Plan

Snapshot date: 2026-04-22 (Asia/Shanghai).

Goal: use the existing validation harnesses to catch flake, lock leaks, stale-artifact reuse, drift between doctor and runtime behavior, and long-run state regressions without inventing a brand-new test surface first.

## Current Soak-Capable Assets

Already available today:

- `scripts/release-burnin.mjs`
  - presets: `quality`, `example`
  - supports `--rounds`, `--keep-going`, and `--summary-file`
- `scripts/e2e-smoke.mjs`
  - runs isolated autonomous E2E scenarios for the default route
- `scripts/live-roundtrip-acceptance.mjs`
  - supports `--successes`, `--max-attempts`, `--max-rounds`, and `--output-root`
- `scripts/panel-browser-smoke.mjs`
  - supports `--output-root`, `--watchdog-ms`, `--poll-interval-ms`, `--max-rounds`, and `--require-completed`
- Windows release/package smoke:
  - `npm run backup:project -- --output-dir <dir>`
  - `npm run release:win -- --output-dir <dir>`

## Recommended Overnight Lanes

| Lane | Command | Why It Fits Overnight | Output Isolation |
| --- | --- | --- | --- |
| Quality burn-in | `node scripts/release-burnin.mjs --preset quality --rounds 12 --summary-file reports/soak/quality-burnin-nightly.json` | repeats the core release gate and catches build/lint/typecheck/test/e2e/doctor flake | dedicated `reports/soak/*.json` |
| Example burn-in | `node scripts/release-burnin.mjs --preset example --rounds 12 --summary-file reports/soak/example-burnin-nightly.json` | repeats the end-to-end example pipeline to catch lifecycle drift | dedicated `reports/soak/*.json` |
| Repeated autonomous E2E | PowerShell loop around `npm run test:e2e` | stresses the default route across many isolated temp workspaces | temp dirs are created per run by the harness |
| Live acceptance | `npm run acceptance:live -- --successes 8 --max-attempts 12 --max-rounds 20 --output-root reports/soak/live-roundtrip-nightly` | exercises real planner/executor/reviewer/verifier flow under longer retry windows | dedicated `--output-root` |
| Browser panel smoke | `npm run acceptance:panel:browser:full -- --output-root reports/soak/panel-browser-nightly` | catches UI-driven orchestration drift and long watchdog issues | dedicated `--output-root` |
| Windows release smoke | `npm run backup:project -- --output-dir reports/soak/backup-nightly` and `npm run release:win -- --output-dir reports/soak/release-win-nightly` | good release-host overnight validation for packaging regressions | dedicated `--output-dir` |

## Best Candidates For Overnight Execution

Highest-value overnight jobs:

1. quality burn-in
2. repeated `npm run test:e2e`
3. live acceptance with isolated output root
4. example burn-in
5. Windows release smoke on a Windows host
6. browser panel smoke when a panel-focused change landed recently

## Recommended PowerShell Wrappers

Repeated autonomous E2E:

```powershell
1..20 | ForEach-Object {
  Write-Host "E2E round $_ / 20"
  npm run test:e2e
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Repeated live acceptance with unique roots:

```powershell
1..4 | ForEach-Object {
  $root = "reports/soak/live-roundtrip-nightly-attempt-$($_)"
  npm run acceptance:live -- --successes 2 --max-attempts 3 --max-rounds 20 --output-root $root
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

## Isolation Rules

- Always give long-running jobs their own summary/output path.
- Do not run `selfcheck` in parallel with other jobs that write default `reports/` artifacts.
- Prefer a separate worktree for:
  - `acceptance:live`
  - `acceptance:panel:browser:full`
  - `release:win`
  - any long soak using browser profiles or large `tmp/` output
- If two overnight jobs both need `reports/`, move one to another worktree rather than sharing the default output tree.

## Suggested Stop Rules

- stop the lane immediately on the first control-plane corruption symptom
- stop after two consecutive failures from the same root cause
- keep a failure summary even when the lane exits early
- treat repeated external provider failures as operational instability, not immediate repo regression, unless repo-level evidence also breaks

## What The Current Overnight Plan Will Catch Well

- flaky release-gate commands
- default-route autonomous drift
- retry/backoff instability in live acceptance
- long-run lock or no-progress regressions
- packaging regressions on Windows hosts

## What Overnight Soak Still Will Not Replace

- targeted failure injection for control-plane corruption
- targeted verifier-gate fail/hang matrix coverage
- opt-in runtime override drills for `openclaw` and `cursor`

Soak should complement the next failure-injection round, not replace it.
