import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startPanelServer } from "../src/lib/panel.mjs";

const requiredLocalCiScripts = [
  "build",
  "lint",
  "typecheck",
  "test",
  "test:integration",
  "test:e2e"
];

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  return payload;
}

async function postAction(baseUrl, action, payload = {}) {
  return getJson(`${baseUrl}/api/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      action,
      payload
    })
  });
}

async function seedQuickStartInputs(workspaceRoot) {
  await mkdir(path.join(workspaceRoot, "config"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "sales.json"),
    `${JSON.stringify(
      [
        { day: "2026-04-20", revenue: 1200, product: "A" },
        { day: "2026-04-20", revenue: 900, product: "B" }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(workspaceRoot, "config", "thresholds.json"),
    `${JSON.stringify({ anomalyThreshold: 0.15 }, null, 2)}\n`,
    "utf8"
  );
}

function clearTaskExecutionRuntime(task) {
  return {
    ...task,
    activeHandoffId: null,
    activeResultPath: null,
    activeHandoffOutputDir: null,
    nextRetryAt: null,
    lastRetryReason: null
  };
}

async function forceVerifierTasksToReadyGate(runStatePath) {
  const runState = JSON.parse(await readFile(runStatePath, "utf8"));
  const verifierTaskIds = (runState.taskLedger ?? [])
    .filter((task) => task?.role === "verifier")
    .map((task) => task.id);

  assert.ok(
    verifierTaskIds.length > 0,
    "Expected at least one verifier task in run-state.json."
  );

  const updatedTaskLedger = (runState.taskLedger ?? []).map((task) => {
    const cleanedTask = clearTaskExecutionRuntime(task);

    if (task.role === "planner" || task.role === "executor" || task.role === "reviewer") {
      return {
        ...cleanedTask,
        status: "completed"
      };
    }

    if (task.role === "verifier") {
      return {
        ...cleanedTask,
        status: "pending"
      };
    }

    if (task.role === "orchestrator") {
      return {
        ...cleanedTask,
        status: "pending"
      };
    }

    return cleanedTask;
  });

  await writeFile(
    runStatePath,
    `${JSON.stringify(
      {
        ...runState,
        taskLedger: updatedTaskLedger
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return verifierTaskIds;
}

async function main() {
  await runTest(
    "panel quick-start-safe prepares verifier local-ci runtime and avoids manual fallback",
    async () => {
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-verifier-runtime-"));
      const runId = "quick-start-safe-verifier-runtime-regression";
      const requestText = [
        "Start: Local workspace has sales.json and config/thresholds.json.",
        "End point: Produce artifacts/generated/summary.md with daily totals and anomaly notes.",
        "Success criteria: summary.md exists; summary includes total revenue and top anomalies.",
        "Input source: sales.json; config/thresholds.json.",
        "Out of scope: do not call external APIs; do not send notifications."
      ].join("\n");

      await seedQuickStartInputs(workspaceRoot);
      const panel = await startPanelServer({
        workspaceDir: workspaceRoot,
        port: 0
      });

      try {
        const previewResponse = await postAction(panel.url, "intake-preview", {
          request: requestText
        });
        const preview = previewResponse.result.preview;

        assert.equal(preview.readyToExecute, true);
        assert.match(preview.previewDigest, /^[a-f0-9]{64}$/i);
        assert.equal(typeof preview.confirmationToken, "string");
        assert.ok(preview.confirmationToken.length > 0);

        const quickStartResponse = await postAction(panel.url, "quick-start-safe", {
          request: requestText,
          runId,
          maxRounds: 0,
          previewDigest: preview.previewDigest,
          confirmationText: preview.confirmationToken
        });

        const runStatePath = quickStartResponse.result.run.statePath;
        const doctorReportPath = path.join(workspaceRoot, "reports", "runtime-doctor.json");
        await stat(doctorReportPath);

        const doctorReport = JSON.parse(await readFile(doctorReportPath, "utf8"));
        const localCiCheck = (doctorReport.checks ?? []).find((check) => check.id === "local-ci");

        assert.ok(localCiCheck, "runtime-doctor.json did not include a local-ci check.");
        assert.equal(
          localCiCheck.ok,
          true,
          `Expected local-ci to be ready after quick-start-safe, but got ${JSON.stringify(localCiCheck)}`
        );
        assert.deepEqual(localCiCheck.details?.missingScripts ?? [], []);

        const packageJsonPath = localCiCheck.details?.packageJsonPath;
        assert.equal(typeof packageJsonPath, "string");
        const workspacePackageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

        for (const scriptName of requiredLocalCiScripts) {
          assert.equal(
            typeof workspacePackageJson.scripts?.[scriptName],
            "string",
            `Expected workspace package.json to define scripts.${scriptName}.`
          );
          assert.ok(workspacePackageJson.scripts[scriptName].trim().length > 0);
        }

        const verifierTaskIds = await forceVerifierTasksToReadyGate(runStatePath);
        const handoffResponse = await postAction(panel.url, "handoff", {
          runStatePath
        });
        const descriptors = handoffResponse.result.descriptors ?? [];
        const verifierDescriptors = descriptors.filter((descriptor) =>
          verifierTaskIds.includes(descriptor.taskId)
        );

        assert.ok(
          verifierDescriptors.length > 0,
          "Expected verifier handoff descriptors after promoting verifier tasks to ready."
        );

        for (const descriptor of verifierDescriptors) {
          assert.equal(
            descriptor.runtime?.id,
            "local-ci",
            `Expected verifier runtime local-ci, got ${JSON.stringify(descriptor.runtime)}`
          );
          assert.equal(
            descriptor.runtime?.selectionStatus,
            "ready",
            `Expected verifier runtime selectionStatus=ready, got ${JSON.stringify(descriptor.runtime)}`
          );
          assert.doesNotMatch(
            descriptor.runtime?.selectionReason ?? "",
            /fallback to manual/i
          );
        }
      } finally {
        await panel.close();
      }
    }
  );

  console.log("Panel quick-start verifier runtime regression tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
