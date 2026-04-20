import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDirectory, writeJson } from "./fs-utils.mjs";
import {
  buildPowerShellCommandArgs,
  buildPowerShellFileArgs,
  checkLauncherShellAvailability,
  getNonWindowsLauncherShellCommand,
  getPowerShellInvocation,
  toPowerShellSingleQuotedLiteral
} from "./powershell.mjs";

const execFileAsync = promisify(execFile);
const defaultReadinessProfile = {
  id: "autonomous-gpt54-codex",
  label: "Autonomous GPT-5.4 + Codex",
  description:
    "Automated GPT-5.4 / GPT-5.4 Pro planning-review loops via Codex CLI, Codex execution, and local CI verification.",
  requiredRuntimeIds: ["gpt-runner", "codex", "local-ci"]
};
const requiredRuntimeIdSet = new Set(defaultReadinessProfile.requiredRuntimeIds);

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveCommand(command, execFileImpl = execFileAsync) {
  if (process.platform === "win32") {
    const runtime = getPowerShellInvocation();
    try {
      const result = await execFileImpl(
        runtime.command,
        buildPowerShellCommandArgs(
          `(Get-Command ${toPowerShellSingleQuotedLiteral(command)} -ErrorAction Stop | Select-Object -ExpandProperty Source -First 1)`
        ),
        {
          encoding: "utf8",
          windowsHide: runtime.windowsHide,
          timeout: 15000
        }
      );

      return {
        installed: true,
        source: result.stdout.trim()
      };
    } catch {
      return {
        installed: false,
        source: null
      };
    }
  }

  try {
    const result = await execFileImpl("which", [command], {
      encoding: "utf8",
      timeout: 15000
    });

    return {
      installed: true,
      source: result.stdout.trim()
    };
  } catch {
    return {
      installed: false,
      source: null
    };
  }
}

async function runCommand(command, args, execFileImpl = execFileAsync) {
  if (process.platform === "win32") {
    const runtime = getPowerShellInvocation();
    const commandLine = [`& ${toPowerShellSingleQuotedLiteral(command)}`]
      .concat(args.map((arg) => toPowerShellSingleQuotedLiteral(arg)))
      .join(" ");

    return execFileImpl(runtime.command, buildPowerShellCommandArgs(commandLine), {
      encoding: "utf8",
      windowsHide: runtime.windowsHide,
      timeout: 30000
    });
  }

  return execFileImpl(command, args, {
    encoding: "utf8",
    timeout: 30000
  });
}

