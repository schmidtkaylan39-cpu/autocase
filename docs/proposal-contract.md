# Proposal Contract

Proposal contracts are a lightweight harness layer for planning and review work.

Use them when a task is:

- ambiguous
- high-risk
- spread across multiple files
- likely to need reviewer alignment before implementation

## Goal

Align planner, reviewer, and executor before wide changes happen.

This reduces the common failure mode where implementation and evaluation disagree
only after a large patch has already been written.

## Recommended Shape

Use a short structured artifact with these fields:

- `objective`
- `assumptions`
- `likelyTouchedFiles`
- `acceptanceChecks`
- `majorRisks`
- `openQuestions`

An example starter file is included at:

- `templates/proposal-artifact.template.json`

## When To Use It

- before broad refactors
- before touching `dispatch`, `run-state`, `handoff`, `retry`, or artifact contracts
- before release hardening changes
- when reviewer and executor need an explicit agreement on success criteria

## Minimum Good Proposal

A good proposal contract is short, specific, and falsifiable.

Bad:

- "Fix the bug and test it."

Good:

- objective: "Prevent stale artifacts from completing the wrong task."
- likelyTouchedFiles: `src/lib/dispatch.mjs`, `tests/dispatch-matrix-tests.mjs`
- acceptanceChecks: `npm test`
- majorRisks: "concurrent dispatch regression"

## Current Status In This Starter

This repository documents the proposal contract and includes starter templates.
It is not yet enforced as a first-class CLI artifact.
