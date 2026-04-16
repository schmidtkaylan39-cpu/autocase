import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runRuntimeDoctor } from "../src/lib/doctor.mjs";
import { checkPowerShellAvailability } from "../src/lib/powershell.mjs";

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
  await runTest("PowerShell availability check reports missing pwsh on non-Windows when overridden", async () => {
    const previousOverride = process.env.AI_FACTORY_POWERSHELL_COMMAND;
    process.env.AI_FACTORY_POWERSHELL_COMMAND = "definitely-missing-ai-factory-pwsh";

    try {
      const result = await checkPowerShellAvailability("linux");
      assert.equal(result.ok, false);
      assert.equal(result.command, "definitely-missing-ai-factory-pwsh");
    } finally {
      if (previousOverride === undefined) {
        delete process.env.AI_FACTORY_POWERSHELL_COMMAND;
      } else {
        process.env.AI_FACTORY_POWERSHELL_COMMAND = previousOverride;
      }
    }
  });

  await runTest("runtime doctor downgrades local-ci when the launcher shell runtime is unavailable", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-doctor-"));
    const previousCwd = process.cwd();
    const previousPowerShellOverride = process.env.AI_FACTORY_POWERSHELL_COMMAND;
    const previousShellOverride = process.env.AI_FACTORY_LAUNCHER_SHELL_COMMAND;

    await mkdir(path.join(tempDir, "reports"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify(
        {
          name: "doctor-fixture",
          version: "0.0.1",
          scripts: {
            build: "echo build",
            lint: "echo lint",
            typecheck: "echo typecheck",
            test: "echo test",
            "test:integration": "echo integration",
            "test:e2e": "echo e2e"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    process.chdir(tempDir);

    if (process.platform === "win32") {
      process.env.AI_FACTORY_POWERSHELL_COMMAND = "definitely-missing-ai-factory-pwsh";
      delete process.env.AI_FACTORY_LAUNCHER_SHELL_COMMAND;
    } else {
      process.env.AI_FACTORY_LAUNCHER_SHELL_COMMAND = "definitely-missing-ai-factory-shell";
      delete process.env.AI_FACTORY_POWERSHELL_COMMAND;
    }

    try {
      const result = await runRuntimeDoctor(path.join(tempDir, "reports"));
      const localCiCheck = result.checks.find((check) => check.id === "local-ci");

      assert.ok(localCiCheck);
      assert.equal(localCiCheck.ok, false);
      assert.equal(localCiCheck.details?.launcherShellReady, false);
      assert.match(localCiCheck.error ?? "", /launcher shell runtime is unavailable/i);
      assert.equal(
        localCiCheck.details?.launcherShell,
        process.platform === "win32" ? "definitely-missing-ai-factory-pwsh" : "definitely-missing-ai-factory-shell"
      );
    } finally {
      process.chdir(previousCwd);

      if (previousPowerShellOverride === undefined) {
        delete process.env.AI_FACTORY_POWERSHELL_COMMAND;
      } else {
        process.env.AI_FACTORY_POWERSHELL_COMMAND = previousPowerShellOverride;
      }

      if (previousShellOverride === undefined) {
        delete process.env.AI_FACTORY_LAUNCHER_SHELL_COMMAND;
      } else {
        process.env.AI_FACTORY_LAUNCHER_SHELL_COMMAND = previousShellOverride;
      }
    }
  });

  await runTest("runtime doctor rejects non-Windows overrides that cannot execute launcher scripts", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-factory-doctor-shell-"));
    const previousCwd = process.cwd();
    const previousShellOverride = process.env.AI_FACTORY_LAUNCHER_SHELL_COMMAND;
    const previousPowerShellOverride = process.env.AI_FACTORY_POWERSHELL_COMMAND;

    await mkdir(path.join(tempDir, "reports"), { recursive: true });
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify(
        {
          name: "doctor-fixture",
          version: "0.0.1",
          scripts: {
            build: "echo build",
            lint: "echo lint",
            typecheck: "echo typecheck",
            test: "echo test",
            "test:integration": "echo integration",
            "test:e2e": "echo e2e"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    process.chdir(tempDir);
    process.env.AI_FACTORY_LAUNCHER_SHELL_COMMAND = process.execPath;
    delete process.env.AI_FACTORY_POWERSHELL_COMMAND;

    try {
      const result = await runRuntimeDoctor(path.join(tempDir, "reports"));
      const localCiCheck = result.checks.find((check) => check.id === "local-ci");

      assert.ok(localCiCheck);
      assert.equal(localCiCheck.ok, false);
      assert.equal(localCiCheck.details?.launcherShell, process.execPath);
      assert.equal(localCiCheck.details?.launcherShellReady, false);
      assert.match(localCiCheck.error ?? "", /launcher shell runtime is unavailable/i);
    } finally {
      process.chdir(previousCwd);

      if (previousShellOverride === undefined) {
        delete process.env.AI_FACTORY_LAUNCHER_SHELL_COMMAND;
      } else {
        process.env.AI_FACTORY_LAUNCHER_SHELL_COMMAND = previousShellOverride;
      }

      if (previousPowerShellOverride === undefined) {
        delete process.env.AI_FACTORY_POWERSHELL_COMMAND;
      } else {
        process.env.AI_FACTORY_POWERSHELL_COMMAND = previousPowerShellOverride;
      }
    }
  });

  console.log("Doctor tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
