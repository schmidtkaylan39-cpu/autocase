# Contributing

This repository is intended to be operated as a release-gated multi-agent starter.
The codebase is already set up for cross-platform CI, example smoke checks, burn-in evidence, and hybrid runtime follow-up.

## Branch Model

Recommended steady-state branch layout:

- `main`
  Protected release branch for merges, tags, and published evidence.
- `codex/*`
  Implementation branches for executor-side work.
- other task branches as needed
  Planner, reviewer, or experimental work can use their own prefixes, but should merge back through a pull request.

## One-Time GitHub Bootstrap

For a newly created GitHub repository that only has a working branch:

1. Push the current green branch.
2. Create `main` from the current green tip.
3. Push `main` to origin.
4. In GitHub repository settings, switch the default branch to `main`.
5. Add branch protection rules for `main`.

Example commands:

```bash
git branch main
git push -u origin main
```

GitHub default-branch switching is a repository setting, so it must be done in the GitHub UI or an authenticated GitHub API client.

## Pull Request Expectations

Before asking for merge:

- CI must be green on Windows and Linux
- example smoke must be green on Windows and Linux
- the PR description should summarize user-visible behavior changes
- release evidence should be attached or summarized when the change affects delivery confidence

The repository already includes a PR template at `.github/pull_request_template.md`.

## Required Merge Checks

Recommended required checks for `main` protection:

- `Quality (ubuntu-latest)`
- `Quality (windows-latest)`
- `Example Smoke (ubuntu-latest)`
- `Example Smoke (windows-latest)`

`Release Readiness` is valuable release evidence, but because it includes soak behavior it is often better treated as a promotion gate rather than a required merge gate.

## Local Validation Baseline

Run this baseline before opening or updating a PR:

```bash
npm run validate:workflows
npm run build
npm run pack:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run doctor
```

For release candidates, also run:

```bash
npm run burnin
```

## Release Operator Notes

For a release candidate, keep these artifacts or summaries with the promotion decision:

- `reports/release-burnin-summary.json`
- `reports/runtime-doctor.json`
- `runs/<run-id>/handoffs/dispatch-results.json`
- `runs/<run-id>/run-state.json`
- `runs/<run-id>/report.md`

If a hybrid runtime such as Cursor encounters rate limits, timeout prompts, or transient server failures, use the existing retry path instead of force-marking the task complete:

```bash
node src/index.mjs retry runs/<run-id>/run-state.json <taskId> "request frequency too high, please retry later" 3
node src/index.mjs tick runs/<run-id>/run-state.json
```
