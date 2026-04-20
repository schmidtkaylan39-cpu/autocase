import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRunHandoffs, runProject } from "../src/lib/commands.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const validSpecPath = path.join(projectRoot, "examples", "project-spec.valid.json");

  await runTest("createRunHandoffs rejects nested run-relative output paths", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-handoff-nested-output-"));
    const runId = "nested-output-run";
    const runResult = await runProject(validSpecPath, tempDir, runId);

    await assert.rejects(
      () => createRunHandoffs(runResult.statePath, path.join("runs", runId, "handoffs-failover")),
      /nested run directory/i
    );
  });

  console.log("Handoff output path tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
