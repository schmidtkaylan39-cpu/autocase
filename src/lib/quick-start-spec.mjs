import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import { validateProjectSpec } from "./spec.mjs";

const quickStartVerifierScriptRelativePath = path.join("scripts", "verify-summary.mjs");
const quickStartVerifierCommand = "node scripts/verify-summary.mjs";
const quickStartReservedVerifyScriptName = "quick-start:verify-output";
const quickStartLocalCiScripts = Object.freeze({
  build: 'node -e "console.log(\'quick-start build bootstrap ok\')"',
  lint: 'node -e "console.log(\'quick-start lint bootstrap ok\')"',
  typecheck: 'node -e "console.log(\'quick-start typecheck bootstrap ok\')"',
  test: quickStartVerifierCommand,
  "test:integration": quickStartVerifierCommand,
  "test:e2e": quickStartVerifierCommand,
  [quickStartReservedVerifyScriptName]: quickStartVerifierCommand
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

function mergeQuickStartVerifierPackageJson(existingPackageJson, projectName) {
  if (!existingPackageJson || typeof existingPackageJson !== "object" || Array.isArray(existingPackageJson)) {
    return buildQuickStartVerifierPackageJson(projectName);
  }

  const existingScripts =
    existingPackageJson.scripts &&
    typeof existingPackageJson.scripts === "object" &&
    !Array.isArray(existingPackageJson.scripts)
      ? existingPackageJson.scripts
      : {};

  return {
    ...existingPackageJson,
    private: typeof existingPackageJson.private === "boolean" ? existingPackageJson.private : true,
    scripts: {
      ...quickStartLocalCiScripts,
      ...existingScripts,
      [quickStartReservedVerifyScriptName]: quickStartVerifierCommand
    }
  };
}

function hashTextSha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function normalizeRelativePathString(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }

  const normalized = value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[),.;:!?]+$/g, "")
    .replace(/[。；：，）】》」』！？]+$/u, "")
    .replace(/\\/g, "/");

  if (!normalized || normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("..\\")) {
    return null;
  }

  if (path.isAbsolute(normalized)) {
    return null;
  }

  return normalized;
}

