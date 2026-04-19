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

`autonomous` now emits failure-learning artifacts automatically when dispatch produces failed/incomplete/continued outcomes:

- `runs/<run-id>/artifacts/failure-feedback/failure-feedback-index.json`
- `runs/<run-id>/artifacts/failure-feedback/generated-test-cases.json`
- one per-failure JSON artifact under `runs/<run-id>/artifacts/failure-feedback/*.json`

The generated test-case artifact is intended as a direct feed for adding targeted regression coverage in future rounds.
