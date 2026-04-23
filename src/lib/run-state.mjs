import path from "node:path";

import { buildNextActions, summarizeRunState } from "./run-state-lifecycle.mjs";

export {
  buildNextActions,
  refreshRunState,
  summarizeRunState,
  updateTaskInRunState
} from "./run-state-lifecycle.mjs";

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function compactTimestamp(timestamp) {
  return timestamp.replace(/[-:TZ.]/g, "").slice(0, 14);
}

function createPlanningTask(plan) {
  return {
    id: "planning-brief",
    phaseId: "planning",
    role: "planner",
    owner: plan.architecture.planner,
    title: "Clarify the brief and execution sequence",
    description:
      "Turn the incoming brief, risk rules, and acceptance rules into a clean execution-ready handoff.",
    status: "ready",
    attempts: 0,
    dependsOn: [],
    acceptanceCriteria: [
      "Requirements are broken into actionable work items",
      "Risk stop rules are clarified",
      "Definition of done and acceptance rules are clarified"
    ]
  };
}

function createImplementationTask(feature, retriesBeforeReplan) {
  return {
    id: `implement-${feature.id}`,
    phaseId: "implementation",
    role: "executor",
    owner: "Codex",
    title: `Implement feature: ${feature.title}`,
    description: feature.description,
    status: "pending",
    attempts: 0,
    dependsOn: ["planning-brief"],
    acceptanceCriteria: feature.acceptanceCriteria,
    retriesBeforeReplan
  };
}

function createReviewTask(feature) {
  return {
    id: `review-${feature.id}`,
    phaseId: "review",
    role: "reviewer",
    owner: "Independent reviewer",
    title: `Review feature: ${feature.title}`,
    description:
      `Check whether ${feature.title} matches the requirement, covers the important edge cases, and avoids obvious quality or security issues.`,
    status: "pending",
    attempts: 0,
    dependsOn: [`implement-${feature.id}`],
    acceptanceCriteria: [
      "Implementation matches the requirement",
      "The result is not only surface-level",
      "Core flows include meaningful validation",
      "There are no obvious security or maintainability issues"
    ]
  };
}

function createVerificationTask(feature, mandatoryGates) {
  return {
    id: `verify-${feature.id}`,
    phaseId: "verification",
    role: "verifier",
    owner: "CI / automated test system",
    title: `Verify feature: ${feature.title}`,
    description: `Use automated checks to validate the delivery quality of ${feature.title}.`,
    status: "pending",
    attempts: 0,
    dependsOn: [`review-${feature.id}`],
    gates: mandatoryGates,
    acceptanceCriteria: mandatoryGates.map((gate) => `${gate} passes`)
  };
}

function createDeliveryTask(plan) {
  const dependencies = plan.phases
    .find((phase) => phase.id === "verification")
    ?.tasks?.map((task) => task.id.replace("verify-", "verify-")) ?? [];

  return {
    id: "delivery-package",
    phaseId: "delivery",
    role: "orchestrator",
    owner: plan.architecture.orchestrator,
    title: "Assemble the delivery package",
    description:
      "Collect the final artifacts, reports, test results, and known limitations into a delivery-ready package.",
    status: "pending",
    attempts: 0,
    dependsOn: dependencies,
    acceptanceCriteria: plan.definitionOfDone
  };
}

export function createRunState(
  spec,
  plan,
  config,
  requestedRunId,
  workspacePath = process.cwd(),
  intake = null
) {
  const createdAt = new Date().toISOString();
  const runId = requestedRunId || `${slugify(spec.projectName)}-${compactTimestamp(createdAt)}`;
  const implementationTasks = spec.coreFeatures.map((feature) =>
    createImplementationTask(feature, config.retryPolicy.implementation)
  );
  const reviewTasks = spec.coreFeatures.map((feature) => createReviewTask(feature));
  const verificationTasks = spec.coreFeatures.map((feature) =>
    createVerificationTask(feature, config.mandatoryGates)
  );
  const taskLedger = [
    createPlanningTask(plan),
    ...implementationTasks,
    ...reviewTasks,
    ...verificationTasks
  ];

  const verificationIds = verificationTasks.map((task) => task.id);
  const deliveryTask = {
    ...createDeliveryTask(plan),
    dependsOn: verificationIds
  };

  taskLedger.push(deliveryTask);

  return {
    version: 1,
    runId,
    projectName: spec.projectName,
    workspacePath,
    createdAt,
    updatedAt: createdAt,
    status: "planned",
    summary: {
      totalTasks: taskLedger.length,
      readyTasks: taskLedger.filter((task) => task.status === "ready").length,
      pendingTasks: taskLedger.filter((task) => task.status === "pending").length,
      completedTasks: 0,
      failedTasks: 0
    },
    roles: config.roles,
    retryPolicy: config.retryPolicy,
    runtimeRouting: config.runtimeRouting,
    modelPolicy: config.modelPolicy,
    mandatoryGates: config.mandatoryGates,
    intake,
    stopConditions: spec.riskStopRules,
    definitionOfDone: spec.definitionOfDone,
    taskLedger,
    nextActions: buildNextActions(taskLedger)
  };
}

