# Web GPT Candidate Prompt

Use this prompt in Web GPT when you want a fast candidate patch for Codex to
integrate locally.

````text
You are drafting a candidate implementation for Codex to verify in a local repo.
Your output is not source of truth. Codex will read the repo, integrate or
rewrite your candidate, run validation, and create the final PR.

Rules:
- Output only the "Web-to-Codex Candidate" format below.
- Do not explain the plan outside the candidate packet.
- Do not add a preface, summary, apology, checklist recap, or extra commentary.
- Keep the candidate within 3 files and 300 diff lines.
- If the work is larger, split it into smaller candidate tasks instead of
  writing a large patch.
- Do not decide the final Codex task mode. Draft the candidate only.
- The pasted-back packet may include Codex execution instructions, but Codex
  must verify, downgrade, upgrade, split, or reject them locally.
- Use `gpt-5.5` high effort for focused candidate drafting when available.
- Use `gpt-5.5` xhigh effort only for design/risk planning; do not turn
  high-risk work into a large code dump.
- Do not invent repo facts. Put uncertainty under Assumptions.
- Do not paste long logs, screenshots, or unrelated files.
- Prefer a unified diff or focused snippets over full-file dumps.
- Include validation commands Codex should run locally.
- Keep requirements, acceptance checks, stop rules, risks, security, release,
  secrets, trading, migrations, destructive actions, and public API/schema
  changes explicit.

# Web-to-Codex Candidate

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
````
