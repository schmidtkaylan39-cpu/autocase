import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultSelfCheckCommandSpecs, runSelfCheckSuite } from "../src/lib/self-check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const reportsDirectory = path.join(repoRoot, "reports");
const validationResultsPath = path.join(reportsDirectory, "validation-results.json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmInvocation = process.env.npm_execpath
  ? {
      command: process.execPath,
      prefixArgs: [process.env.npm_execpath]
    }
  : {
      command: npmCommand,
      prefixArgs: []
    };

async function main() {
  const artifact = await runSelfCheckSuite({
    repoRoot,
    reportsDirectory,
    validationResultsPath,
    npmInvocation,
    commandSpecs: defaultSelfCheckCommandSpecs
  });

  const failed = artifact.results.find((result) => result.status === "failed");
  if (failed) {
    console.error(`Self-check failed at: ${failed.command}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Validation results written to ${validationResultsPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
