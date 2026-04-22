# Soak Test Operating Checklist

Snapshot date: 2026-04-22 (Asia/Shanghai).

Use this checklist before starting any overnight or repeated long-run validation lane.

## Before You Start

- Run the soak in a dedicated validation worktree if it writes `reports/`, `tmp/`, browser profiles, or release output.
- Use unique output paths for every lane:
  - `--output-root`
  - `--output-dir`
  - `--summary-file`
- Make sure the doctor report is fresh enough to be meaningful for that session.
- If the lane depends on a run, confirm the target `run-id` and `run-state.json` first.
- If the lane uses `autonomous`, set `maxRounds` explicitly instead of relying on the default `20`.
- Keep stdout/stderr in shell or CI logs; do not rely on Markdown summaries alone.

## Recommended Lanes

| Lane | Command | Use when | Isolation requirement |
| --- | --- | --- | --- |
| Quality burn-in | `node scripts/release-burnin.mjs --preset quality --rounds 12 --summary-file reports/soak/quality-burnin-nightly.json` | release-gate flake hunting | dedicated summary file |
| Example burn-in | `node scripts/release-burnin.mjs --preset example --rounds 12 --summary-file reports/soak/example-burnin-nightly.json` | lifecycle/example pipeline drift hunting | dedicated summary file |
| Repeated autonomous E2E | repeated `npm run test:e2e` loop | default-route regression hunting | harness temp dirs stay isolated |
| Live acceptance | `npm run acceptance:live -- --successes 8 --max-attempts 12 --max-rounds 20 --output-root reports/soak/live-roundtrip-nightly` | real planner/executor/reviewer/verifier drift | dedicated output root |
| Browser panel smoke | `npm run acceptance:panel:browser:full -- --output-root reports/soak/panel-browser-nightly` | panel-driven orchestration smoke after panel-adjacent change | dedicated output root |
| Windows release smoke | `npm run backup:project -- --output-dir reports/soak/backup-nightly` and `npm run release:win -- --output-dir reports/soak/release-win-nightly` | Windows packaging confidence | dedicated output dir |

## Do Not Mix In Parallel

- `npm run selfcheck`
- anything that overwrites `reports/runtime-doctor.json`
- anything that overwrites `reports/validation-results.json`
- two acceptances that share the same `--output-root`
- development edits in the same worktree as an overnight soak lane

## During The Run

- Treat `report.md` as a convenience view only.
- If the lane uses autonomous output, prefer this inspection order:
  1. `autonomous-summary.md`
  2. `artifacts/autonomous-debug/terminal-summary.json`
  3. `artifacts/autonomous-debug/checkpoint.json`
  4. `handoffs*/dispatch-results.json`
  5. `run-state.json`
- If the lane uses burn-in or acceptance summaries, keep the raw JSON summary alongside the human-readable output.

## Stop Rules

- Stop immediately on any control-plane corruption symptom.
- Stop after two consecutive failures from the same root cause.
- Stop and isolate if evidence suggests shared-output contamination.
- Treat repeated provider-side failures as operational instability first, unless repo-level evidence also breaks.

## Morning Triage

Read in this order:

1. terminal summary or soak summary JSON
2. checkpoint/resume data when autonomous was involved
3. dispatch results
4. run-state
5. doctor report
6. failure-feedback index when present

Key interpretation rule:

- `blocked` means inspection is required before the next autonomous pass
- `exhausted` usually means the session budget ended while more work remained
- `done` means the run is complete, not merely that the last loop stopped cleanly

## Related Docs

- [soak-test-plan.md](soak-test-plan.md)
- [24h-autonomous-ops-runbook.md](24h-autonomous-ops-runbook.md)
- [workspace-isolation-sop.zh-TW.md](workspace-isolation-sop.zh-TW.md)
