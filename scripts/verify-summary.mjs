import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const verifierContract = {
  "artifactPath": "artifacts/generated/rich-summary.md",
  "requiredExactTokens": [],
  "requiredTokenSourcePaths": [],
  "requiredHeading": null,
  "requireChineseText": false,
  "immutableInputPaths": [],
  "immutableInputSnapshots": []
};

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
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTokenFromInput(content, inputPath) {
  const tokenMatch =
    /\btoken\s*:\s*(\S+)/i.exec(content) ??
    /\bbrief token\s*:\s*(\S+)/i.exec(content) ??
    /\bdetails token\s*:\s*(\S+)/i.exec(content);

  assert.ok(tokenMatch?.[1], `Expected token marker in ${inputPath}`);
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

  const spec = JSON.parse((await readFile(specPath, "utf8")).replace(/^\uFEFF/, ""));

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
      `Expected output artifact to include exact token ${token}`
    );
  }

  for (const snapshot of verifierContract.immutableInputSnapshots ?? []) {
    const inputPath = path.join(workspaceRoot, snapshot.relativePath);
    const stillExists = await fileExists(inputPath);

    assert.equal(
      stillExists,
      snapshot.exists === true,
      `Expected input source existence to stay unchanged for ${snapshot.relativePath}`
    );

    if (snapshot.exists !== true) {
      continue;
    }

    const currentContents = await readFile(inputPath, "utf8");
    assert.equal(
      hashTextSha256(currentContents),
      snapshot.sha256,
      `Input source changed unexpectedly: ${snapshot.relativePath}`
    );
  }

  for (const sourcePath of verifierContract.requiredTokenSourcePaths ?? []) {
    const resolvedSourcePath = path.join(workspaceRoot, sourcePath);
    const sourceContent = await readFile(resolvedSourcePath, "utf8");
    const token = extractTokenFromInput(sourceContent, sourcePath);
    assert.match(
      artifactContent,
      new RegExp(escapeRegExp(token)),
      `Expected output artifact to include token from ${sourcePath}`
    );
  }

  if (typeof verifierContract.requiredHeading === "string" && verifierContract.requiredHeading.trim().length > 0) {
    assert.match(
      artifactContent,
      new RegExp(`^#{1,6}\\s+${escapeRegExp(verifierContract.requiredHeading)}\\b`, "m"),
      `Expected output artifact to include heading "${verifierContract.requiredHeading}"`
    );
  }

  if (verifierContract.requireChineseText === true) {
    assert.match(artifactContent, /\p{Script=Han}/u, "output artifact should contain Chinese text");
  }

  console.log(`quick-start verifier checks passed for ${spec.projectName}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
