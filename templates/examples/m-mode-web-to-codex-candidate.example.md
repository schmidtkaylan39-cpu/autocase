# M-Mode Example: Web-to-Codex Candidate

## Objective

- Add a small PR readiness check for a new non-risk field.

## Task Mode

- M

## Task State

- candidate-ready

## Model / Effort Used

- Web GPT drafting: `gpt-5.5`, high (`高`); fallback `gpt-5.4` if unavailable.
- Codex expected execution: `codex`, high (`高`) because checker logic and tests are touched.

## Files Likely Touched

- `scripts/check-pr-readiness.mjs`
- `tests/pr-readiness-check-tests.mjs`
- `.github/pull_request_template.md`

## Candidate Patch Or Code

```text
Candidate should be a focused unified diff or small snippets.
Keep under 3 files and 300 diff lines.
```

## Assumptions

- Existing parser reads second-level Markdown sections.
- No workflow behavior changes are required.

## Integration Risks

- The checker may reject existing PR bodies until the PR template is updated.

## Acceptance Checks

- [ ] PR body checker accepts a complete body with the new field.
- [ ] PR body checker rejects a missing or invalid field.

## Validation Commands

- `node tests/pr-readiness-check-tests.mjs`
- `npx eslint scripts/check-pr-readiness.mjs tests/pr-readiness-check-tests.mjs`

## Codex Must Verify Locally

- The candidate follows existing checker style.
- Error messages are clear enough for a human to repair the PR body.

## Size Limit

- Max 3 files.
- Max 300 diff lines.
- If larger, split into smaller candidates before Codex implementation.
