import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSelfCheckProfile, runSelfCheckSuite } from "../src/lib/self-check.mjs";

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

function parseArgs(argv) {
  const options = {
    profileName: "repo"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--profile") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --profile");
      }

      options.profileName = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = resolveSelfCheckProfile(options.profileName);
  const artifact = await runSelfCheckSuite({
    repoRoot,
    reportsDirectory,
    validationResultsPath,
    npmInvocation,
    profileName: profile.name,
    commandSpecs: profile.commandSpecs
  });

  const failed = artifact.results.find((result) => result.status === "failed");
  if (failed) {
    console.error(`Self-check failed at: ${failed.command}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Validation results written to ${validationResultsPath} (profile=${artifact.profile}, readyForHuman=${artifact.readyForHuman})`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
