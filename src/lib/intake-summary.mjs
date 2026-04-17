function renderStringList(items, fallback = "- none recorded") {
  if (!Array.isArray(items) || items.length === 0) {
    return [fallback];
  }

  return items.map((item) => `- ${item}`);
}

function renderStructuredList(items, renderItem, fallback = "- none recorded") {
  if (!Array.isArray(items) || items.length === 0) {
    return [fallback];
  }

  return items.map(renderItem);
}

function booleanLabel(value) {
  return value ? "yes" : "no";
}

export function renderIntakeSummary(spec) {
  return [
    `# Intake Summary: ${spec.title}`,
    "",
    `- Request ID: ${spec.requestId}`,
    `- Clarification status: ${spec.clarificationStatus}`,
    `- Confirmed by user: ${booleanLabel(spec.confirmedByUser)}`,
    `- Approval required: ${booleanLabel(spec.approvalRequired)}`,
    `- Recommended next step: ${spec.recommendedNextStep}`,
    `- Last updated at: ${spec.lastUpdatedAt}`,
    "",
    "## Original Request",
    spec.originalRequest,
    "",
    "## Clarified Goal",
    spec.clarifiedGoal,
    "",
    "## Success Criteria",
    ...renderStructuredList(
      spec.successCriteria,
      (item) => `- [${item.status}] ${item.text}`,
      "- no success criteria have been defined yet"
    ),
    "",
    "## In Scope",
    ...renderStringList(spec.inScope),
    "",
    "## Out Of Scope",
    ...renderStringList(spec.outOfScope),
    "",
    "## Non-Goals",
    ...renderStringList(spec.nonGoals),
    "",
    "## Required Inputs",
    ...renderStructuredList(
      spec.requiredInputs,
      (item) => `- [${item.status}] ${item.name}: ${item.description}`,
      "- no required inputs were identified"
    ),
    "",
    "## Required Accounts And Permissions",
    ...renderStructuredList(
      spec.requiredAccountsAndPermissions,
      (item) => `- [${item.status}] ${item.system} (${item.accessLevel}): ${item.reason}`,
      "- no account or permission requirements were identified"
    ),
    "",
    "## External Dependencies",
    ...renderStructuredList(
      spec.externalDependencies,
      (item) => `- [${item.status}] ${item.name} (${item.type})`,
      "- no external dependencies were identified"
    ),
    "",
    "## Constraints",
    ...renderStringList(spec.constraints),
    "",
    "## Risks",
    ...renderStringList(spec.risks),
    "",
    "## Automation Assessment",
    `- automation level: ${spec.automationAssessment.automationLevel}`,
    `- can fully automate: ${booleanLabel(spec.automationAssessment.canFullyAutomate)}`,
    `- estimated automatable percent: ${spec.automationAssessment.estimatedAutomatablePercent}%`,
    "",
    "### Human Steps Required",
    ...renderStringList(spec.automationAssessment.humanStepsRequired),
    "",
    "### Automation Blockers",
    ...renderStringList(spec.automationAssessment.blockers),
    "",
    "### Automation Rationale",
    ...renderStringList(spec.automationAssessment.rationale),
    "",
    "## Open Questions",
    ...renderStructuredList(
      spec.openQuestions,
      (item) => `- [${item.blocking ? "blocking" : "non-blocking"}] (${item.category}) ${item.question}`,
      "- no open questions remain"
    )
  ].join("\n");
}
