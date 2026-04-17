import { randomUUID } from "node:crypto";

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function toSentenceCase(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return normalized;
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function createQuestion(category, question, blocking = true) {
  return {
    id: `${category}-${randomUUID().slice(0, 8)}`,
    category,
    question,
    blocking
  };
}

function createTitleFromRequest(request) {
  const normalized = normalizeWhitespace(request).replace(/[。！？!?]+$/g, "");
  if (!normalized) {
    return "Clarification Intake";
  }

  if (normalized.length <= 80) {
    return toSentenceCase(normalized);
  }

  return `${toSentenceCase(normalized.slice(0, 77))}...`;
}

function includesAny(normalizedRequest, patterns) {
  return patterns.some((pattern) => pattern.test(normalizedRequest));
}

function detectNamedSystems(normalizedRequest) {
  const detections = [];
  const definitions = [
    {
      system: "Email platform",
      accessLevel: "send email permission",
      reason: "The request references sending or managing email.",
      type: "external_service",
      pattern: /\b(email|gmail|outlook|mailbox|inbox)\b/i
    },
    {
      system: "CRM",
      accessLevel: "read/write CRM access",
      reason: "The request references CRM data or customer records.",
      type: "external_service",
      pattern: /\b(crm|salesforce|hubspot)\b/i
    },
    {
      system: "Slack",
      accessLevel: "workspace posting permission",
      reason: "The request references Slack messaging or notifications.",
      type: "external_service",
      pattern: /\bslack\b/i
    },
    {
      system: "GitHub",
      accessLevel: "repository access",
      reason: "The request references repository changes or PR actions.",
      type: "external_service",
      pattern: /\bgithub|pull request|pr\b/i
    },
    {
      system: "Jira",
      accessLevel: "project read/write access",
      reason: "The request references Jira issues or workflow state.",
      type: "external_service",
      pattern: /\bjira\b/i
    },
    {
      system: "Spreadsheet system",
      accessLevel: "sheet read/write access",
      reason: "The request references spreadsheet-based input or output.",
      type: "data_source",
      pattern: /\bspreadsheet|google sheet|google sheets|excel|csv\b/i
    },
    {
      system: "Database",
      accessLevel: "database read/write access",
      reason: "The request references database-backed data.",
      type: "data_source",
      pattern: /\bdatabase|sql|postgres|mysql\b/i
    },
    {
      system: "API / webhook target",
      accessLevel: "API token or webhook secret",
      reason: "The request references API or webhook integration.",
      type: "external_service",
      pattern: /\bapi|webhook|oauth|token\b/i
    },
    {
      system: "Internal tool",
      accessLevel: "internal account or role-based permission",
      reason: "The request references an internal tool or admin surface.",
      type: "internal_system",
      pattern: /\binternal tool|internal system|admin portal|backoffice|後台|內部工具|內部系統\b/i,
      needsClarification: true
    }
  ];

  for (const definition of definitions) {
    if (definition.pattern.test(normalizedRequest)) {
      detections.push(definition);
    }
  }

  return detections;
}

function detectHighRiskSignals(normalizedRequest) {
  const signals = [];
  const definitions = [
    {
      pattern: /\bsend|email|notify|message|post|publish|release|deploy\b/i,
      risk: "The request can trigger outbound communication or a public-facing action.",
      humanStep: "Approve the final outbound or public-facing action before execution."
    },
    {
      pattern: /\bdelete|remove|drop|purge|destroy\b/i,
      risk: "The request may include irreversible or destructive changes.",
      humanStep: "Review and approve destructive changes before execution."
    },
    {
      pattern: /\bpay|payment|invoice|billing|refund\b/i,
      risk: "The request touches financial actions that should remain human-approved.",
      humanStep: "Approve financial or billing actions manually."
    },
    {
      pattern: /\blegal|contract|compliance|hr|payroll|salary\b/i,
      risk: "The request touches compliance-sensitive or people-sensitive operations.",
      humanStep: "Keep legal, compliance, or HR-sensitive decisions in a human review step."
    }
  ];

  for (const definition of definitions) {
    if (definition.pattern.test(normalizedRequest)) {
      signals.push(definition);
    }
  }

  return signals;
}

function detectConstraints(normalizedRequest) {
  const constraints = [];

  if (includesAny(normalizedRequest, [/\btoday|asap|urgent|immediately\b/i, /今天|立刻|馬上/])) {
    constraints.push("The request has time pressure and may need a shortened delivery loop.");
  }

  if (includesAny(normalizedRequest, [/\bcheap|low cost|budget\b/i, /預算|低成本/])) {
    constraints.push("The solution should respect an explicit cost or budget constraint.");
  }

  if (includesAny(normalizedRequest, [/\baccurate|accuracy|precise\b/i, /準確|精準/])) {
    constraints.push("The output quality expectation emphasizes correctness or precision.");
  }

  if (includesAny(normalizedRequest, [/\bprivacy|confidential|sensitive\b/i, /隱私|敏感|機密/])) {
    constraints.push("Sensitive information handling may limit how much can be safely automated.");
  }

  return constraints;
}

function detectGoalAmbiguity(normalizedRequest) {
  const shortOrGeneric = normalizedRequest.length < 24;
  const genericAutomation =
    includesAny(normalizedRequest, [/\bautomate\b/i, /自動化/]) &&
    !includesAny(normalizedRequest, [/\bcsv|json|markdown|email|report|dashboard|api|file|sheet\b/i, /報表|檔案|表單|郵件|摘要|清單/]);
  const vagueObject = includesAny(normalizedRequest, [
    /\bthing|stuff|process|workflow|report\b/i,
    /事情|流程|報表/
  ]);

  return shortOrGeneric || genericAutomation || vagueObject;
}

function detectExplicitOutput(normalizedRequest) {
  const matches = [];

  if (includesAny(normalizedRequest, [/\bcsv\b/i, /\bexcel\b/i, /試算表|表格/])) {
    matches.push("Produce the requested tabular output in the target spreadsheet or CSV format.");
  }

  if (includesAny(normalizedRequest, [/\bjson\b/i])) {
    matches.push("Produce the requested JSON output in a repeatable way.");
  }

  if (includesAny(normalizedRequest, [/\bmarkdown\b/i, /摘要|summary|report|dashboard/])) {
    matches.push("Produce the requested summary or report artifact in the expected format.");
  }

  if (includesAny(normalizedRequest, [/\bemail\b/i, /郵件/])) {
    matches.push("Prepare the email workflow with a human review step before any outbound send.");
  }

  return matches;
}

function detectInputHints(normalizedRequest) {
  const inputs = [];

  if (includesAny(normalizedRequest, [/\bjson\b/i])) {
    inputs.push({
      name: "JSON input data",
      description: "A concrete JSON input file or schema is needed.",
      status: "required"
    });
  }

  if (includesAny(normalizedRequest, [/\bcsv\b/i, /\bexcel\b/i, /試算表|表格/])) {
    inputs.push({
      name: "Tabular source data",
      description: "A spreadsheet, CSV file, or equivalent source dataset is needed.",
      status: "required"
    });
  }

  if (includesAny(normalizedRequest, [/\breport\b/i, /報表/])) {
    inputs.push({
      name: "Report definition",
      description: "The source report fields, filters, and destination format need to be defined.",
      status: "needs_clarification"
    });
  }

  return inputs;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const results = [];

  for (const item of items) {
    const key = keyFn(item);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(item);
  }

  return results;
}

function deriveAutomationAssessment({
  goalAmbiguous,
  blockingQuestions,
  requiredAccess,
  humanStepsRequired,
  approvalRequired,
  highRiskSignals
}) {
  let estimatedAutomatablePercent = 100;
  const rationale = [];

  if (requiredAccess.length > 0) {
    estimatedAutomatablePercent = Math.min(estimatedAutomatablePercent, 75);
    rationale.push("External systems or permission-gated surfaces are involved.");
  }

  if (humanStepsRequired.length > 0) {
    estimatedAutomatablePercent = Math.min(estimatedAutomatablePercent, 95);
    rationale.push("A human-in-the-loop step is still required for approval or sensitive actions.");
  }

  if (approvalRequired) {
    estimatedAutomatablePercent = Math.min(estimatedAutomatablePercent, 90);
  }

  if (highRiskSignals.length > 0) {
    estimatedAutomatablePercent = Math.min(estimatedAutomatablePercent, 70);
    rationale.push("The request includes higher-risk actions that should not be fully automated.");
  }

  if (goalAmbiguous) {
    estimatedAutomatablePercent = Math.min(estimatedAutomatablePercent, 35);
    rationale.push("The final outcome is still underspecified.");
  }

  if (blockingQuestions.length > 0) {
    estimatedAutomatablePercent = Math.min(estimatedAutomatablePercent, 25);
    rationale.push("Blocking clarification questions remain unresolved.");
  }

  let automationLevel = "full";

  if (estimatedAutomatablePercent < 25) {
    automationLevel = "limited";
  } else if (estimatedAutomatablePercent < 70) {
    automationLevel = "partial";
  } else if (estimatedAutomatablePercent < 100) {
    automationLevel = "mostly-automated";
  }

  return {
    canFullyAutomate:
      estimatedAutomatablePercent === 100 && humanStepsRequired.length === 0 && blockingQuestions.length === 0,
    automationLevel,
    estimatedAutomatablePercent,
    humanStepsRequired,
    blockers: blockingQuestions.map((question) => question.question),
    rationale
  };
}

export function clarifyIntakeRequest(originalRequest, { requestId = randomUUID(), now = new Date() } = {}) {
  const normalizedRequest = normalizeWhitespace(originalRequest);

  if (!normalizedRequest) {
    throw new Error("Please provide a non-empty intake request.");
  }

  const lowerRequest = normalizedRequest.toLowerCase();
  const goalAmbiguous = detectGoalAmbiguity(lowerRequest);
  const namedSystems = detectNamedSystems(lowerRequest);
  const highRiskSignals = detectHighRiskSignals(lowerRequest);
  const constraints = detectConstraints(lowerRequest);
  const explicitOutputs = detectExplicitOutput(lowerRequest);
  const requiredInputs = detectInputHints(lowerRequest);
  const openQuestions = [];
  const risks = [];
  const humanStepsRequired = dedupeBy(
    highRiskSignals.map((signal) => signal.humanStep),
    (item) => item
  );
  const approvalRequired = humanStepsRequired.length > 0;

  const successCriteria = explicitOutputs.map((text) => ({
    text,
    status: "needs_confirmation"
  }));

  if (goalAmbiguous) {
    openQuestions.push(
      createQuestion("goal", "What concrete real-world outcome should change once this request is completed?")
    );
  }

  if (successCriteria.length === 0) {
    openQuestions.push(
      createQuestion("success", "What exact output, measurable result, or acceptance condition will count as success?")
    );
  }

  if (requiredInputs.length === 0) {
    openQuestions.push(
      createQuestion("inputs", "What exact source data, files, or upstream inputs will this workflow need?")
    );
  }

  const requiredAccountsAndPermissions = namedSystems.map((system) => ({
    system: system.system,
    accessLevel: system.accessLevel,
    reason: system.reason,
    status: system.needsClarification ? "needs_clarification" : "required"
  }));

  if (requiredAccountsAndPermissions.some((item) => item.status === "needs_clarification")) {
    openQuestions.push(
      createQuestion(
        "permissions",
        "Which concrete internal account, role, API key, or permission set will be used for the referenced internal systems?"
      )
    );
  }

  if (includesAny(lowerRequest, [/\bapi\b/i, /\bcredential\b/i, /\bpassword\b/i, /\blogin\b/i, /憑證|密碼|登入/])) {
    risks.push("Automation may be blocked until the required credentials or token handling approach is defined.");
  }

  for (const signal of highRiskSignals) {
    risks.push(signal.risk);
  }

  if (!includesAny(lowerRequest, [/\bdo not\b/i, /\bnot\b/i, /不要|排除|不包含/])) {
    openQuestions.push(
      createQuestion("scope", "What is explicitly out of scope for this round so later planning does not over-expand?")
    );
  }

  const inScope = dedupeBy(
    [
      `Clarify and prepare the requested outcome: ${toSentenceCase(normalizedRequest)}.`,
      ...explicitOutputs.map((item) => item.replace(/^Produce /, "Deliver ").replace(/^Prepare /, "Prepare "))
    ],
    (item) => item
  );
  const nonGoals = dedupeBy(
    [
      "Do not broaden the request into a larger platform rewrite or unrelated automation project.",
      "Do not assume unspecified credentials, approvals, or downstream integrations are already available."
    ],
    (item) => item
  );
  const outOfScope = dedupeBy(
    [
      "Unrequested system integrations or side effects.",
      "Irreversible, financial, legal, HR, or outbound actions without an explicit human checkpoint."
    ],
    (item) => item
  );
  const externalDependencies = namedSystems.map((system) => ({
    name: system.system,
    type: system.type,
    status: system.needsClarification ? "needs_clarification" : "required"
  }));
  const blockingQuestions = openQuestions.filter((question) => question.blocking);
  const automationAssessment = deriveAutomationAssessment({
    goalAmbiguous,
    blockingQuestions,
    requiredAccess: requiredAccountsAndPermissions,
    humanStepsRequired,
    approvalRequired,
    highRiskSignals
  });
  const clarificationStatus = blockingQuestions.length > 0 ? "clarifying" : "awaiting_confirmation";
  const clarifiedGoal =
    goalAmbiguous
      ? "The intended outcome is still too vague to safely enter planning. The request needs a sharper target result and acceptance definition."
      : `Deliver the requested outcome in a repeatable way: ${normalizedRequest}.`;

  return {
    requestId,
    title: createTitleFromRequest(normalizedRequest),
    originalRequest: normalizedRequest,
    clarifiedGoal,
    successCriteria,
    nonGoals,
    inScope,
    outOfScope,
    requiredInputs: dedupeBy(requiredInputs, (item) => item.name),
    requiredAccountsAndPermissions: dedupeBy(requiredAccountsAndPermissions, (item) => item.system),
    externalDependencies: dedupeBy(externalDependencies, (item) => item.name),
    constraints,
    risks: dedupeBy(risks, (item) => item),
    automationAssessment,
    openQuestions: dedupeBy(openQuestions, (item) => item.question),
    clarificationStatus,
    recommendedNextStep:
      clarificationStatus === "clarifying"
        ? "Resolve the blocking open questions, revise the intake if needed, and only then confirm it."
        : "Review the generated intake summary and run confirm if it matches the intended scope.",
    approvalRequired,
    confirmedByUser: false,
    lastUpdatedAt: now.toISOString()
  };
}
