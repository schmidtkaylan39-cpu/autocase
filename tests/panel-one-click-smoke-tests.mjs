import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildRunConsistencyVerification,
  captureSmokeInputSnapshots,
  isMainModule,
  parseArgs,
  verifyGeneratedSummaryArtifact
} from "../scripts/panel-one-click-smoke.mjs";

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
  await runTest("panel one-click smoke stays import-safe for focused tests", async () => {
    assert.equal(isMainModule(), false);
  });

  await runTest("panel one-click smoke parses harness options", async () => {
    const options = parseArgs([
      "--output-root",
      "tmp/panel-one-click-smoke-tests",
      "--watchdog-ms",
      "1234",
      "--poll-interval-ms",
      "250",
      "--max-rounds",
      "2",
      "--request-file",
      "docs/request.txt"
    ]);

    assert.equal(options.outputRoot.endsWith(path.join("tmp", "panel-one-click-smoke-tests")), true);
    assert.equal(options.watchdogMs, 1234);
    assert.equal(options.pollIntervalMs, 250);
    assert.equal(options.maxRounds, 2);
    assert.equal(options.requestFile.endsWith(path.join("docs", "request.txt")), true);
    assert.equal(options.requestText, null);
  });

  await runTest("panel one-click smoke verifies generated summary requirements", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-one-click-smoke-"));
    const generatedDirectory = path.join(workspaceRoot, "artifacts", "generated");
    const dataDirectory = path.join(workspaceRoot, "data");

    await mkdir(generatedDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(path.join(dataDirectory, "brief.txt"), "Brief token: BRIEF-PANEL-SMOKE-20260421-A\n", "utf8");
    await writeFile(path.join(dataDirectory, "details.txt"), "Details token: DETAIL-PANEL-SMOKE-20260421-B\n", "utf8");
    await writeFile(
      path.join(generatedDirectory, "summary.md"),
      [
        "# Combined Notes",
        "",
        "Brief token: BRIEF-PANEL-SMOKE-20260421-A",
        "Details token: DETAIL-PANEL-SMOKE-20260421-B",
        "",
        "\u4e2d\u6587\u6458\u8981\uff1a\u5df2\u6574\u5408\u4e24\u4e2a\u672c\u5730\u8f93\u5165\u6587\u4ef6\u3002"
      ].join("\n"),
      "utf8"
    );

    const verification = await verifyGeneratedSummaryArtifact(workspaceRoot);

    assert.equal(verification.passed, true);
    assert.equal(verification.checks.every((check) => check.passed), true);
  });

  await runTest("panel one-click smoke fails when input files change after snapshot capture", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-one-click-smoke-inputs-"));
    const generatedDirectory = path.join(workspaceRoot, "artifacts", "generated");
    const dataDirectory = path.join(workspaceRoot, "data");

    await mkdir(generatedDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(path.join(dataDirectory, "brief.txt"), "Brief token: BRIEF-PANEL-SMOKE-20260421-A\n", "utf8");
    await writeFile(path.join(dataDirectory, "details.txt"), "Details token: DETAIL-PANEL-SMOKE-20260421-B\n", "utf8");
    const immutableInputSnapshots = await captureSmokeInputSnapshots(workspaceRoot);
    await writeFile(
      path.join(dataDirectory, "details.txt"),
      "Details token: DETAIL-PANEL-SMOKE-20260421-B\nUnexpected mutation\n",
      "utf8"
    );
    await writeFile(
      path.join(generatedDirectory, "summary.md"),
      [
        "# Combined Notes",
        "",
        "Brief token: BRIEF-PANEL-SMOKE-20260421-A",
        "Details token: DETAIL-PANEL-SMOKE-20260421-B",
        "",
        "\u4e2d\u6587\u6458\u8981\uff1a\u8f38\u51fa\u4e4d\u7136\u6b63\u78ba\uff0c\u4f46 input \u5df2\u88ab\u7be1\u6539\u3002"
      ].join("\n"),
      "utf8"
    );

    const verification = await verifyGeneratedSummaryArtifact(workspaceRoot, {
      immutableInputSnapshots
    });

    assert.equal(verification.passed, false);
    assert.equal(
      verification.checks.some(
        (check) => check.id === "input-immutable-data-details-txt" && check.passed === false
      ),
      true
    );
  });

  await runTest("panel one-click smoke reports missing generated summary", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-panel-one-click-smoke-missing-"));
    const verification = await verifyGeneratedSummaryArtifact(workspaceRoot);

    assert.equal(verification.passed, false);
    assert.equal(verification.checks[0]?.id, "summary-exists");
    assert.equal(verification.checks[0]?.passed, false);
  });

  await runTest("panel one-click smoke requires matching run ids and statuses across artifacts", async () => {
    const verification = buildRunConsistencyVerification({
      runId: "panel-live-smoke-001",
      quickStartResponse: {
        result: {
          run: { runId: "panel-live-smoke-001" },
          autonomous: {
            finalStatus: "completed",
            runSummary: { status: "completed" }
          }
        }
      },
      statusAfter: {
        overview: {
          latestRun: {
            summary: {
              runId: "panel-live-smoke-001",
              status: "completed"
            }
          }
        }
      },
      runState: {
        runId: "panel-live-smoke-001",
        status: "completed"
      },
      autonomousSummary: {
        runId: "panel-live-smoke-001",
        finalStatus: "completed"
      }
    });

    assert.equal(verification.passed, true);
    assert.equal(verification.checks.every((check) => check.passed), true);
  });

  await runTest("panel one-click smoke fails closed when autonomous summary is missing", async () => {
    const verification = buildRunConsistencyVerification({
      runId: "panel-live-smoke-002",
      quickStartResponse: {
        result: {
          run: { runId: "panel-live-smoke-002" },
          autonomous: {
            finalStatus: "completed",
            runSummary: { status: "completed" }
          }
        }
      },
      statusAfter: {
        overview: {
          latestRun: {
            summary: {
              runId: "panel-live-smoke-002",
              status: "completed"
            }
          }
        }
      },
      runState: {
        runId: "panel-live-smoke-002",
        status: "completed"
      },
      autonomousSummary: null
    });

    assert.equal(verification.passed, false);
    assert.equal(
      verification.checks.some((check) => check.id === "autonomous-summary-exists" && check.passed === false),
      true
    );
  });

  console.log("Panel one-click smoke tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
