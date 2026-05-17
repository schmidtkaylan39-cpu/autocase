# Web-to-Codex Candidate

Use this when Web GPT drafts code or an approach before Codex integrates it
locally. The candidate is input, not source of truth.

## Objective

-

## Web GPT Draft Metadata

- Web GPT drafting model: `gpt-5.5`, high; fallback `gpt-5.4` if unavailable.

## Codex Execution Instructions

- Codex task mode: M
- Codex task state: candidate-ready
- Codex expected execution: `codex`, medium/high.

Codex must verify this mode locally. If the candidate exceeds 3 files, exceeds
300 diff lines, or touches high-risk areas, Codex must split or upgrade before
implementation.

## Files Likely Touched

-

## Candidate Patch Or Code

```text
Paste a focused candidate patch, snippet, or new file draft here.
Do not paste unrelated files or long logs.
```

## Assumptions

-

## Integration Risks

-

## Acceptance Checks

- [ ]

## Validation Commands

-

## Codex Must Verify Locally

-

## Size Limit

- Max 3 files.
- Max 300 diff lines.
- If larger, split into smaller candidates before Codex implementation.