export function renderTaskBrief(spec, runState, task) {
  const lines = [
    `# Task Brief: ${task.title}`,
    "",
    `- Run ID: ${runState.runId}`,
    `- Project: ${spec.projectName}`,
    `- Role: ${task.role}`,
    `- Owner: ${task.owner}`,
    `- Current status: ${task.status}`,
    `- Workspace root: ${runState.workspacePath ?? process.cwd()}`,
    "",
    "## Task Description",
    task.description,
    "",
    "## Acceptance Criteria",
    ...task.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Dependencies",
    ...(task.dependsOn.length > 0 ? task.dependsOn.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Risk Stop Rules",
    ...runState.stopConditions.map((item) => `- ${item}`),
    "",
    "## Project Summary",
    `- Goal: ${spec.projectGoal.oneLine}`,
    `- Focus: ${task.title}`,
    "",
    "## Execution Rules",
    "- Do not claim the whole project is complete from this task alone.",
    "- Stop immediately if a risk-stop rule is triggered.",
    "- Leave behind verifiable artifacts after every meaningful change."
  ];

  if (Array.isArray(task.gates) && task.gates.length > 0) {
    lines.push("", "## Mandatory Gates", ...task.gates.map((gate) => `- ${gate}`));
  }

  return lines.join("\n");
}

export function renderRunReport(runState, plan) {
  const summary = summarizeRunState(runState);
  const intakeSection = runState.intake
    ? [
        "",
        "## Intake Gate",
        `- Request ID: ${runState.intake.requestId}`,
        `- Title: ${runState.intake.title}`,
        `- Clarification status: ${runState.intake.clarificationStatus}`,
        `- Confirmed by user: ${runState.intake.confirmedByUser ? "yes" : "no"}`,
        `- Recommended next step: ${runState.intake.recommendedNextStep}`,
        `- Intake spec: ${runState.intake.artifactPaths?.intakeSpecPath ?? "unknown"}`,
        `- Intake summary: ${runState.intake.artifactPaths?.intakeSummaryPath ?? "unknown"}`
      ]
    : [];

  return [
    `# ${runState.projectName} Run Report`,
    "",
    `- Run ID: ${summary.runId}`,
    `- Status: ${summary.status}`,
    `- Created at: ${runState.createdAt}`,
    `- Total tasks: ${summary.totalTasks}`,
    `- Ready: ${summary.readyTasks}`,
    `- Pending: ${summary.pendingTasks}`,
    `- Waiting retry: ${summary.waitingRetryTasks}`,
    `- Completed: ${summary.completedTasks}`,
    `- Blocked: ${summary.blockedTasks}`,
    `- Failed: ${summary.failedTasks}`,
    "",
    "## Role Configuration",
    ...Object.entries(runState.roles).map(
      ([roleId, settings]) => `- ${roleId}: ${settings.tool} (${settings.automation})`
    ),
    ...intakeSection,
    "",
    "## Task Ledger",
    ...runState.taskLedger.map((task) => `- [${task.status}] ${task.id} -> ${task.title}`),
    "",
    "## Next Actions",
    ...(runState.nextActions.length > 0
      ? runState.nextActions.map((action) => `- ${action.role} -> ${action.title}`)
      : ["- No ready tasks at the moment."]),
    "",
    "## Waiting Retry",
    ...(runState.taskLedger.some((task) => task.status === "waiting_retry")
      ? runState.taskLedger
          .filter((task) => task.status === "waiting_retry")
          .map(
            (task) =>
              `- ${task.id} retry at ${task.nextRetryAt ?? "unscheduled"} (${task.lastRetryReason ?? "no reason recorded"})`
          )
      : ["- No tasks are waiting for a timed retry."]),
    "",
    "## Risk Stop Rules",
    ...runState.stopConditions.map((rule) => `- ${rule}`),
    "",
    "## Definition of Done",
    ...plan.definitionOfDone.map((item) => `- ${item}`)
  ].join("\n");
}

export function createArtifactPaths(baseDirectory, config, runId) {
  const runDirectory = path.resolve(baseDirectory, runId);

  return {
    runDirectory,
    briefsDirectory: path.join(runDirectory, config.artifacts.briefDirectory),
    planJsonPath: path.join(runDirectory, config.artifacts.planJsonFile),
    planMarkdownPath: path.join(runDirectory, config.artifacts.planMarkdownFile),
    statePath: path.join(runDirectory, config.artifacts.stateFile),
    reportPath: path.join(runDirectory, config.artifacts.reportFile),
    rolesPath: path.join(runDirectory, config.artifacts.rolesFile),
    specSnapshotPath: path.join(runDirectory, config.artifacts.specSnapshotFile)
  };
}
