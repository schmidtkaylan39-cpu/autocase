import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, writeJson } from "./fs-utils.mjs";
import { mergeFactoryConfig } from "./roles.mjs";

export const packageRootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const UTF8_BOM = "\uFEFF";

export async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonIfMissing(targetPath, value) {
  if (await fileExists(targetPath)) {
    return false;
  }

  await writeJson(targetPath, value);
  return true;
}

export async function writeTextFileIfMissing(targetPath, value) {
  if (await fileExists(targetPath)) {
    return false;
  }

  await writeFile(targetPath, value, "utf8");
  return true;
}

export async function writeTextFileWithOptionalBom(targetPath, value, options = {}) {
  const { bom = false } = options;
  const normalizedValue = typeof value === "string" ? value : String(value ?? "");
  const fileContents = bom && !normalizedValue.startsWith(UTF8_BOM) ? `${UTF8_BOM}${normalizedValue}` : normalizedValue;
  await writeFile(targetPath, fileContents, "utf8");
}

export function inferWorkspaceRootFromSpecPath(specPath) {
  const resolvedSpecPath = path.resolve(specPath);
  const specDirectory = path.dirname(resolvedSpecPath);
  const containerDirectoryName = path.basename(specDirectory).toLowerCase();

  if (containerDirectoryName === "specs" || containerDirectoryName === "examples") {
    return path.dirname(specDirectory);
  }

  return specDirectory;
}

export function resolveWorkspaceRelativePath(workspaceRoot, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(workspaceRoot, targetPath);
}

export function resolveRunRelativePath(runDirectory, targetPath, fallbackPath) {
  const effectivePath = targetPath ?? fallbackPath;
  return path.isAbsolute(effectivePath) ? path.resolve(effectivePath) : path.resolve(runDirectory, effectivePath);
}

function normalizePathSegmentForComparison(value) {
  return process.platform === "win32" ? String(value).toLowerCase() : String(value);
}

export function assertCanonicalHandoffOutputDir(runDirectory, resolvedOutputDir) {
  const relativeFromRun = path.relative(runDirectory, resolvedOutputDir);

  if (
    relativeFromRun.length === 0 ||
    relativeFromRun === "." ||
    relativeFromRun.startsWith("..") ||
    path.isAbsolute(relativeFromRun)
  ) {
    return;
  }

  const segments = relativeFromRun.split(/[\\/]+/).filter(Boolean);
  const runId = path.basename(runDirectory);

  if (
    segments.length >= 2 &&
    normalizePathSegmentForComparison(segments[0]) === "runs" &&
    normalizePathSegmentForComparison(segments[1]) === normalizePathSegmentForComparison(runId)
  ) {
    throw new Error(
      `Refusing to generate handoffs inside a nested run directory: ${resolvedOutputDir}. ` +
        'Pass an absolute output directory or a run-relative leaf such as "handoffs-failover".'
    );
  }
}

export function inferWorkspaceRootFromRunState(runState, resolvedRunStatePath) {
  if (typeof runState?.workspacePath === "string" && runState.workspacePath.trim().length > 0) {
    return path.resolve(runState.workspacePath);
  }

  const runDirectory = path.dirname(resolvedRunStatePath);
  const runsDirectory = path.dirname(runDirectory);

  if (path.basename(runsDirectory).toLowerCase() === "runs") {
    return path.dirname(runsDirectory);
  }

  return runsDirectory;
}

export async function loadFactoryConfig(configPath = "config/factory.config.json", workspaceRoot = process.cwd()) {
  const resolvedConfigPath = resolveWorkspaceRelativePath(workspaceRoot, configPath);

  try {
    await access(resolvedConfigPath);
  } catch {
    return {
      resolvedConfigPath: null,
      config: mergeFactoryConfig()
    };
  }

  return {
    resolvedConfigPath,
    config: mergeFactoryConfig(await readJson(resolvedConfigPath))
  };
}

export async function loadDoctorReport(
  doctorReportPath = "reports/runtime-doctor.json",
  workspaceRoot = process.cwd()
) {
  const resolvedDoctorReportPath = resolveWorkspaceRelativePath(workspaceRoot, doctorReportPath);

  try {
    await access(resolvedDoctorReportPath);
    return {
      resolvedDoctorReportPath,
      report: await readJson(resolvedDoctorReportPath)
    };
  } catch {
    return {
      resolvedDoctorReportPath: null,
      report: {
        checks: []
      }
    };
  }
}
