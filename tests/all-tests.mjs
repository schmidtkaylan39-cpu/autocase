import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const testsDirectory = path.dirname(fileURLToPath(import.meta.url));

function sortTestFiles(testFiles) {
  return testFiles.sort((left, right) => {
    if (left === "run-tests.mjs") {
      return -1;
    }

    if (right === "run-tests.mjs") {
      return 1;
    }

    if (left < right) {
      return -1;
    }

    if (left > right) {
      return 1;
    }

    return 0;
  });
}

async function main() {
  const directoryEntries = await readdir(testsDirectory, {
    withFileTypes: true
  });
  const testFiles = sortTestFiles(
    directoryEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name === "run-tests.mjs" || name.endsWith("-tests.mjs"))
      .filter((name) => name !== "all-tests.mjs")
  );

  if (testFiles.length === 0) {
    throw new Error("No test files found.");
  }

  for (const testFile of testFiles) {
    console.log(`\n=== ${testFile} ===`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(testsDirectory, testFile)], {
        cwd: path.resolve(testsDirectory, ".."),
        stdio: "inherit"
      });

      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`${testFile} failed with exit code ${code ?? 1}`));
      });
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