function combineOutput(result) {
  return [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
}

async function checkOpenClaw(execFileImpl = execFileAsync) {
  const resolution = await resolveCommand("openclaw", execFileImpl);

  if (!resolution.installed) {
    return {
      id: "openclaw",
      label: "OpenClaw",
      installed: false,
      ok: false,
      command: "openclaw gateway status",
      error: "command not found"
    };
  }

  try {
    const version = await runCommand("openclaw", ["--version"], execFileImpl);
    const gatewayStatus = await runCommand("openclaw", ["gateway", "status"], execFileImpl);
    const securityAudit = await runCommand("openclaw", ["security", "audit"], execFileImpl);

    const gatewayText = combineOutput(gatewayStatus);
    const auditText = combineOutput(securityAudit);
    const gatewayReachable =
      /RPC probe:\s*ok/i.test(gatewayText) || /Gateway:\s*reachable/i.test(gatewayText);
    const serviceRunning = /Runtime:\s*running/i.test(gatewayText);
    const warnings = [];

    if (!gatewayReachable) {
      warnings.push("Gateway RPC probe did not succeed.");
    } else if (!serviceRunning) {
      warnings.push("Gateway is reachable, but the installed service is not running.");
    }

    if (/plugins\.allow is not set|plugins\.allow is empty|extensions_no_allowlist/i.test(auditText)) {
      warnings.push("plugins.allow is not explicitly configured.");
    }

    if (/allowInsecureAuth=true|insecure auth toggle enabled/i.test(auditText)) {
      warnings.push("Control UI insecure auth is enabled.");
    }

    return {
      id: "openclaw",
      label: "OpenClaw",
      installed: true,
      ok: gatewayReachable,
      source: resolution.source,
      command: "openclaw gateway status",
      stdout: combineOutput(version),
      details: {
        gatewayReachable,
        serviceRunning,
        warnings
      },
      diagnostics: {
        gatewayStatus: gatewayText,
        securityAudit: auditText
      }
    };
  } catch (error) {
    return {
      id: "openclaw",
      label: "OpenClaw",
      installed: true,
      ok: false,
      source: resolution.source,
      command: "openclaw gateway status",
      error: formatErrorMessage(error)
    };
  }
}

async function checkCursor(execFileImpl = execFileAsync) {
  const resolution = await resolveCommand("cursor", execFileImpl);

  if (!resolution.installed) {
    return {
      id: "cursor",
      label: "Cursor CLI",
      installed: false,
      ok: false,
      command: "cursor --version",
      error: "command not found"
    };
  }

  try {
    const version = await runCommand("cursor", ["--version"], execFileImpl);
    return {
      id: "cursor",
      label: "Cursor CLI",
      installed: true,
      ok: true,
      source: resolution.source,
      command: "cursor --version",
      stdout: combineOutput(version)
    };
  } catch (error) {
    return {
      id: "cursor",
      label: "Cursor CLI",
      installed: true,
      ok: false,
      source: resolution.source,
      command: "cursor --version",
      error: formatErrorMessage(error)
    };
  }
}

async function checkGptRunner(execFileImpl = execFileAsync) {
  const resolution = await resolveCommand("codex", execFileImpl);

  if (!resolution.installed) {
    return {
      id: "gpt-runner",
      label: "GPT Runner",
      installed: false,
      ok: false,
      command: "codex exec -m gpt-5.4 -",
      error: "codex command not found"
    };
  }

  try {
    const loginStatus = await runCommand("codex", ["login", "status"], execFileImpl);

    return {
      id: "gpt-runner",
      label: "GPT Runner",
      installed: true,
      ok: true,
      source: resolution.source,
      command: "codex exec -m gpt-5.4 -",
      stdout: combineOutput(loginStatus),
      details: {
        provider: "codex-cli",
        preferredModels: ["gpt-5.4", "gpt-5.4-pro"].join(", ")
      }
    };
  } catch (error) {
    return {
      id: "gpt-runner",
      label: "GPT Runner",
      installed: true,
      ok: false,
      source: resolution.source,
      command: "codex exec -m gpt-5.4 -",
      error: formatErrorMessage(error)
    };
  }
}

async function checkCodex(execFileImpl = execFileAsync) {
  const resolution = await resolveCommand("codex", execFileImpl);

  if (!resolution.installed) {
    return {
      id: "codex",
      label: "Codex CLI",
      installed: false,
      ok: false,
      command: "codex login status",
      error: "command not found"
    };
  }

  try {
    const help = await runCommand("codex", ["--help"], execFileImpl);
    const loginStatus = await runCommand("codex", ["login", "status"], execFileImpl);

    return {
      id: "codex",
      label: "Codex CLI",
      installed: true,
      ok: true,
      source: resolution.source,
      command: "codex login status",
      stdout: combineOutput(loginStatus),
      stderr: combineOutput(help),
      details: {
        authReady: true
      }
    };
  } catch (error) {
    return {
      id: "codex",
      label: "Codex CLI",
      installed: true,
      ok: false,
      source: resolution.source,
      command: "codex login status",
      error: formatErrorMessage(error),
      details: {
        authReady: false
      }
    };
  }
}

async function checkLocalCi(workspaceRoot = process.cwd()) {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const packageJsonPath = path.join(resolvedWorkspaceRoot, "package.json");

  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const scripts = packageJson.scripts ?? {};
    const requiredScripts = ["build", "lint", "typecheck", "test", "test:integration", "test:e2e"];
    const missingScripts = requiredScripts.filter((script) => !scripts[script]);

    return {
      id: "local-ci",
      label: "Local CI",
      installed: true,
      ok: missingScripts.length === 0,
      command: "npm run build && npm run lint && npm run typecheck && npm test",
      details: {
        packageJsonPath,
        missingScripts,
        availableScripts: Object.keys(scripts).sort()
      }
    };
  } catch (error) {
    return {
      id: "local-ci",
      label: "Local CI",
      installed: false,
      ok: false,
      command: "package.json",
      error: formatErrorMessage(error)
    };
  }
}

