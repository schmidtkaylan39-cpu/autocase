import { readFile } from "node:fs/promises";

import { writeJson } from "../../src/lib/fs-utils.mjs";

const defaultRuntimeIds = ["cursor", "openclaw", "gpt-runner", "codex", "local-ci"];

export async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

export function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

export function toPowerShellLiteral(value) {
  if (Array.isArray(value)) {
    return `@(${value.map((item) => toPowerShellLiteral(item)).join(", ")})`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => `${key} = ${toPowerShellLiteral(item)}`);
    return `@{ ${entries.join("; ")} }`;
  }

  if (typeof value === "string") {
    return `'${escapePowerShellSingleQuoted(value)}'`;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "$true" : "$false";
  }

  if (value === null) {
    return "$null";
  }

  throw new Error(`Unsupported PowerShell literal: ${typeof value}`);
}

export function escapeShellSingleQuoted(value) {
  return String(value).replace(/'/g, `'"'"'`);
}

export function buildResultArtifactScript(resultPath, artifact) {
  const completeArtifact = {
    runId: "{{RUN_ID}}",
    taskId: "{{TASK_ID}}",
    handoffId: "{{HANDOFF_ID}}",
    ...artifact
  };

  if (process.platform === "win32") {
    const escapedResultPath = escapePowerShellSingleQuoted(resultPath);
    const lines = ["$result = @{"];

    for (const [key, value] of Object.entries(completeArtifact)) {
      lines.push(`  ${key} = ${toPowerShellLiteral(value)}`);
    }

    lines.push("} | ConvertTo-Json -Depth 5");
    lines.push(`$result | Set-Content -Path '${escapedResultPath}' -Encoding utf8`);

    return lines.join("\n");
  }

  return `cat > '${escapeShellSingleQuoted(resultPath)}' <<'JSON'
${JSON.stringify(completeArtifact, null, 2)}
JSON`;
}

export function buildResultArtifactScriptWithTrailingNewline(resultPath, artifact) {
  const script = buildResultArtifactScript(resultPath, artifact);
  return script.endsWith("\n") ? script : `${script}\n`;
}

export function withArtifactIdentity(artifact, identity = {}) {
  return {
    runId: identity.runId ?? "fixture-run",
    taskId: identity.taskId ?? "fixture-task",
    handoffId: identity.handoffId ?? "fixture-handoff",
    ...artifact
  };
}

export function bindArtifactScriptIdentity(script, descriptor) {
  return script
    .replaceAll("{{RUN_ID}}", descriptor.runId ?? "fixture-run")
    .replaceAll("{{TASK_ID}}", descriptor.taskId)
    .replaceAll("{{HANDOFF_ID}}", descriptor.handoffId ?? "fixture-handoff");
}

export async function writeFakeDoctorReport(filePath, overrides = {}, runtimeIds = defaultRuntimeIds) {
  const checks = runtimeIds.map((runtimeId) => ({
    id: runtimeId,
    installed: true,
    ok: false,
    ...(overrides[runtimeId] ?? {})
  }));

  await writeJson(filePath, { checks });
}

export async function limitDispatchToDescriptors(indexPath, runId, descriptors) {
  const existingIndex = await (async () => {
    try {
      return JSON.parse(await readFile(indexPath, "utf8"));
    } catch {
      return {};
    }
  })();

  await writeJson(indexPath, {
    ...existingIndex,
    generatedAt: new Date().toISOString(),
    runId,
    readyTaskCount: descriptors.length,
    descriptors
  });
}
