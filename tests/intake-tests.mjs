import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  confirmIntake,
  createRunHandoffs,
  intakeRequest,
  planProject,
  reviseIntake,
  runProject,
  updateRunTask
} from "../src/lib/commands.mjs";
import { dispatchHandoffs } from "../src/lib/dispatch.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validSpecPath = path.join(projectRoot, "examples", "project-spec.valid.json");

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function createWorkspaceSpec(workspaceRoot) {
  const specPath = path.join(workspaceRoot, "specs", "project-spec.json");
  await mkdir(path.join(workspaceRoot, "specs"), { recursive: true });
  await cp(validSpecPath, specPath);
  return specPath;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function main() {
  await runTest("intake writes clarification artifacts for a vague request", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-intake-vague-"));
    const result = await intakeRequest("幫我把報表自動化", workspaceRoot);
    const spec = await readJson(result.artifactPaths.intakeSpecPath);
    const summary = await readFile(result.artifactPaths.intakeSummaryPath, "utf8");

    await stat(result.artifactPaths.intakeSpecPath);
    await stat(result.artifactPaths.intakeSummaryPath);
    assert.equal(spec.clarificationStatus, "clarifying");
    assert.equal(spec.confirmedByUser, false);
    assert.ok(Array.isArray(spec.openQuestions) && spec.openQuestions.length > 0);
    assert.match(summary, /Open Questions/);
  });

  await runTest("unconfirmed intake blocks plan and run", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-intake-plan-gate-"));
    const specPath = await createWorkspaceSpec(workspaceRoot);

    await intakeRequest("幫我把報表自動化", workspaceRoot);

    await assert.rejects(
      () => planProject(specPath, path.join(workspaceRoot, "runs")),
      /clarification gate is not satisfied/i
    );
    await assert.rejects(
      () => runProject(specPath, path.join(workspaceRoot, "runs"), "blocked-run"),
      /clarification gate is not satisfied/i
    );
  });

  await runTest("unconfirmed intake blocks handoff generation and dispatch", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-intake-exec-gate-"));
    const specPath = await createWorkspaceSpec(workspaceRoot);
    const runResult = await runProject(specPath, path.join(workspaceRoot, "runs"), "pre-intake-run");

    await updateRunTask(runResult.statePath, "planning-brief", "completed", "planner finished");
    const handoffResult = await createRunHandoffs(runResult.statePath);

    await intakeRequest("幫我把報表自動化", workspaceRoot);

    await assert.rejects(
      () => createRunHandoffs(runResult.statePath),
      /clarification gate is not satisfied/i
    );
    await assert.rejects(
      () => dispatchHandoffs(handoffResult.indexPath, "dry-run"),
      /clarification gate is not satisfied/i
    );
  });

  await runTest("requests involving email CRM and internal tools capture access needs and human steps", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-intake-access-"));
    const result = await intakeRequest(
      "幫我從 internal CRM 自動寄 email 給客戶，並同步回 Salesforce 後台",
      workspaceRoot
    );

    const spec = result.spec;
    const systems = spec.requiredAccountsAndPermissions.map((item) => item.system);

    assert.ok(systems.includes("Email platform"));
    assert.ok(systems.includes("CRM"));
    assert.ok(systems.includes("Internal tool"));
    assert.equal(spec.automationAssessment.canFullyAutomate, false);
    assert.ok(spec.automationAssessment.humanStepsRequired.length > 0);
    assert.ok(spec.openQuestions.some((item) => item.category === "permissions"));
  });

  await runTest("a clear local-only intake can be confirmed and then allow planning and run creation", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-intake-confirm-"));
    const specPath = await createWorkspaceSpec(workspaceRoot);

    const intakeResult = await intakeRequest(
      "從本地 sales.json 讀取資料，產出 summary.md 到 artifacts/reports；不要寄信、不要外部 API。",
      workspaceRoot
    );

    assert.equal(intakeResult.spec.clarificationStatus, "awaiting_confirmation");

    const confirmResult = await confirmIntake(workspaceRoot);
    const confirmedSpec = await readJson(confirmResult.artifactPaths.intakeSpecPath);
    const planResult = await planProject(specPath, path.join(workspaceRoot, "plans"));
    const runResult = await runProject(specPath, path.join(workspaceRoot, "runs"), "confirmed-run");
    const runState = await readJson(runResult.statePath);

    assert.equal(confirmedSpec.clarificationStatus, "confirmed");
    assert.equal(confirmedSpec.confirmedByUser, true);
    assert.equal(confirmedSpec.recommendedNextStep, "planning-ready");
    assert.equal(planResult.ok, true);
    assert.equal(runResult.ok, true);
    assert.equal(runState.intake?.clarificationStatus, "confirmed");
    assert.equal(runState.intake?.confirmedByUser, true);
  });

  await runTest("blocked confirmation can be revised back into an active clarification state", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-intake-revise-"));

    await intakeRequest("幫我把報表自動化", workspaceRoot);
    await assert.rejects(() => confirmIntake(workspaceRoot), /Cannot confirm intake yet/i);

    const blockedSpecPath = path.join(workspaceRoot, "artifacts", "clarification", "intake-spec.json");
    const blockedSpec = await readJson(blockedSpecPath);
    assert.equal(blockedSpec.clarificationStatus, "clarification_blocked");

    const revisedResult = await reviseIntake(
      "從本地 sales.json 讀取資料，產出 summary.md 到 artifacts/reports；不要寄信、不要外部 API。",
      workspaceRoot
    );

    assert.ok(["clarifying", "awaiting_confirmation"].includes(revisedResult.spec.clarificationStatus));
    assert.equal(revisedResult.spec.confirmedByUser, false);
    assert.notEqual(revisedResult.spec.clarificationStatus, "clarification_blocked");
  });

  console.log("Intake tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
