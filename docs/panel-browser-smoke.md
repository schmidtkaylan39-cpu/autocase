# Panel Browser Smoke

`scripts/panel-browser-smoke.mjs` is a zero-dependency browser harness for the panel quick-start button.

What it does:

- starts the local panel server against a temporary evidence workspace
- launches an already-installed Chrome or Edge with `--remote-debugging-port=0`
- connects through Chrome DevTools Protocol from Node
- fills the panel form, clicks `#quickStartBtn`, auto-answers the in-page confirmation prompt, and verifies that the click created the expected run artifacts

Default behavior keeps the smoke local and deterministic:

- uses a structured request with local seed files
- runs with `--max-rounds 0` by default, so it validates the browser UI click path without depending on external agent runtimes

Run it with:

```bash
npm run acceptance:panel:browser
```

For the stricter end-to-end browser path that waits for the run to complete and verifies the generated summary artifact, use:

```bash
npm run acceptance:panel:browser:full
```

Useful options:

- `--headed` to watch the browser interact with the panel
- `--browser <path>` to force a specific Chrome/Edge executable
- `--output-root <dir>` to choose where evidence is written
- `--require-completed` to keep polling until the browser-triggered run reaches a terminal completed state and the generated summary artifact is verified

Evidence is written under `reports/panel-browser-smoke/...` and includes:

- `panel-browser-smoke-summary.json`
- `verification.json`
- `status-polls.json` when completion polling is enabled
- `artifact-verification.json` when completion mode verifies the generated summary
- `before-click.png`
- `after-click.png`
- copied `run-state.json`, `spec.snapshot.json`, and `autonomous-summary.json` when created
