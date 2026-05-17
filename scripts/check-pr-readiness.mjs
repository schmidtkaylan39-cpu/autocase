import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredSections = [
  "Summary",
  "Issue / Objective",
  "AI Execution Notes",
  "Validation Evidence",
  "Release Evidence",
  "Risk / Handoff"
];

const placeholderValues = new Set([
  "",
  "-",
  "n/a",
  "none",
  "todo",
  "tbd"
]);

const allowedTaskStates = new Set([
  "draft",
  "candidate-ready",
  "ready",
  "in-progress",
  "blocked",
  "validation-failed",
  "review-ready",
  "complete"
]);

const highRiskPathPatterns = [
  /^src\/lib\/panel\.mjs$/i,
  /^src\/.*runtime/i,
  /^src\/.*dispatch/i,
  /^src\/.*run-state/i,
  /^src\/.*secret/i,
  /^src\/.*release/i,
  /^scripts\/.*release/i,
  /^scripts\/.*preflight/i,
  /^scripts\/.*formal_paper/i,
  /^scripts\/.*trading/i,
  /^scripts\/.*broker/i,
  /^scripts\/.*ibkr/i,
  /^\.github\/workflows\//i,
  /^env_profiles\//i,
  /^preflight_decisions\//i,
  /(^|\/)\.env$/i,
  /(^|\/)\.env\./i
];

