import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { startPanelServer } from "../src/lib/panel.mjs";

const execFileAsync = promisify(execFile);
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

async function quickStartSafe(panelUrl, requestText, runId, maxRounds = 0) {
  const previewResponse = await postAction(panelUrl, "intake-preview", {
    request: requestText
  });
  const preview = previewResponse.result.preview;
  const quickStartResponse = await postAction(panelUrl, "quick-start-safe", {
    request: requestText,
    runId,
    maxRounds,
    previewDigest: preview.previewDigest,
    confirmationText: preview.confirmationToken
  });

  return {
    preview,
    quickStartResponse
  };
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

async function seedTokenInput(workspaceRoot, relativePath, label, tokenValue) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${label} token: ${tokenValue}\n`, "utf8");
}

async function writeSummaryArtifact(workspaceRoot, relativePath, tokens) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const lines = ["# Combined Notes", "", ...tokens.map((token) => `- ${token}`), "", "這是一段中文摘要。"];
  await writeFile(absolutePath, `${lines.join("\n")}\n`, "utf8");
}

async function runWorkspaceVerifier(workspaceRoot) {
  await execFileAsync(process.execPath, [path.join("scripts", "verify-summary.mjs")], {
    cwd: workspaceRoot
  });
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
        const { preview, quickStartResponse } = await quickStartSafe(panel.url, requestText, runId, 0);

        assert.equal(preview.readyToExecute, true);
        assert.match(preview.previewDigest, /^[a-f0-9]{64}$/i);
        assert.equal(typeof preview.confirmationToken, "string");
        assert.ok(preview.confirmationToken.length > 0);

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

  await runTest(
    "panel quick-start-safe merges missing local-ci scripts into an existing package.json",
    async () => {
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-verifier-runtime-existing-pkg-"));
      const runId = "quick-start-safe-verifier-runtime-existing-package";
      const requestText = [
        "Start: Local workspace has sales.json and config/thresholds.json.",
        "End point: Produce artifacts/generated/summary.md with daily totals and anomaly notes.",
        "Success criteria: summary.md exists; summary includes total revenue and top anomalies.",
        "Input source: sales.json; config/thresholds.json.",
        "Out of scope: do not call external APIs; do not send notifications."
      ].join("\n");

      await seedQuickStartInputs(workspaceRoot);
      await writeFile(
        path.join(workspaceRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "existing-workspace",
            private: false,
            scripts: {
              test: "node custom-test.mjs",
              "custom:health": "node health-check.mjs"
            }
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const panel = await startPanelServer({
        workspaceDir: workspaceRoot,
        port: 0
      });

      try {
        const { preview, quickStartResponse } = await quickStartSafe(panel.url, requestText, runId, 0);

        assert.equal(preview.readyToExecute, true);

        const packageJsonPath = path.join(workspaceRoot, "package.json");
        const workspacePackageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

        assert.equal(workspacePackageJson.name, "existing-workspace");
        assert.equal(workspacePackageJson.private, false);
        assert.equal(workspacePackageJson.scripts.test, "node custom-test.mjs");
        assert.equal(workspacePackageJson.scripts["custom:health"], "node health-check.mjs");

        for (const scriptName of requiredLocalCiScripts.filter((name) => name !== "test")) {
          assert.equal(
            typeof workspacePackageJson.scripts?.[scriptName],
            "string",
            `Expected workspace package.json to define scripts.${scriptName}.`
          );
          assert.ok(workspacePackageJson.scripts[scriptName].trim().length > 0);
        }

        const doctorReportPath = path.join(workspaceRoot, "reports", "runtime-doctor.json");
        const doctorReport = JSON.parse(await readFile(doctorReportPath, "utf8"));
        const localCiCheck = (doctorReport.checks ?? []).find((check) => check.id === "local-ci");

        assert.ok(localCiCheck, "runtime-doctor.json did not include a local-ci check.");
        assert.equal(localCiCheck.ok, true);
        assert.deepEqual(localCiCheck.details?.missingScripts ?? [], []);
        assert.equal(quickStartResponse.result.run.runId, runId);
      } finally {
        await panel.close();
      }
    }
  );

  await runTest(
    "panel quick-start-safe regenerates verifier script and enforces latest contract in reused workspace",
    async () => {
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-verifier-runtime-reused-"));
      const firstRunId = "quick-start-safe-verifier-runtime-reused-1";
      const secondRunId = "quick-start-safe-verifier-runtime-reused-2";
      const firstBriefToken = "BRIEF-AAA-1";
      const firstDetailToken = "DETAIL-BBB-1";
      const secondAlphaToken = "ALPHA-CCC-2";
      const secondBetaToken = "BETA-DDD-2";
      const firstRequestText = [
        "Start: Local workspace has data/brief.txt and data/details.txt.",
        "End point: Produce artifacts/generated/summary.md from both files.",
        `Success criteria: artifacts/generated/summary.md exists; summary includes exact token ${firstBriefToken}; summary includes exact token ${firstDetailToken}; summary contains a heading named Combined Notes; summary includes a short Chinese summary.`,
        "Input source: data/brief.txt; data/details.txt.",
        "Out of scope: do not call external APIs."
      ].join("\n");
      const secondRequestText = [
        "Start: Local workspace has data/alpha.txt and data/beta.txt.",
        "End point: Produce artifacts/generated/final-summary.md from both files.",
        `Success criteria: artifacts/generated/final-summary.md exists; summary includes exact token ${secondAlphaToken}; summary includes exact token ${secondBetaToken}; summary contains a heading named Combined Notes; summary includes a short Chinese summary.`,
        "Input source: data/alpha.txt; data/beta.txt.",
        "Out of scope: do not call external APIs."
      ].join("\n");

      await seedTokenInput(workspaceRoot, path.join("data", "brief.txt"), "Brief", "BRIEF-AAA-1");
      await seedTokenInput(workspaceRoot, path.join("data", "details.txt"), "Details", "DETAIL-BBB-1");

      const panel = await startPanelServer({
        workspaceDir: workspaceRoot,
        port: 0
      });

      try {
        await quickStartSafe(panel.url, firstRequestText, firstRunId, 0);

        const verifierScriptPath = path.join(workspaceRoot, "scripts", "verify-summary.mjs");
        const firstVerifierScript = await readFile(verifierScriptPath, "utf8");
        assert.match(firstVerifierScript, /artifacts\/generated\/summary\.md/);
        assert.match(firstVerifierScript, /BRIEF-AAA-1/);
        assert.match(firstVerifierScript, /DETAIL-BBB-1/);
        assert.match(firstVerifierScript, /Combined Notes/);

        await writeSummaryArtifact(workspaceRoot, path.join("artifacts", "generated", "summary.md"), [
          firstBriefToken,
          firstDetailToken
        ]);
        await runWorkspaceVerifier(workspaceRoot);

        await seedTokenInput(workspaceRoot, path.join("data", "alpha.txt"), "Alpha", "ALPHA-CCC-2");
        await seedTokenInput(workspaceRoot, path.join("data", "beta.txt"), "Beta", "BETA-DDD-2");
        await quickStartSafe(panel.url, secondRequestText, secondRunId, 0);

        const secondVerifierScript = await readFile(verifierScriptPath, "utf8");
        assert.match(secondVerifierScript, /node:crypto/);
        assert.match(secondVerifierScript, /artifacts\/generated\/final-summary\.md/);
        assert.match(secondVerifierScript, /ALPHA-CCC-2/);
        assert.match(secondVerifierScript, /BETA-DDD-2/);
        assert.match(secondVerifierScript, /data\/alpha\.txt/);
        assert.match(secondVerifierScript, /data\/beta\.txt/);
        assert.doesNotMatch(secondVerifierScript, /BRIEF-AAA-1/);
        assert.doesNotMatch(secondVerifierScript, /DETAIL-BBB-1/);

        await assert.rejects(
          runWorkspaceVerifier(workspaceRoot),
          /final-summary\.md|ENOENT/i
        );

        await writeSummaryArtifact(workspaceRoot, path.join("artifacts", "generated", "final-summary.md"), [
          secondAlphaToken,
          secondBetaToken
        ]);
        await runWorkspaceVerifier(workspaceRoot);
        await writeFile(path.join(workspaceRoot, "data", "beta.txt"), "Beta token: BETA-DDD-2\nMutated\n", "utf8");
        await assert.rejects(runWorkspaceVerifier(workspaceRoot), /Input source changed unexpectedly|data[\\/]beta\.txt/i);
        await seedTokenInput(workspaceRoot, path.join("data", "beta.txt"), "Beta", secondBetaToken);
        await runWorkspaceVerifier(workspaceRoot);
      } finally {
        await panel.close();
      }
    }
  );

  await runTest(
    "panel quick-start-safe forces quick-start:verify-output when reused workspace already defines full local-ci scripts",
    async () => {
      const workspaceRoot = await mkdtemp(
        path.join(os.tmpdir(), "ai-factory-panel-verifier-runtime-full-local-ci-")
      );
      const runId = "quick-start-safe-verifier-runtime-full-local-ci";
      const requestText = [
        "Start: Local workspace has data/brief.txt and data/details.txt.",
        "End point: Produce artifacts/generated/summary.md from both files.",
        "Success criteria: artifacts/generated/summary.md exists; summary includes exact token BRIEF-ZZZ-9; summary includes exact token DETAIL-YYY-9; summary contains a heading named Combined Notes; summary includes a short Chinese summary.",
        "Input source: data/brief.txt; data/details.txt.",
        "Out of scope: do not call external APIs."
      ].join("\n");
      const existingScripts = {
        build: 'node -e "console.log(\'existing build\')"',
        lint: 'node -e "console.log(\'existing lint\')"',
        typecheck: 'node -e "console.log(\'existing typecheck\')"',
        test: 'node -e "console.log(\'existing test\')"',
        "test:integration": 'node -e "console.log(\'existing integration\')"',
        "test:e2e": 'node -e "console.log(\'existing e2e\')"'
      };

      await seedTokenInput(workspaceRoot, path.join("data", "brief.txt"), "Brief", "BRIEF-ZZZ-9");
      await seedTokenInput(workspaceRoot, path.join("data", "details.txt"), "Details", "DETAIL-YYY-9");
      await writeFile(
        path.join(workspaceRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "existing-full-local-ci-workspace",
            private: true,
            scripts: existingScripts
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const panel = await startPanelServer({
        workspaceDir: workspaceRoot,
        port: 0
      });

      try {
        const { preview, quickStartResponse } = await quickStartSafe(panel.url, requestText, runId, 0);

        assert.equal(preview.readyToExecute, true);

        const workspacePackageJson = JSON.parse(
          await readFile(path.join(workspaceRoot, "package.json"), "utf8")
        );

        for (const [scriptName, scriptValue] of Object.entries(existingScripts)) {
          assert.equal(
            workspacePackageJson.scripts?.[scriptName],
            scriptValue,
            `Expected existing scripts.${scriptName} to stay intact.`
          );
        }

        assert.equal(
          workspacePackageJson.scripts?.["quick-start:verify-output"],
          "node scripts/verify-summary.mjs"
        );

        const verifierScriptPath = path.join(workspaceRoot, "scripts", "verify-summary.mjs");
        const verifierScript = await readFile(verifierScriptPath, "utf8");
        assert.match(verifierScript, /BRIEF-ZZZ-9/);
        assert.match(verifierScript, /DETAIL-YYY-9/);

        const runStatePath = quickStartResponse.result.run.statePath;
        const verifierTaskIds = await forceVerifierTasksToReadyGate(runStatePath);
        const handoffResponse = await postAction(panel.url, "handoff", {
          runStatePath
        });
        const verifierDescriptors = (handoffResponse.result.descriptors ?? []).filter((descriptor) =>
          verifierTaskIds.includes(descriptor.taskId)
        );

        assert.ok(verifierDescriptors.length > 0, "Expected verifier handoff descriptors.");

        for (const descriptor of verifierDescriptors) {
          const launcherScript = await readFile(descriptor.launcherPath, "utf8");
          assert.equal(descriptor.runtime?.id, "local-ci");
          assert.match(
            launcherScript,
            /\bnpm run quick-start:verify-output\b/,
            "Expected verifier launcher to force the reserved quick-start verification script."
          );
          assert.match(
            launcherScript,
            /\bnpm run test:e2e\b[\s\S]*\bnpm run quick-start:verify-output\b/,
            "Expected reserved quick-start verification command to be appended after the standard local-ci gates."
          );
          assert.match(
            launcherScript,
            /quick-start output verification/,
            "Expected result artifact notes to record the dedicated quick-start verification gate."
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
