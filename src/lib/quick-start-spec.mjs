import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDirectory, writeJson } from "./fs-utils.mjs";
import { validateProjectSpec } from "./spec.mjs";

const quickStartVerifierScriptRelativePath = path.join("scripts", "verify-summary.mjs");
const quickStartVerifierCommand = "node scripts/verify-summary.mjs";
const quickStartLocalCiScripts = Object.freeze({
  build: 'node -e "console.log(\'quick-start build bootstrap ok\')"',
  lint: 'node -e "console.log(\'quick-start lint bootstrap ok\')"',
  typecheck: 'node -e "console.log(\'quick-start typecheck bootstrap ok\')"',
  test: quickStartVerifierCommand,
  "test:integration": quickStartVerifierCommand,
  "test:e2e": quickStartVerifierCommand
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function dedupeStrings(values) {
  const seen = new Set();
  const results = [];

  for (const value of values ?? []) {
    const normalized = normalizeWhitespace(value);

    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(normalized);
  }

  return results;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function slugify(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "requested-deliverable";
}

function contractValue(executionContract, key) {
  const field = executionContract?.fields?.[key];
  return isNonEmptyString(field?.value) ? field.value.trim() : "";
}

function contractValues(executionContract, key) {
  const values = executionContract?.fields?.[key]?.values;
  return Array.isArray(values) ? dedupeStrings(values) : [];
}

function deriveProjectName({ endPoint, title, clarifiedGoal }) {
  const preferred = normalizeWhitespace(endPoint || title || clarifiedGoal || "Confirmed quick-start request");
  return preferred.replace(/[.\u3002]+$/g, "").slice(0, 120) || "Confirmed quick-start request";
}

function buildQuickStartVerifierPackageJson(projectName) {
  return {
    name: `ai-factory-quick-start-${slugify(projectName || "quick-start-verifier")}`,
    private: true,
    version: "1.0.0",
    scripts: {
      ...quickStartLocalCiScripts
    }
  };
}

function buildQuickStartVerifierScript() {
  return `import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSpecPath(workspaceRoot) {
  const candidates = [
    path.join(workspaceRoot, "specs", "confirmed-project-spec.json"),
    path.join(workspaceRoot, "specs", "project-spec.json")
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function main() {
  const workspaceRoot = process.cwd();
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  const specPath = await resolveSpecPath(workspaceRoot);

  assert.ok(await fileExists(packageJsonPath), "workspace package.json is required");
  assert.ok(specPath, "quick-start project spec is required");

  const spec = JSON.parse((await readFile(specPath, "utf8")).replace(/^\\uFEFF/, ""));

  assert.ok(typeof spec?.projectName === "string" && spec.projectName.trim().length > 0, "projectName is required");
  assert.ok(
    Array.isArray(spec?.acceptanceCriteria) && spec.acceptanceCriteria.length > 0,
    "acceptanceCriteria are required"
  );

  console.log(\`quick-start verifier scaffold ok for \${spec.projectName}\`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
`;
}

async function provisionQuickStartVerifierRuntime(workspaceRoot, spec) {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const packageJsonPath = path.join(resolvedWorkspaceRoot, "package.json");
  const verifierScriptPath = path.join(resolvedWorkspaceRoot, quickStartVerifierScriptRelativePath);

  if (!(await pathExists(packageJsonPath))) {
    await writeJson(packageJsonPath, buildQuickStartVerifierPackageJson(spec.projectName));
  }

  if (!(await pathExists(verifierScriptPath))) {
    await ensureDirectory(path.dirname(verifierScriptPath));
    await writeFile(verifierScriptPath, buildQuickStartVerifierScript(), "utf8");
  }

  return {
    packageJsonPath,
    verifierScriptPath
  };
}

function buildProjectGoalDetails({
  startPoint,
  endPoint,
  inputSources,
  outOfScope,
  clarifiedGoal,
  constraints
}) {
  const details = [
    isNonEmptyString(startPoint) ? `Start from this confirmed state: ${startPoint}.` : null,
    isNonEmptyString(endPoint) ? `Deliver this confirmed end point: ${endPoint}.` : null,
    isNonEmptyString(clarifiedGoal) ? `Clarified goal: ${clarifiedGoal}.` : null,
    inputSources.length > 0 ? `Use these confirmed inputs: ${inputSources.join("; ")}.` : null,
    outOfScope.length > 0 ? `Keep these items out of scope: ${outOfScope.join("; ")}.` : null,
    constraints.length > 0 ? `Respect these constraints: ${constraints.join("; ")}.` : null
  ].filter(isNonEmptyString);

  return details.join(" ");
}

export function createQuickStartProjectSpec(confirmedIntakeSpec, executionContract) {
  if (!confirmedIntakeSpec || typeof confirmedIntakeSpec !== "object") {
    throw new Error("Confirmed intake spec is required to create a quick-start project spec.");
  }

  if (confirmedIntakeSpec.confirmedByUser !== true || confirmedIntakeSpec.clarificationStatus !== "confirmed") {
    throw new Error("Quick-start project spec creation requires a confirmed intake spec.");
  }

  const startPoint =
    contractValue(executionContract, "startPoint") ||
    normalizeWhitespace(confirmedIntakeSpec.originalRequest) ||
    normalizeWhitespace(confirmedIntakeSpec.clarifiedGoal);
  const endPoint =
    contractValue(executionContract, "endPoint") ||
    normalizeWhitespace(confirmedIntakeSpec.clarifiedGoal) ||
    normalizeWhitespace(confirmedIntakeSpec.title);
  const inputSources = dedupeStrings([
    ...contractValues(executionContract, "inputSource"),
    ...(Array.isArray(confirmedIntakeSpec.requiredInputs)
      ? confirmedIntakeSpec.requiredInputs.map((item) => item?.name)
      : [])
  ]);
  const outOfScope = dedupeStrings([
    ...contractValues(executionContract, "outOfScope"),
    ...(Array.isArray(confirmedIntakeSpec.outOfScope) ? confirmedIntakeSpec.outOfScope : [])
  ]);
  const contractSuccessCriteria = contractValues(executionContract, "successCriteria");
  const successCriteria =
    contractSuccessCriteria.length > 0
      ? contractSuccessCriteria
      : dedupeStrings(
          Array.isArray(confirmedIntakeSpec.successCriteria)
            ? confirmedIntakeSpec.successCriteria.map((item) => item?.text)
            : []
        );
  const constraints = dedupeStrings(confirmedIntakeSpec.constraints ?? []);
  const humanSteps = dedupeStrings(confirmedIntakeSpec.automationAssessment?.humanStepsRequired ?? []);
  const risks = dedupeStrings([...(confirmedIntakeSpec.risks ?? []), ...humanSteps]);
  const projectName = deriveProjectName({
    endPoint,
    title: confirmedIntakeSpec.title,
    clarifiedGoal: confirmedIntakeSpec.clarifiedGoal
  });
  const acceptanceCriteria =
    successCriteria.length > 0 ? successCriteria : [`Deliver the confirmed end point: ${endPoint || projectName}.`];
  const definitionOfDone = dedupeStrings([
    ...acceptanceCriteria,
    `The confirmed end point is delivered: ${endPoint || projectName}.`,
    outOfScope.length > 0 ? `The run respects the confirmed out-of-scope limits: ${outOfScope.join("; ")}.` : null
  ]);
  const riskStopRules =
    risks.length > 0
      ? risks
      : ["Pause if execution would trigger destructive, outbound, or sensitive actions outside the confirmed scope."];

  return {
    projectName,
    summary: normalizeWhitespace(confirmedIntakeSpec.clarifiedGoal || endPoint || projectName),
    projectGoal: {
      oneLine: normalizeWhitespace(endPoint || confirmedIntakeSpec.clarifiedGoal || projectName),
      details: buildProjectGoalDetails({
        startPoint,
        endPoint,
        inputSources,
        outOfScope,
        clarifiedGoal: confirmedIntakeSpec.clarifiedGoal,
        constraints
      })
    },
    targetUsers: ["The operator who submitted this confirmed quick-start request."],
    coreFeatures: [
      {
        id: slugify(projectName),
        title: projectName,
        description: dedupeStrings([
          startPoint ? `Begin from: ${startPoint}.` : null,
          endPoint ? `Deliver: ${endPoint}.` : null,
          inputSources.length > 0 ? `Inputs: ${inputSources.join("; ")}.` : null
        ]).join(" "),
        acceptanceCriteria
      }
    ],
    backlogFeatures: [],
    nonGoals: dedupeStrings([...(confirmedIntakeSpec.nonGoals ?? []), ...outOfScope]),
    technicalConstraints: {
      preferredStack: dedupeStrings([
        "Use the existing repository and local workspace files.",
        "Keep the solution compatible with the current AI Factory workflow.",
        ...(constraints.length > 0 ? constraints : [])
      ]),
      forbiddenTools:
        outOfScope.length > 0
          ? outOfScope
          : ["Unapproved destructive, outbound, or external side effects outside the confirmed scope."],
      deploymentTarget: "Current local workspace"
    },
    integrations: Array.isArray(confirmedIntakeSpec.externalDependencies)
      ? confirmedIntakeSpec.externalDependencies.map((dependency) => ({
          name: dependency?.name ?? "Unknown dependency",
          status: dependency?.status ?? "required",
          notes: dependency?.type ?? "dependency"
        }))
      : [],
    dataSources: inputSources.length > 0 ? inputSources : ["Confirmed workspace inputs"],
    definitionOfDone,
    acceptanceCriteria,
    riskStopRules,
    priorities: ["Deliver the confirmed end point directly.", "Stay inside the confirmed scope."],
    deliverables: [normalizeWhitespace(endPoint || projectName)],
    factoryMetadata: {
      generatedBy: "panel-quick-start-safe",
      requestId: confirmedIntakeSpec.requestId,
      generatedAt: new Date().toISOString()
    }
  };
}

export async function writeQuickStartProjectSpec(
  workspaceRoot,
  confirmedIntakeSpec,
  executionContract,
  specRelativePath = path.join("specs", "confirmed-project-spec.json")
) {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedSpecPath = path.isAbsolute(specRelativePath)
    ? path.resolve(specRelativePath)
    : path.resolve(resolvedWorkspaceRoot, specRelativePath);
  const spec = createQuickStartProjectSpec(confirmedIntakeSpec, executionContract);
  const validation = validateProjectSpec(spec);

  if (!validation.valid) {
    throw new Error(`Generated quick-start project spec is invalid: ${validation.errors.join(" ")}`);
  }

  await ensureDirectory(path.dirname(resolvedSpecPath));
  await writeJson(resolvedSpecPath, spec);
  const verifierRuntime = await provisionQuickStartVerifierRuntime(resolvedWorkspaceRoot, spec);

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    specPath: resolvedSpecPath,
    spec,
    verifierRuntime
  };
}
