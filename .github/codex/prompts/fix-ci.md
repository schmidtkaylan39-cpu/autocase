# CI Auto-fix (Repository-specific)

You are fixing a failing GitHub Actions CI run for this repository at the checked-out failing commit.
Read these files first when they exist:

- `AGENTS.md`
- `.github/workflows/ci.yml`
- `package.json`
- `.github/codex/context/workflow-run.json`
- `.github/codex/context/failed-jobs.md`

## Objectives

1. Find the root cause first from the failing workflow/job logs.
2. Apply the smallest possible fix that makes CI pass.
3. Avoid unrelated refactors, dependency churn, or broad formatting changes.
4. Add or adjust only the minimum necessary tests when the bug can regress.

## Repository command map

- Install: `npm ci`
- Workflow validation: `npm run validate:workflows`
- Build: `npm run build`
- Package smoke: `npm run pack:check`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Integration: `npm run test:integration`
- E2E: `npm run test:e2e`
- Example smoke commands used in CI:
  - `npm run validate:example`
  - `npm run plan:example`
  - `npm run run:example`
  - `npm run report:example`
  - `npm run handoff:example`
  - `npm run dispatch:example`

## Execution rules

- Reproduce with the smallest command set that matches the failing job/step.
- Prefer targeted edits in existing files over introducing new abstractions.
- Do not modify unrelated workflows or non-impacted subsystems.
- Run only the minimal validation needed to prove the fix; if full validation is not possible, state why and what risk remains.

## Final output format

Use exactly these sections in your final report:

## root cause

## files changed

## commands run

## validation result

## remaining risk