function collectPathCandidatesFromText(text) {
  const candidates = [];
  const pattern = /(?:^|[\s("'`])((?:[a-z0-9._-]+[\\/])+[a-z0-9._-]+\.[a-z0-9._-]+)(?=$|[\s)"'`,.;:])/gi;

  for (const match of String(text ?? "").matchAll(pattern)) {
    const normalized = normalizeRelativePathString(match[1]);
    if (normalized) {
      candidates.push(normalized);
    }
  }

  return dedupeStrings(candidates);
}

function extractImmutableInputPaths(dataSources, artifactPath) {
  const dataSourceCandidates = dedupeStrings(
    (dataSources ?? []).flatMap((dataSource) => collectPathCandidatesFromText(dataSource))
  );

  return dataSourceCandidates.filter((candidate) => candidate !== artifactPath);
}

function extractRequestedArtifactPath(acceptanceCriteria, deliverables) {
  const criteriaCandidates = dedupeStrings(
    (acceptanceCriteria ?? []).flatMap((criterion) => collectPathCandidatesFromText(criterion))
  );
  const deliverableCandidates = dedupeStrings(
    (deliverables ?? []).flatMap((deliverable) => collectPathCandidatesFromText(deliverable))
  );
  const allCandidates = dedupeStrings([...criteriaCandidates, ...deliverableCandidates]);
  const artifactCandidate = allCandidates.find((candidate) => /(^|\/)artifacts\//i.test(candidate));
  const markdownCandidate =
    artifactCandidate && /\.md$/i.test(artifactCandidate)
      ? artifactCandidate
      : allCandidates.find((candidate) => /\.md$/i.test(candidate));

  return normalizeRelativePathString(markdownCandidate ?? artifactCandidate ?? allCandidates[0] ?? "");
}

function extractTokenSourcePaths(acceptanceCriteria, artifactPath) {
  const sources = [];

  for (const criterion of acceptanceCriteria ?? []) {
    if (!/\btoken\b/i.test(criterion)) {
      continue;
    }

    const explicitFromMatches = String(criterion).matchAll(
      /\bfrom\s+([`"'a-z0-9._\-\\/]+(?:\.[a-z0-9._-]+)?)/gi
    );
    let matchedExplicitSource = false;

    for (const match of explicitFromMatches) {
      const normalized = normalizeRelativePathString(match[1]);
      if (normalized && normalized !== artifactPath) {
        sources.push(normalized);
        matchedExplicitSource = true;
      }
    }

    if (matchedExplicitSource) {
      continue;
    }

    const fallbackCandidates = collectPathCandidatesFromText(criterion);
    for (const candidate of fallbackCandidates) {
      if (candidate !== artifactPath) {
        sources.push(candidate);
      }
    }
  }

  return dedupeStrings(sources);
}

function extractExactTokens(acceptanceCriteria) {
  const tokens = [];

  for (const criterion of acceptanceCriteria ?? []) {
    for (const match of String(criterion).matchAll(/\bexact token\s+([^\s;,.]+)/gi)) {
      tokens.push(match[1]);
    }
  }

  return dedupeStrings(tokens);
}

function extractRequiredHeading(acceptanceCriteria) {
  for (const criterion of acceptanceCriteria ?? []) {
    const namedMatch = /\bheading\s+(?:named|called)\s+["'`]?([^"'`.;:]+)["'`]?/i.exec(String(criterion));

    if (namedMatch) {
      const heading = normalizeWhitespace(namedMatch[1]);
      if (heading) {
        return heading;
      }
    }

    if (/\bcombined notes\b/i.test(String(criterion))) {
      return "Combined Notes";
    }
  }

  return null;
}

function extractRequiresChineseText(acceptanceCriteria) {
  return (acceptanceCriteria ?? []).some((criterion) =>
    /\bchinese\b|中文|汉字|漢字|\bhan\b/i.test(String(criterion))
  );
}

function extractRequiresChineseTextFromCriteria(acceptanceCriteria) {
  if (extractRequiresChineseText(acceptanceCriteria)) {
    return true;
  }

  return (acceptanceCriteria ?? []).some((criterion) =>
    /\bchinese\b|\u4e2d\u6587|\u6c49\u5b57|\u6f22\u5b57|\bhan\b/i.test(String(criterion))
  );
}

function buildQuickStartVerifierContract(spec) {
  const acceptanceCriteria = dedupeStrings(
    Array.isArray(spec?.acceptanceCriteria) ? spec.acceptanceCriteria : []
  );
  const deliverables = dedupeStrings(Array.isArray(spec?.deliverables) ? spec.deliverables : []);
  const dataSources = dedupeStrings(Array.isArray(spec?.dataSources) ? spec.dataSources : []);
  const artifactPath =
    extractRequestedArtifactPath(acceptanceCriteria, deliverables) ??
    path.posix.join("artifacts", "generated", "summary.md");

  return {
    artifactPath,
    requiredExactTokens: extractExactTokens(acceptanceCriteria),
    requiredTokenSourcePaths: extractTokenSourcePaths(acceptanceCriteria, artifactPath),
    requiredHeading: extractRequiredHeading(acceptanceCriteria),
    requireChineseText: extractRequiresChineseTextFromCriteria(acceptanceCriteria),
    immutableInputPaths: extractImmutableInputPaths(dataSources, artifactPath),
    immutableInputSnapshots: []
  };
}

async function captureImmutableInputSnapshots(workspaceRoot, inputPaths) {
  const snapshots = [];

  for (const relativePath of inputPaths ?? []) {
    const normalizedPath = normalizeRelativePathString(relativePath);

    if (!normalizedPath) {
      continue;
    }

    const absolutePath = path.join(workspaceRoot, normalizedPath);
    const exists = await pathExists(absolutePath);

    if (!exists) {
      continue;
    }

    const contents = await readFile(absolutePath, "utf8");
    snapshots.push({
      relativePath: normalizedPath,
      exists: true,
      sha256: hashTextSha256(contents)
    });
  }

  return snapshots;
}

async function buildQuickStartVerifierContractForWorkspace(workspaceRoot, spec) {
  const baseContract = buildQuickStartVerifierContract(spec);
  const immutableInputSnapshots = await captureImmutableInputSnapshots(
    workspaceRoot,
    baseContract.immutableInputPaths
  );

  return {
    ...baseContract,
    immutableInputSnapshots
  };
}

function buildQuickStartVerifierScript(verifierContract) {
  const serializedContract = JSON.stringify(verifierContract ?? {}, null, 2);

  return `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const verifierContract = ${serializedContract};

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^\\\${}()|[\\]\\\\]/g, "\\\\$&");
}

function extractTokenFromInput(content, inputPath) {
  const tokenMatch =
    /\\btoken\\s*:\\s*(\\S+)/i.exec(content) ??
    /\\bbrief token\\s*:\\s*(\\S+)/i.exec(content) ??
    /\\bdetails token\\s*:\\s*(\\S+)/i.exec(content);

  assert.ok(tokenMatch?.[1], \`Expected token marker in \${inputPath}\`);
  return tokenMatch[1];
}

function hashTextSha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
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
  assert.ok(
    typeof verifierContract?.artifactPath === "string" && verifierContract.artifactPath.length > 0,
    "artifactPath is required in quick-start verifier contract"
  );

  const artifactPath = path.join(workspaceRoot, verifierContract.artifactPath);
  const artifactContent = await readFile(artifactPath, "utf8");

  for (const token of verifierContract.requiredExactTokens ?? []) {
    assert.match(
      artifactContent,
      new RegExp(escapeRegExp(token)),
      \`Expected output artifact to include exact token \${token}\`
    );
  }

  for (const snapshot of verifierContract.immutableInputSnapshots ?? []) {
    const inputPath = path.join(workspaceRoot, snapshot.relativePath);
    const stillExists = await fileExists(inputPath);

    assert.equal(
      stillExists,
      snapshot.exists === true,
      \`Expected input source existence to stay unchanged for \${snapshot.relativePath}\`
    );

    if (snapshot.exists !== true) {
      continue;
    }

    const currentContents = await readFile(inputPath, "utf8");
    assert.equal(
      hashTextSha256(currentContents),
      snapshot.sha256,
      \`Input source changed unexpectedly: \${snapshot.relativePath}\`
    );
  }

  for (const sourcePath of verifierContract.requiredTokenSourcePaths ?? []) {
    const resolvedSourcePath = path.join(workspaceRoot, sourcePath);
    const sourceContent = await readFile(resolvedSourcePath, "utf8");
    const token = extractTokenFromInput(sourceContent, sourcePath);
    assert.match(
      artifactContent,
      new RegExp(escapeRegExp(token)),
      \`Expected output artifact to include token from \${sourcePath}\`
    );
  }

  if (typeof verifierContract.requiredHeading === "string" && verifierContract.requiredHeading.trim().length > 0) {
    assert.match(
      artifactContent,
      new RegExp(\`^#{1,6}\\\\s+\${escapeRegExp(verifierContract.requiredHeading)}\\\\b\`, "m"),
      \`Expected output artifact to include heading "\${verifierContract.requiredHeading}"\`
    );
  }

  if (verifierContract.requireChineseText === true) {
    assert.match(artifactContent, /\\p{Script=Han}/u, "output artifact should contain Chinese text");
  }

  console.log(\`quick-start verifier checks passed for \${spec.projectName}\`);
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
  const verifierContract = await buildQuickStartVerifierContractForWorkspace(resolvedWorkspaceRoot, spec);

  if (!(await pathExists(packageJsonPath))) {
    await writeJson(packageJsonPath, buildQuickStartVerifierPackageJson(spec.projectName));
  } else {
    const existingPackageJson = await readJson(packageJsonPath);
    const mergedPackageJson = mergeQuickStartVerifierPackageJson(existingPackageJson, spec.projectName);

    await writeJson(packageJsonPath, mergedPackageJson);
  }

  await ensureDirectory(path.dirname(verifierScriptPath));
  await writeFile(verifierScriptPath, buildQuickStartVerifierScript(verifierContract), "utf8");

  return {
    packageJsonPath,
    verifierScriptPath,
    verifierContract
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
      generatedAt: new Date().toISOString(),
      quickStartVerifierContract: buildQuickStartVerifierContract({
        acceptanceCriteria,
        deliverables: [normalizeWhitespace(endPoint || projectName)],
        dataSources: inputSources
      })
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
