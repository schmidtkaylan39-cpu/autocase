import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function escapePowerShellLiteral(value) {
  return String(value).replace(/'/g, "''");
}

export function toPowerShellSingleQuotedLiteral(value) {
  return `'${escapePowerShellLiteral(value)}'`;
}

export function getPowerShellInvocation(platform = process.platform) {
  const overrideCommand = process.env.AI_FACTORY_POWERSHELL_COMMAND?.trim();

  if (overrideCommand) {
    return {
      command: overrideCommand,
      commonArgs: ["-NoProfile"],
      windowsHide: platform === "win32"
    };
  }

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      commonArgs: ["-NoProfile"],
      windowsHide: true
    };
  }

  return {
    command: "pwsh",
    commonArgs: ["-NoProfile"],
    windowsHide: false
  };
}

export function buildPowerShellFileArgs(scriptPath, platform = process.platform) {
  const runtime = getPowerShellInvocation(platform);

  if (platform === "win32") {
    return [...runtime.commonArgs, "-ExecutionPolicy", "Bypass", "-File", scriptPath];
  }

  return [...runtime.commonArgs, "-File", scriptPath];
}

export function buildPowerShellCommandArgs(commandLine, platform = process.platform) {
  const runtime = getPowerShellInvocation(platform);
  const encodedCommand = Buffer.from(String(commandLine), "utf16le").toString("base64");
  return [...runtime.commonArgs, "-EncodedCommand", encodedCommand];
}

export async function checkPowerShellAvailability(
  platform = process.platform,
  execFileImpl = execFileAsync
) {
  const runtime = getPowerShellInvocation(platform);

  try {
    await execFileImpl(
      runtime.command,
      buildPowerShellCommandArgs("$PSVersionTable.PSVersion.ToString()", platform),
      {
        encoding: "utf8",
        windowsHide: runtime.windowsHide,
        timeout: 15000
      }
    );

    return {
      installed: true,
      ok: true,
      command: runtime.command,
      error: null
    };
  } catch (error) {
    return {
      installed: false,
      ok: false,
      command: runtime.command,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
