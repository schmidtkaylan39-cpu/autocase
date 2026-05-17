## Summary

- Adds a small documentation note for the AI collaboration guide.

## Issue / Objective

- Closes: #123
- Task mode: S
- Task state: review-ready
- Objective: Add a short note that points operators to the Web-to-Codex candidate template.
- Acceptance checks:
  - [x] Documentation note is present.
  - [x] No source files are changed.

## AI Execution Notes

- Agent/runtime used: Codex local
- Model/effort used: Codex executor `codex`, medium
- Fallback model used: No fallback model used.
- Files intentionally changed: `docs/ai-collaboration-workflow.md`
- Files intentionally not touched: source files, tests, package metadata, and generated artifacts
- Stop rules or constraints honored: no secrets, no unrelated workspace cleanup, no broad refactor

## Validation

- [ ] `npm run validate:workflows`
- [ ] `npm run build`
- [ ] `npm run pack:check`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:e2e`
- [x] Other: `git diff --check -- docs/ai-collaboration-workflow.md`
- [x] Skipped checks explained below

## Validation Evidence

- Commands run: `git diff --check -- docs/ai-collaboration-workflow.md`
- Result: passed
- Skipped checks and reason: broader build, lint, typecheck, and test skipped because this is a docs-only S-mode example.

## Release Evidence

- [ ] `reports/release-burnin-summary.json` attached or summarized
- [ ] `reports/runtime-doctor.json` attached or summarized when relevant
- [ ] example smoke outcome summarized
- [x] Not release-impacting

## Risk / Handoff

- Cross-platform impact: none expected
- External warnings or non-blocking follow-ups: No external warnings.
- Next conversation should know: this is a filled PR body example for local PR readiness dry-runs
