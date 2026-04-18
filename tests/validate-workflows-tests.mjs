import assert from "node:assert/strict";

import {
  validateReleaseReadinessWindowsSmoke,
  validateWorkflowSemantics
} from "../scripts/validate-workflows.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function createReleaseReadinessWorkflow(steps) {
  return {
    name: "Release Readiness",
    on: {
      workflow_dispatch: {}
    },
    jobs: {
      quickReadiness: {
        "runs-on": "${{ matrix.os }}",
        steps
      }
    }
  };
}

async function main() {
  await runTest("release-readiness semantic check accepts Windows-guarded smoke steps", async () => {
    const workflow = createReleaseReadinessWorkflow([
      {
        name: "Windows backup smoke",
        if: "matrix.os == 'windows-latest'",
        run: "npm run backup:project -- --output-dir reports/release-readiness/backup-smoke"
      },
      {
        name: "Windows EXE release smoke",
        if: "matrix.os == 'windows-latest'",
        run: "npm run release:win -- --output-dir reports/release-readiness/windows-release-smoke"
      }
    ]);

    assert.doesNotThrow(() => validateReleaseReadinessWindowsSmoke("release-readiness.yml", workflow));
    assert.doesNotThrow(() => validateWorkflowSemantics("release-readiness.yml", workflow));
  });

  await runTest("release-readiness semantic check fails when required Windows smoke command is missing", async () => {
    const workflow = createReleaseReadinessWorkflow([
      {
        name: "Windows backup smoke",
        if: "matrix.os == 'windows-latest'",
        run: "npm run backup:project -- --output-dir reports/release-readiness/backup-smoke"
      }
    ]);

    assert.throws(
      () => validateReleaseReadinessWindowsSmoke("release-readiness.yml", workflow),
      /missing required Windows release smoke command\(s\).*npm run release:win/i
    );
  });

  await runTest("release-readiness semantic check fails when smoke command is not Windows-guarded", async () => {
    const workflow = createReleaseReadinessWorkflow([
      {
        name: "Windows backup smoke",
        if: "matrix.os == 'windows-latest'",
        run: "npm run backup:project -- --output-dir reports/release-readiness/backup-smoke"
      },
      {
        name: "Release smoke accidentally cross-platform",
        run: "npm run release:win -- --output-dir reports/release-readiness/windows-release-smoke"
      }
    ]);

    assert.throws(
      () => validateReleaseReadinessWindowsSmoke("release-readiness.yml", workflow),
      /without a Windows-only guard/i
    );
  });

  await runTest("non-release-readiness workflows skip release-specific semantic checks", async () => {
    const workflow = {
      name: "CI",
      on: {
        push: {}
      },
      jobs: {
        quality: {
          "runs-on": "ubuntu-latest",
          steps: [
            {
              name: "Install dependencies",
              run: "npm ci"
            }
          ]
        }
      }
    };

    assert.doesNotThrow(() => validateWorkflowSemantics("ci.yml", workflow));
  });

  console.log("Validate workflow tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