async function checkLauncherRuntimeAvailability(execFileImpl = execFileAsync) {
  const launcherStatus = await checkLauncherShellAvailability(process.platform, execFileImpl);

  if (process.platform === "win32") {
    return launcherStatus;
  }

  const command = getNonWindowsLauncherShellCommand();
  const resolution = await resolveCommand(command);

  return {
    installed: launcherStatus.installed,
    ok: launcherStatus.ok,
    command,
    source: resolution.source,
    error: launcherStatus.error
  };
}

async function probeWindowsCodexLauncher(execFileImpl = execFileAsync) {
  if (process.platform !== "win32") {
    return null;
  }

  const runtime = getPowerShellInvocation();
  const previewArgs = buildPowerShellFileArgs("<launcher.ps1>");
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-factory-codex-launcher-probe-"));
  const workspacePath = path.join(tempDirectory, "workspace");
  const promptPath = path.join(tempDirectory, "probe.prompt.md");
  const scriptPath = path.join(tempDirectory, "probe.launch.ps1");
  const launcherScript = [
    `Set-Location -LiteralPath ${toPowerShellSingleQuotedLiteral(workspacePath)}`,
    `$prompt = Get-Content -Raw -LiteralPath ${toPowerShellSingleQuotedLiteral(promptPath)}`,
    "$prompt | & codex -a never exec --skip-git-repo-check -C . -s workspace-write -"
  ].join("\n");

  try {
    await ensureDirectory(workspacePath);
    await writeFile(
      promptPath,
      "Reply with exactly READY.\nDo not read, create, modify, or delete any workspace files.\n",
      "utf8"
    );
    await writeFile(scriptPath, `${launcherScript}\n`, "utf8");

    const result = await execFileImpl(runtime.command, buildPowerShellFileArgs(scriptPath), {
      encoding: "utf8",
      windowsHide: runtime.windowsHide,
      timeout: 60000
    });

    return {
      ok: true,
      mode: "powershell-file-codex-exec",
      command: `${runtime.command} ${previewArgs.join(" ")}`,
      stdout: combineOutput(result)
    };
  } catch (error) {
    return {
      ok: false,
      mode: "powershell-file-codex-exec",
      command: `${runtime.command} ${previewArgs.join(" ")}`,
      error: formatErrorMessage(error)
    };
  } finally {
    await rm(tempDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

function applyLauncherRuntimeRequirement(check, launcherStatus) {
  if (!["openclaw", "gpt-runner", "codex", "local-ci"].includes(check.id)) {
    return check;
  }

  const details = {
    ...(check.details ?? {}),
    launcherShell: launcherStatus.command,
    launcherShellReady: launcherStatus.ok
  };

  if (launcherStatus.ok) {
    return {
      ...check,
      details
    };
  }

  const dependencyMessage = `Launcher shell runtime is unavailable: ${launcherStatus.command}`;

  return {
    ...check,
    ok: false,
    details,
    error: check.error ? `${check.error}\n${dependencyMessage}` : dependencyMessage
  };
}

function applyLauncherParityRequirement(check, launcherProbe) {
  if (!launcherProbe || !["gpt-runner", "codex"].includes(check.id)) {
    return check;
  }

  const details = {
    ...(check.details ?? {}),
    launcherProbeMode: launcherProbe.mode,
    launcherProbeCommand: launcherProbe.command,
    launcherParityReady: launcherProbe.ok
  };

  if (launcherProbe.ok) {
    return {
      ...check,
      details
    };
  }

  const dependencyMessage = `Runtime launcher parity probe failed: ${launcherProbe.error ?? launcherProbe.command}`;

  return {
    ...check,
    ok: false,
    details,
    error: check.error ? `${check.error}\n${dependencyMessage}` : dependencyMessage
  };
}

function applyReadinessProfile(check) {
  const requiredByDefaultRoute = requiredRuntimeIdSet.has(check.id);

  return {
    ...check,
    requiredByDefaultRoute,
    readinessClass: requiredByDefaultRoute ? "required" : "optional"
  };
}

function renderDoctorReport(checks) {
  const requiredRuntimes = checks.filter((check) => check.requiredByDefaultRoute);
  const optionalRuntimes = checks.filter((check) => !check.requiredByDefaultRoute);

  return [
    "# Runtime Doctor",
    "",
    `- Default readiness profile: ${defaultReadinessProfile.label} (\`${defaultReadinessProfile.id}\`)`,
    `- Profile description: ${defaultReadinessProfile.description}`,
    `- Required runtimes: ${requiredRuntimes.map((check) => check.id).join(", ") || "none"}`,
    `- Optional runtimes: ${optionalRuntimes.map((check) => check.id).join(", ") || "none"}`,
    "",
    ...checks.map(
      (check) =>
        `- ${check.label}: ${check.requiredByDefaultRoute ? "REQUIRED" : "OPTIONAL"} / ${
          check.ok ? "READY" : "NOT READY"
        }`
    ),
    "",
    "## Details",
    ...checks.flatMap((check) => {
      const lines = [
        `### ${check.label}`,
        `- Required by default route: ${check.requiredByDefaultRoute ? "yes" : "no"}`,
        `- Installed: ${check.installed ? "yes" : "no"}`,
        `- Command: ${check.command}`,
        `- Status: ${check.ok ? "READY" : "NOT READY"}`
      ];

      if (check.source) {
        lines.push(`- Source: ${check.source}`);
      }

      if (check.details && typeof check.details === "object") {
        for (const [key, value] of Object.entries(check.details)) {
          if (Array.isArray(value)) {
            lines.push(`- ${key}: ${value.length > 0 ? value.join(", ") : "none"}`);
          } else {
            lines.push(`- ${key}: ${value}`);
          }
        }
      }

      if (check.ok && check.stdout) {
        lines.push("```text", check.stdout, "```");
      }

      if (!check.ok && check.error) {
        lines.push("```text", check.error, "```");
      }

      if (check.diagnostics?.gatewayStatus) {
        lines.push("#### Gateway Status", "```text", check.diagnostics.gatewayStatus, "```");
      }

      if (check.diagnostics?.securityAudit) {
        lines.push("#### Security Audit", "```text", check.diagnostics.securityAudit, "```");
      }

      lines.push("");
      return lines;
    })
  ].join("\n");
}

export async function runRuntimeDoctor(outputDir = "reports", workspaceRoot = process.cwd(), options = {}) {
  const execFileImpl = options.execFileImpl ?? execFileAsync;
  const launcherStatus = await checkLauncherRuntimeAvailability(execFileImpl);
  const launcherProbe = launcherStatus.ok ? await probeWindowsCodexLauncher(execFileImpl) : null;
  const checks = [
    applyLauncherRuntimeRequirement(await checkOpenClaw(execFileImpl), launcherStatus),
    await checkCursor(execFileImpl),
    applyLauncherParityRequirement(
      applyLauncherRuntimeRequirement(await checkGptRunner(execFileImpl), launcherStatus),
      launcherProbe
    ),
    applyLauncherParityRequirement(
      applyLauncherRuntimeRequirement(await checkCodex(execFileImpl), launcherStatus),
      launcherProbe
    ),
    applyLauncherRuntimeRequirement(await checkLocalCi(workspaceRoot), launcherStatus)
  ].map((check) => applyReadinessProfile(check));

  const resolvedOutputDir = path.resolve(outputDir);
  await ensureDirectory(resolvedOutputDir);

  const jsonPath = path.join(resolvedOutputDir, "runtime-doctor.json");
  const markdownPath = path.join(resolvedOutputDir, "runtime-doctor.md");

  await writeJson(jsonPath, {
    generatedAt: new Date().toISOString(),
    defaultReadinessProfile,
    checks
  });

  await writeFile(markdownPath, `${renderDoctorReport(checks)}\n`, "utf8");

  return {
    jsonPath,
    markdownPath,
    checks
  };
}
