# Artifact Contract

This starter now treats round outputs as a lightweight first-class contract.

Every meaningful cycle should leave behind the same core artifacts:

- `findings`
- `patch-notes`
- `codex-prompt`
- `review-bundle`
- `validation-results`

These are not all machine-enforced yet, but they are the expected handoff surface
for planners, reviewers, executors, and release reviewers.

## Why This Exists

Without a consistent artifact set:

- findings drift in format
- patch notes omit context
- Codex gets inconsistent execution prompts
- review bundles lose important review targets
- validation evidence becomes hard to compare across rounds

The goal is to keep every loop legible and auditable.

## Required Artifact Intent

### Findings

What was found, why it matters, and what should be fixed.

Recommended fields:

- severity
- file path
- concise explanation
- why it matters
- suggested fix

Starter template:

- `templates/findings.template.md`

### Patch Notes

What changed in this round, why it changed, and what evidence should be read with it.

Starter template:

- `templates/patch-notes.template.md`

### Codex Prompt

The execution-ready prompt or instruction set handed to Codex for the next patching pass.

Starter template:

- `templates/codex-prompt.template.md`

### Review Bundle

A self-contained bundle for an external reviewer or model.

It should include:

- repo snapshot
- patch notes
- review brief
- review prompt
- manifest
- source-file list
- relevant reports and run artifacts

### Validation Results

The runnable evidence for whether the round actually passed.

Recommended fields:

- command
- status
- startedAt
- finishedAt
- durationMs
- evidence

Starter template:

- `templates/validation-results.template.json`

## Recommended Phase Mapping

The current workflow is best understood as:

1. `intake`
2. `analyze`
3. `patch`
4. `validate`
5. `review`
6. `bundle`
7. `accept` / `retry` / `block`

The artifact contract should make those transitions visible even when different
models or humans handle different phases.

## Current Status In This Starter

This repository now documents the artifact contract and includes starter templates.
It is only partially enforced by CLI behavior today.
