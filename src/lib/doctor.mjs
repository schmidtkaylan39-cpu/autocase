import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDirectory, writeJson } from "./fs-utils.mjs";
import {
  buildPowerShellCommandArgs,
  escapePowerShellLiteral,
  getPowerShellInvocation
} from "./powershell.mjs";

const execFileAsync = promisify(execFile);

async function resolveCommand(command) {
  if (process.platform === "win32") {
    const runtime = getPowerShellInvocation();
    try {
      const result = await execFileAsync(
        runtime.command,
        buildPowerShellCommandArgs(
          `(Get-Command '${escapePowerShellLiteral(command)}' -ErrorAction Stop | Select-Object -ExpandProperty Source -First 1)`
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
    const result = await execFileAsync("which", [command], {
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

async function runCommand(command, args) {
  if (process.platform === "win32") {
    const runtime = getPowerShellInvocation();
    const commandLine = [`& '${escapePowerShellLiteral(command)}'`]
      .concat(args.map((arg) => `'${escapePowerShellLiteral(arg)}'`))
      .join(" ");

    return execFileAsync(runtime.command, buildPowerShellCommandArgs(commandLine), {
      encoding: "utf8",
      windowsHide: runtime.windowsHide,
      timeout: 30000
    });
  }

  return execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 30000
  });
}

function combineOutput(result) {
  return [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
}

async function checkOpenClaw() {
  const resolution = await resolveCommand("openclaw");

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
    const version = await runCommand("openclaw", ["--version"]);
    const gatewayStatus = await runCommand("openclaw", ["gateway", "status"]);
    const securityAudit = await runCommand("openclaw", ["security", "audit"]);

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
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkCursor() {
  const resolution = await resolveCommand("cursor");

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
    const version = await runCommand("cursor", ["--version"]);
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
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkCodex() {
  const resolution = await resolveCommand("codex");

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
    const help = await runCommand("codex", ["--help"]);
    const loginStatus = await runCommand("codex", ["login", "status"]);

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
      error: error instanceof Error ? error.message : String(error),
      details: {
        authReady: false
      }
    };
  }
}

async function checkLocalCi() {
  const packageJsonPath = path.resolve("package.json");

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
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function renderDoctorReport(checks) {
  return [
    "# Runtime Doctor",
    "",
    ...checks.map((check) => `- ${check.label}: ${check.ok ? "READY" : "NOT READY"}`),
    "",
    "## Details",
    ...checks.flatMap((check) => {
      const lines = [
        `### ${check.label}`,
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

export async function runRuntimeDoctor(outputDir = "reports") {
  const checks = [];

  checks.push(await checkOpenClaw());
  checks.push(await checkCursor());
  checks.push(await checkCodex());
  checks.push(await checkLocalCi());

  const resolvedOutputDir = path.resolve(outputDir);
  await ensureDirectory(resolvedOutputDir);

  const jsonPath = path.join(resolvedOutputDir, "runtime-doctor.json");
  const markdownPath = path.join(resolvedOutputDir, "runtime-doctor.md");

  await writeJson(jsonPath, {
    generatedAt: new Date().toISOString(),
    checks
  });

  await writeFile(markdownPath, `${renderDoctorReport(checks)}\n`, "utf8");

  return {
    jsonPath,
    markdownPath,
    checks
  };
}