const highRiskTextPattern = /\b(runtime|release|security|secret|token|credential|cookie|trading|broker|ibkr|migration|destructive|public api|schema|workflow)\b/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHeading(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function stripMarkdownNoise(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`/g, "")
    .trim();
}

function isMeaningfulValue(value) {
  const normalized = stripMarkdownNoise(value).replace(/^[-*\s]+/, "").trim().toLowerCase();
  return !placeholderValues.has(normalized);
}

export function parseMarkdownSections(markdown) {
  const sections = new Map();
  const lines = String(markdown ?? "").split(/\r?\n/);
  let currentHeading = null;
  let currentLines = [];

  function flush() {
    if (currentHeading === null) {
      return;
    }

    sections.set(normalizeHeading(currentHeading), currentLines.join("\n").trim());
  }

  for (const line of lines) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line);

    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1];
      currentLines = [];
      continue;
    }

    if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  flush();
  return sections;
}

function getRequiredSection(sections, heading, errors) {
  const section = sections.get(normalizeHeading(heading));

  if (section === undefined) {
    errors.push(`Missing required section: ${heading}`);
    return "";
  }

  if (!isMeaningfulValue(section)) {
    errors.push(`Section must not be empty: ${heading}`);
  }

  return section;
}

function readBulletField(section, label) {
  const lines = section.split(/\r?\n/);
  const fieldPattern = new RegExp(`^\\s*-\\s+${escapeRegExp(label)}\\s*:\\s*(.*)$`, "i");
  const nextFieldPattern = /^\s*-\s+[^:]{1,80}:\s*/;
  const startIndex = lines.findIndex((line) => fieldPattern.test(line));

  if (startIndex === -1) {
    return null;
  }

  const firstLineMatch = fieldPattern.exec(lines[startIndex]);
  const fieldLines = [firstLineMatch?.[1] ?? ""];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (nextFieldPattern.test(line)) {
      break;
    }

    if (line.trim().length > 0) {
      fieldLines.push(line);
    }
  }

  return fieldLines.join("\n").trim();
}

function parseTaskMode(section) {
  const value = readBulletField(section, "Task mode");

  if (value === null || !isMeaningfulValue(value)) {
    return null;
  }

  const normalized = stripMarkdownNoise(value).trim().toLowerCase();
  const match = /^(s|m|l)(\b|:|\s|-)/.exec(normalized);

  return match?.[1]?.toUpperCase() ?? null;
}

function requireBulletField(section, sectionName, label, errors) {
  const value = readBulletField(section, label);

  if (value === null) {
    errors.push(`${sectionName}: missing field "${label}"`);
    return;
  }

  if (!isMeaningfulValue(value)) {
    errors.push(`${sectionName}: field "${label}" must be filled`);
  }
}

function requireTaskMode(section, errors) {
  const value = readBulletField(section, "Task mode");

  if (value === null) {
    errors.push("Issue / Objective: missing field \"Task mode\". Use S, M, or L.");
    return;
  }

  if (!isMeaningfulValue(value)) {
    errors.push("Issue / Objective: field \"Task mode\" must be filled with S, M, or L.");
    return;
  }

  const normalized = stripMarkdownNoise(value).trim().toLowerCase();

  if (!/^(s|m|l)(\b|:|\s|-)/.test(normalized)) {
    errors.push("Issue / Objective: field \"Task mode\" must start with S, M, or L.");
  }
}

function requireTaskState(section, errors) {
  const value = readBulletField(section, "Task state");

  if (value === null) {
    errors.push("Issue / Objective: missing field \"Task state\".");
    return;
  }

  if (!isMeaningfulValue(value)) {
    errors.push("Issue / Objective: field \"Task state\" must be filled.");
    return;
  }

  const normalized = stripMarkdownNoise(value).trim().toLowerCase();
  const state = [...allowedTaskStates].find((candidate) => normalized === candidate);

  if (!state) {
    errors.push(`Issue / Objective: field "Task state" must be exactly one of: ${[...allowedTaskStates].join(", ")}.`);
  }
}

function parseTaskState(section) {
  const value = readBulletField(section, "Task state");

  if (value === null || !isMeaningfulValue(value)) {
    return null;
  }

  const normalized = stripMarkdownNoise(value).trim().toLowerCase();

  return [...allowedTaskStates].find((candidate) => normalized === candidate) ?? null;
}

function requireReviewReadyTaskState(section, errors) {
  requireTaskState(section, errors);
  const state = parseTaskState(section);

  if (!state) {
    return;
  }

  if (state !== "review-ready" && state !== "complete") {
    errors.push("Issue / Objective: ready pull requests must use Task state \"review-ready\" or \"complete\".");
  }
}

function requireModelEffortField(section, sectionName, label, errors) {
  const value = readBulletField(section, label);

  if (value === null) {
    errors.push(`${sectionName}: missing field "${label}"`);
    return;
  }

  if (!isMeaningfulValue(value)) {
    errors.push(`${sectionName}: field "${label}" must be filled`);
    return;
  }

  const normalized = stripMarkdownNoise(value).trim().toLowerCase();
  const hasModelOrRuntime = /\b(gpt-5\.5|gpt-5\.4|codex|local-ci|web gpt|gpt runner|gpt-runner)\b/i.test(normalized);
  const effortTokens = [
    "xhigh",
    "high",
    "medium",
    "\u8d85\u9ad8",
    "\u9ad8",
    "\u4e2d"
  ];
  const hasEffort = effortTokens.some((token) => normalized.includes(token));

  if (!hasModelOrRuntime || !hasEffort) {
    errors.push(`${sectionName}: field "${label}" must name a model/runtime and effort: medium/high/xhigh or zhong/gao/chao-gao.`);
  }
}

function normalizePathForCheck(filePath) {
  return String(filePath ?? "").trim().replace(/\\/g, "/");
}

export function parseChangedFiles(source) {
  return String(source ?? "")
    .split(/\r?\n/)
    .map((line) => normalizePathForCheck(line))
    .filter((line) => line.length > 0);
}

export function parseNumstat(source) {
  return String(source ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [addedRaw, deletedRaw, ...fileParts] = line.split(/\t+/);
      const added = Number.parseInt(addedRaw, 10);
      const deleted = Number.parseInt(deletedRaw, 10);

      return {
        path: normalizePathForCheck(fileParts.join("\t")),
        added: Number.isFinite(added) ? added : 0,
        deleted: Number.isFinite(deleted) ? deleted : 0
      };
    })
    .filter((entry) => entry.path.length > 0);
}

function extractHighRiskTaskText(prBody) {
  const sections = parseMarkdownSections(prBody);
  const summarySection = sections.get(normalizeHeading("Summary")) ?? "";
  const issueSection = sections.get(normalizeHeading("Issue / Objective")) ?? "";
  const executionSection = sections.get(normalizeHeading("AI Execution Notes")) ?? "";
  const handoffSection = sections.get(normalizeHeading("Risk / Handoff")) ?? "";

  return [
    summarySection,
    readBulletField(issueSection, "Objective"),
    readBulletField(issueSection, "Acceptance checks"),
    readBulletField(executionSection, "Stop rules or constraints honored"),
    handoffSection
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

export function summarizeDiffFacts({ changedFiles = [], numstat = [] } = {}) {
  const fileSet = new Set(changedFiles.map((filePath) => normalizePathForCheck(filePath)).filter(Boolean));

  for (const entry of numstat) {
    if (entry?.path) {
      fileSet.add(normalizePathForCheck(entry.path));
    }
  }

  const files = [...fileSet].sort();
  const diffLines = numstat.reduce((total, entry) => total + (entry.added ?? 0) + (entry.deleted ?? 0), 0);
  const highRiskFiles = files.filter((filePath) => highRiskPathPatterns.some((pattern) => pattern.test(filePath)));

  return {
    files,
    fileCount: files.length,
    diffLines,
    highRiskFiles
  };
}

export function validateTaskModeAgainstDiff({ mode, diffFacts, prBody }) {
  const errors = [];

  if (!mode || !diffFacts) {
    return errors;
  }

  const hasHighRiskText = highRiskTextPattern.test(extractHighRiskTaskText(prBody ?? ""));
  const highRiskReasons = [
    ...diffFacts.highRiskFiles.map((filePath) => `high-risk path ${filePath}`),
    ...(hasHighRiskText ? ["high-risk task wording"] : [])
  ];

  if (mode === "S") {
    if (diffFacts.fileCount > 2) {
      errors.push(`Task mode S allows at most 2 changed files; found ${diffFacts.fileCount}. Use M or L.`);
    }

    if (diffFacts.diffLines > 80) {
      errors.push(`Task mode S allows small diffs only; found ${diffFacts.diffLines} changed lines. Use M or L.`);
    }

    if (highRiskReasons.length > 0) {
      errors.push(`Task mode S cannot include ${highRiskReasons.join(", ")}. Use L.`);
    }
  }

  if (mode === "M") {
    if (diffFacts.fileCount > 3) {
      errors.push(`Task mode M allows at most 3 changed files; found ${diffFacts.fileCount}. Split or use L.`);
    }

    if (diffFacts.diffLines > 300) {
      errors.push(`Task mode M allows at most 300 changed lines; found ${diffFacts.diffLines}. Split or use L.`);
    }

    if (highRiskReasons.length > 0) {
      errors.push(`Task mode M cannot include ${highRiskReasons.join(", ")}. Use L.`);
    }
  }

  return errors;
}

function requireCheckedBox(section, sectionName, label, errors) {
  if (!/- \[[xX]\]\s+\S/.test(section)) {
    errors.push(`${sectionName}: check at least one "${label}" checkbox`);
  }
}

export function validatePullRequestBody(markdown, options = {}) {
  const errors = [];
  const body = String(markdown ?? "").trim();

  if (body.length === 0) {
    return {
      ok: false,
      errors: ["Pull request body is empty."]
    };
  }

  const sections = parseMarkdownSections(body);

  for (const sectionName of requiredSections) {
    getRequiredSection(sections, sectionName, errors);
  }

  const issueSection = sections.get(normalizeHeading("Issue / Objective")) ?? "";
  requireTaskMode(issueSection, errors);
  requireReviewReadyTaskState(issueSection, errors);
  const taskMode = parseTaskMode(issueSection);
  requireBulletField(issueSection, "Issue / Objective", "Objective", errors);
  requireBulletField(issueSection, "Issue / Objective", "Acceptance checks", errors);
  requireCheckedBox(issueSection, "Issue / Objective", "Acceptance checks", errors);

  const executionSection = sections.get(normalizeHeading("AI Execution Notes")) ?? "";
  requireBulletField(executionSection, "AI Execution Notes", "Agent/runtime used", errors);
  requireModelEffortField(executionSection, "AI Execution Notes", "Model/effort used", errors);
  requireBulletField(executionSection, "AI Execution Notes", "Fallback model used", errors);
  requireBulletField(executionSection, "AI Execution Notes", "Files intentionally changed", errors);
  requireBulletField(executionSection, "AI Execution Notes", "Files intentionally not touched", errors);
  requireBulletField(executionSection, "AI Execution Notes", "Stop rules or constraints honored", errors);

  const validationSection = sections.get(normalizeHeading("Validation Evidence")) ?? "";
  requireBulletField(validationSection, "Validation Evidence", "Commands run", errors);
  requireBulletField(validationSection, "Validation Evidence", "Result", errors);
  requireBulletField(validationSection, "Validation Evidence", "Skipped checks and reason", errors);

  const releaseSection = sections.get(normalizeHeading("Release Evidence")) ?? "";
  requireCheckedBox(releaseSection, "Release Evidence", "release impact", errors);

  const handoffSection = sections.get(normalizeHeading("Risk / Handoff")) ?? "";
  requireBulletField(handoffSection, "Risk / Handoff", "Cross-platform impact", errors);
  requireBulletField(handoffSection, "Risk / Handoff", "External warnings or non-blocking follow-ups", errors);
  requireBulletField(handoffSection, "Risk / Handoff", "Next conversation should know", errors);

  if (options.diffFacts) {
    errors.push(...validateTaskModeAgainstDiff({
      mode: taskMode,
      diffFacts: options.diffFacts,
      prBody: body
    }));
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function parseArgs(argv) {
  const args = {
    bodyFile: null,
    changedFilesFile: null,
    numstatFile: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--body-file") {
      args.bodyFile = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--changed-files") {
      args.changedFilesFile = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--numstat") {
      args.numstatFile = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function readPullRequestBody(args) {
  if (args.bodyFile) {
    return readFile(path.resolve(args.bodyFile), "utf8");
  }

  return process.env.PR_BODY ?? "";
}

async function readDiffFacts(args) {
  if (!args.changedFilesFile && !args.numstatFile) {
    return null;
  }

  const changedFilesSource = args.changedFilesFile
    ? await readFile(path.resolve(args.changedFilesFile), "utf8")
    : "";
  const numstatSource = args.numstatFile
    ? await readFile(path.resolve(args.numstatFile), "utf8")
    : "";

  return summarizeDiffFacts({
    changedFiles: parseChangedFiles(changedFilesSource),
    numstat: parseNumstat(numstatSource)
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.PR_DRAFT === "true") {
    console.log("PR readiness check skipped for draft pull request.");
    return;
  }

  const body = await readPullRequestBody(args);
  const diffFacts = await readDiffFacts(args);
  const result = validatePullRequestBody(body, {
    diffFacts
  });

  if (!result.ok) {
    console.error("PR readiness check failed:");

    for (const error of result.errors) {
      console.error(`- ${error}`);
    }

    process.exitCode = 1;
    return;
  }

  console.log("PR readiness check passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
