# Model Routing

## Purpose

This starter now separates:

- runtime routing
- model routing

Runtime routing decides which tool or surface handles the task.
Model routing decides which model should be preferred inside that surface.

## Default Usage Matrix

| Task role | Runtime | Default model | Escalated model | Typical use |
| --- | --- | --- | --- | --- |
| orchestrator | `manual` primary | `gpt-5.4` | none | delivery coordination, retries, dispatch/risk-stop decisions |
| planner | `manual` primary | `gpt-5.4` | `gpt-5.4-pro` | requirement breakdown, sequencing, clarification |
| reviewer | `manual` primary | `gpt-5.4` | `gpt-5.4-pro` | review, risk analysis, finding hidden issues |
| executor | `codex` | `codex` | none | implementation, bug fixing, integration |
| verifier | `local-ci` | `local-ci` | none | build, lint, typecheck, tests |

## Auto-Escalation Rules

Planner or reviewer work is automatically escalated from `gpt-5.4` to `gpt-5.4-pro` when configured signals are hit.

Current default signals:

- `retryCount >= 2`
- `attempts >= 2`
- run status is `attention_required`
- task notes show prior blocked history
- task notes show prior dispatch failure history
- task id is in `modelPolicy.escalation.forceProTaskIds`
- task text matches one of the configured high-risk patterns

Default high-risk patterns:

- `dispatch`
- `handoff`
- `retry`
- `artifact`
- `run-state`
- `risk`
- `security`
- `release`

## What Is Automatic Today

Automatic today:

- `handoff` chooses the preferred model automatically
- the chosen model is written into:
  - `run-state.json` snapshot via `modelPolicy`
  - each handoff descriptor
  - each prompt document
  - launcher guidance for manual or automated surfaces

Not automatic today:

- the system does not call the OpenAI HTTP API directly; it uses Codex CLI as the automated GPT runner surface
- external approval-bound actions may still require human checkpoints even when the task runtime is automated

## Cursor Position

`cursor` remains available as an auxiliary human IDE or spot-check surface, but it is no longer
part of automatic planner/reviewer runtime routing in this starter.

If you need Cursor as an explicit fallback surface for planning or review, enable it through
`runtimeRouting.roleOverrides` in `config/factory.config.json`. That keeps Cursor usage intentional and testable while the default route stays on the automated GPT runner.

## OpenClaw Position

`openclaw` remains supported, but it is treated as an optional orchestrator adapter in the
default GPT-5.4 + Codex operating route.

If a team wants OpenClaw to handle orchestrator tasks automatically, it can be opted in through
`runtimeRouting.roleOverrides` (for example, `orchestrator: ["openclaw", "manual"]`).

## Configuration

The policy lives in `config/factory.config.json` under `modelPolicy`.

You can override:

- per-role default model
- per-role escalated model
- whether a role auto-switches
- escalation thresholds
- forced task ids
- forced text-pattern triggers

## Recommended Operating Pattern

Use the default routing unless there is a clear reason to escalate.

- `Codex` should stay the main executor and integrator.
- `gpt-5.4` should be the default planning/review model.
- `gpt-5.4-pro` should be reserved for higher-cost, higher-risk review or re-planning work.
