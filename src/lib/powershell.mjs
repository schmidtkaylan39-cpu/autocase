export function escapePowerShellLiteral(value) {
  return String(value).replace(/'/g, "''");
}

export function getPowerShellInvocation(platform = process.platform) {
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
  return [...runtime.commonArgs, "-Command", commandLine];
}
