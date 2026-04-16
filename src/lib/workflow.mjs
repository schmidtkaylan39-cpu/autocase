function createImplementationTask(feature, order) {
  return {
    id: `implement-${feature.id}`,
    order,
    owner: "Codex",
    title: `Implement feature: ${feature.title}`,
    description: feature.description,
    acceptanceCriteria: feature.acceptanceCriteria,
    retriesBeforeReplan: 3
  };
}

function createReviewTask(feature, order) {
  return {
    id: `review-${feature.id}`,
    order,
    owner: "reviewer",
    title: `Review feature: ${feature.title}`,
    checklist: [
      "Confirm the feature matches the original requirement",
      "Confirm it is not only superficially implemented",
      "Confirm the core flow is covered by tests",
      "Confirm there are no obvious security risks"
    ],
    tiedFeatureId: feature.id
  };
}

function createVerificationTask(feature, order, mandatoryGates) {
  return {
    id: `verify-${feature.id}`,
    order,
    owner: "verifier",
    title: `Verify feature: ${feature.title}`,
    gates: mandatoryGates,
    tiedFeatureId: feature.id
  };
}

export function buildExecutionPlan(spec) {
  const mandatoryGates = ["build", "lint", "typecheck", "unit test", "integration test", "e2e test"];
  const implementationTasks = spec.coreFeatures.map((feature, index) =>
    createImplementationTask(feature, index + 1)
  );
  const reviewTasks = spec.coreFeatures.map((feature, index) =>
    createReviewTask(feature, index + 1)
  );
  const verificationTasks = spec.coreFeatures.map((feature, index) =>
    createVerificationTask(feature, index + 1, mandatoryGates)
  );

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    project: {
      name: spec.projectName,
      summary: spec.summary
    },
    architecture: {
      orchestrator: "OpenClaw",
      planner: "Cursor / Claude",
      executor: "Codex",
      reviewer: "Independent reviewer session or Cursor / Claude",
      verifier: "CI / automated test system"
    },
    phases: [
      {
        id: "planning",
        title: "Planning",
        owner: "planner",
        objectives: [
          "Turn the brief into executable work items",
          "Clarify risk stop rules",
          "Clarify the definition of done and acceptance rules"
        ]
      },
      {
        id: "implementation",
        title: "Implementation",
        owner: "executor",
        tasks: implementationTasks
      },
      {
        id: "review",
        title: "Review",
        owner: "reviewer",
        tasks: reviewTasks
      },
      {
        id: "verification",
        title: "Verification",
        owner: "verifier",
        tasks: verificationTasks,
        mandatoryGates
      },
      {
        id: "delivery",
        title: "Delivery",
        owner: "orchestrator",
        deliverables: spec.deliverables
      }
    ],
    stopConditions: spec.riskStopRules,
    definitionOfDone: spec.definitionOfDone,
    acceptanceCriteria: spec.acceptanceCriteria,
    priorities: spec.priorities ?? [],
    backlog: spec.backlogFeatures ?? []
  };
}

export function renderPlanMarkdown(plan) {
  const lines = [
    `# ${plan.project.name} Execution Plan`,
    "",
    `- Generated at: ${plan.generatedAt}`,
    `- Summary: ${plan.project.summary}`,
    "",
    "## Role Assignment",
    `- Orchestrator: ${plan.architecture.orchestrator}`,
    `- Planner: ${plan.architecture.planner}`,
    `- Executor: ${plan.architecture.executor}`,
    `- Reviewer: ${plan.architecture.reviewer}`,
    `- Verifier: ${plan.architecture.verifier}`,
    "",
    "## Phases",
    ...plan.phases.flatMap((phase) => {
      const phaseLines = [`### ${phase.title}`, `- Owner: ${phase.owner}`];

      if (Array.isArray(phase.objectives)) {
        phase.objectives.forEach((objective) => phaseLines.push(`- ${objective}`));
      }

      if (Array.isArray(phase.tasks)) {
        phase.tasks.forEach((task) => {
          phaseLines.push(`- ${task.title}`);
        });
      }

      if (Array.isArray(phase.mandatoryGates)) {
        phase.mandatoryGates.forEach((gate) => phaseLines.push(`- Mandatory gate: ${gate}`));
      }

      if (Array.isArray(phase.deliverables)) {
        phase.deliverables.forEach((deliverable) =>
          phaseLines.push(`- Deliverable: ${deliverable}`)
        );
      }

      phaseLines.push("");
      return phaseLines;
    }),
    "## Risk Stop Rules",
    ...plan.stopConditions.map((rule) => `- ${rule}`),
    "",
    "## Definition of Done",
    ...plan.definitionOfDone.map((item) => `- ${item}`),
    "",
    "## Acceptance Criteria",
    ...plan.acceptanceCriteria.map((item) => `- ${item}`)
  ];

  return lines.join("\n");
}
