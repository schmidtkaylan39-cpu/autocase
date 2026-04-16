import assert from "node:assert/strict";

import {
  buildPowerShellCommandArgs,
  buildPowerShellFileArgs,
  getPowerShellInvocation
} from "../src/lib/powershell.mjs";

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function decodeEncodedPowerShellCommand(args) {
  const encodedFlagIndex = args.indexOf("-EncodedCommand");

  if (encodedFlagIndex === -1) {
    throw new Error("Expected -EncodedCommand argument.");
  }

  return Buffer.from(args[encodedFlagIndex + 1], "base64").toString("utf16le");
}

async function main() {
  await runTest("windows PowerShell invocation keeps ExecutionPolicy bypass", async () => {
    const runtime = getPowerShellInvocation("win32");

    assert.equal(runtime.command, "powershell.exe");
    assert.equal(runtime.windowsHide, true);
    assert.deepEqual(buildPowerShellFileArgs("C:/tmp/demo.ps1", "win32"), [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:/tmp/demo.ps1"
    ]);
    const commandArgs = buildPowerShellCommandArgs("Get-Command node", "win32");

    assert.deepEqual(commandArgs.slice(0, 2), ["-NoProfile", "-EncodedCommand"]);
    assert.equal(decodeEncodedPowerShellCommand(commandArgs), "Get-Command node");
  });

  await runTest("non-Windows PowerShell invocation uses pwsh without ExecutionPolicy", async () => {
    const linuxRuntime = getPowerShellInvocation("linux");
    const darwinRuntime = getPowerShellInvocation("darwin");

    assert.equal(linuxRuntime.command, "pwsh");
    assert.equal(darwinRuntime.command, "pwsh");
    assert.equal(linuxRuntime.windowsHide, false);
    assert.deepEqual(buildPowerShellFileArgs("/tmp/demo.ps1", "linux"), [
      "-NoProfile",
      "-File",
      "/tmp/demo.ps1"
    ]);
    const commandArgs = buildPowerShellCommandArgs("Get-Command node", "linux");

    assert.deepEqual(commandArgs.slice(0, 2), ["-NoProfile", "-EncodedCommand"]);
    assert.equal(decodeEncodedPowerShellCommand(commandArgs), "Get-Command node");
  });

  console.log("All cross-platform tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
