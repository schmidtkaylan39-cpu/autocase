# External Gateway Incident SOP (502 Bad Gateway)

This SOP defines how to handle repeated external gateway failures such as:

- `unexpected status 502 Bad Gateway`
- errors routed through `api.tokenrouter.shop/responses`

Scope:

- multi-agent dispatch and sidecar-agent calls
- GPT/Codex surface requests that fail before repository logic executes

This SOP is for external routing instability, not for code-level regressions.

## Trigger Conditions

Start this SOP when any of the following is true:

1. Two or more `502 Bad Gateway` failures occur in one active round.
2. The same `502` appears across multiple agents within 10 minutes.
3. A failure includes a Cloudflare ray id (`cf-ray`) and upstream URL but no local stack trace tied to repository logic.

## Immediate Response

1. Do not block the critical path waiting for failed sidecar agents.
2. Continue mainline work locally and keep delivery moving.
3. Reduce parallel agent count immediately:
   - normal mode: up to 3 sidecar agents
   - incident mode: max 1-2 sidecar agents
4. Lower request complexity:
   - prefer `reasoning_effort: medium`
   - avoid large context fan-out while the incident is active

## Retry Policy (External 502)

Use bounded retry with backoff:

1. Retry after 30 seconds.
2. Retry after 60 seconds.
3. Retry after 90 seconds.
4. If still failing, stop sidecar retries for this round and continue local execution.

Do not loop indefinitely on external 502 retries.

## Fallback Execution Mode

If retries fail:

1. Close failed sidecar agents.
2. Execute required checks locally on main thread.
3. Mark sidecar failure category as `environment_mismatch` (or `timeout` if applicable).
4. Complete the round with local evidence rather than waiting on unstable upstream routes.

## Evidence Capture

For each incident burst, record:

- timestamp (UTC or local with timezone)
- failing URL host/path
- `cf-ray` id
- failing agent id (if available)
- operation that failed (spawn, wait, send_input)
- retry count and final fallback decision

Minimal capture is acceptable if it contains `cf-ray` and timestamp.

## Release-Readiness Interpretation

A gateway 502 is not a release blocker by itself when:

1. repository validation gates pass (`selfcheck`, tests, smoke checks), and
2. the failure is confirmed external to repository logic.

Treat it as operational risk and continue with package/release verification evidence.

## Escalation Threshold

Escalate to platform/operator support when either condition is met:

1. incident duration exceeds 30 minutes, or
2. three consecutive rounds cannot use sidecar agents due to external 502.

When escalating, include captured `cf-ray` ids and approximate failure windows.

## Exit Criteria

Leave incident mode when:

1. five consecutive external requests succeed, and
2. one small parallel sidecar run (2 agents max) succeeds without 502.

Then restore normal parallelism gradually.

## Standard Status Update Template

Use this concise status text during incident handling:

- "`External gateway 502 detected (not repo logic). Reduced agent concurrency, applied bounded retries, continued mainline locally, and captured cf-ray evidence.`"

