# Runtime Doctor

`doctor` creates a runtime readiness report for the current workspace and writes:

- `reports/runtime-doctor.json`
- `reports/runtime-doctor.md`

The implementation lives in `src/lib/doctor.mjs`.

## What The Command Does

The doctor runs four checks in sequence:

1. OpenClaw
2. Cursor (optional surface)
3. Codex
4. Local CI

Each check records whether the runtime is installed, whether it is considered ready,
which command path was resolved, and any extra details or diagnostics.

For automated runtimes that rely on generated launchers (`openclaw`, `codex`, and `local-ci`),
doctor also checks whether the platform launcher shell is available:

- `powershell.exe` on Windows
- `bash` on Linux/macOS (or `AI_FACTORY_LAUNCHER_SHELL_COMMAND` when explicitly overridden)

If that launcher shell is unavailable, the runtime is marked `ok: false` even when the tool itself is installed.

## Command Resolution

On Windows, command resolution uses:

- `Get-Command <name>`

On non-Windows platforms, command resolution uses:

- `which <name>`

If a command cannot be resolved, the runtime is marked `installed: false` and
`ok: false`.

## OpenClaw Check

The OpenClaw check currently does more than a version probe.

It resolves the `openclaw` command and then runs:

- `openclaw --version`
- `openclaw gateway status`
- `openclaw security audit`

The runtime is considered ready when the gateway output matches either:

- `RPC probe: ok`
- `Gateway: reachable`

Important detail:

- `ok` is based on gateway reachability, not on the service being fully healthy end to end.

The report also records:

- `serviceRunning`
- `warnings`
- raw `gatewayStatus`
- raw `securityAudit`

Warnings are added when:

- the gateway is reachable but the installed service is not running
- `plugins.allow` is not explicitly configured
- insecure auth is enabled

## Cursor Check

The Cursor check is lightweight and is mainly for human-side IDE / spot-check readiness.

It resolves the `cursor` command and then runs:

- `cursor --version`

If that command exits successfully, the runtime is marked ready for human-side IDE / spot-check use.

The current check does not verify:

- Cursor authentication state
- Cursor background agent readiness
- whether Cursor can complete a real task

## Codex Check

The Codex check validates both command execution and login state.

It resolves the `codex` command and then runs:

- `codex --help`
- `codex login status`

If both commands succeed, the runtime is marked ready and the report includes:

- `details.authReady: true`

If either command fails, the runtime is marked not ready and:

- `details.authReady: false`

The current check does not run a real coding task or write test artifact.

## Local CI Check

The local CI check looks only at `package.json` in the current working directory.

It requires these scripts to exist:

- `build`
- `lint`
- `typecheck`
- `test`
- `test:integration`
- `test:e2e`

If all six exist, local CI is marked ready.

The report includes:

- `packageJsonPath`
- `missingScripts`
- `availableScripts`

Important limitation:

- this check only verifies script presence, not whether those scripts actually pass

## Report Shape

The JSON report contains:

- `generatedAt`
- `checks`

Each check may contain:

- `id`
- `label`
- `installed`
- `ok`
- `source`
- `command`
- `stdout`
- `stderr`
- `error`
- `details`
- `diagnostics`

The Markdown report renders:

- a top summary list of `READY` or `NOT READY`
- a details section for every runtime
- raw OpenClaw gateway and security audit sections when present

## How Runtime Routing Uses This Report

`createRunHandoffs()` loads `reports/runtime-doctor.json` by default.

That report is normalized by `src/lib/runtime-registry.mjs`:

- missing runtime entries become `ok: false`
- `manual` is always treated as available
- planner/reviewer work currently routes to `manual`; Cursor is tracked only as an optional human-side surface

Runtime selection then uses the first ready runtime in the role preference list.
If no automated or hybrid runtime is ready, the task falls back to `manual`.

## What The Doctor Does Not Guarantee

The current doctor is useful for routing decisions, but it is not a full production
health audit.

It does not guarantee:

- that OpenClaw can complete a real task
- that Cursor can run background work
- that Codex can finish an end-to-end execution flow
- that local CI scripts actually pass
- that verifier result artifacts will be written
