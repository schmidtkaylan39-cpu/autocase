# Failure Feedback Taxonomy

Agents perform better when failures are reported as structured feedback instead of vague or emotional text.

## Recommended Categories

- `rate_limit`
- `timeout`
- `missing_dependency`
- `environment_mismatch`
- `artifact_invalid`
- `verification_failed`
- `logic_bug`
- `unknown`

## Minimum Failure Record

Capture:

- the task or command that failed
- one category
- a short summary
- the smallest relevant evidence
- the next best recovery step
- whether retry is likely to help

An example starter file is included at:

- `templates/failure-feedback.template.json`

## Why This Helps

Structured failure feedback improves:

- retry decisions
- escalation decisions
- model-routing signals
- future memory compaction

It also avoids the quality drop that often comes from emotional or insulting feedback.

## Current Status In This Starter

This taxonomy is documented and templated.
It is not yet enforced as a strict machine-validated dispatch artifact.
