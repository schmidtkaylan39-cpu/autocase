export const sampleProjectSpec = {
  projectName: "AI Factory Demo",
  summary: "Create a starter workflow for a long-running multi-agent software factory.",
  projectGoal: {
    oneLine:
      "Allow the system to plan, implement, review, and verify a software project with minimal supervision.",
    details:
      "This starter project turns project intake, risk-stop rules, execution planning, and acceptance rules into reusable artifacts so OpenClaw can orchestrate, GPT-5.4 can plan and review, Codex can implement, and human operators can step in when needed."
  },
  targetUsers: [
    "Non-programmers who want a structured AI software workflow",
    "Operators who want long unattended development runs"
  ],
  coreFeatures: [
    {
      id: "spec-intake",
      title: "Structured spec intake",
      description: "Convert a project brief into a validated machine-readable JSON spec.",
      acceptanceCriteria: [
        "Required project fields are present",
        "Risk stop rules are captured",
        "Definition of done is clearly listed"
      ]
    },
    {
      id: "workflow-plan",
      title: "Execution plan generator",
      description:
        "Generate planner, executor, reviewer, and verifier tasks from the project spec.",
      acceptanceCriteria: [
        "Each core feature becomes an implementation task",
        "Review and verification steps are generated automatically"
      ]
    }
  ],
  backlogFeatures: [
    "Wire real OpenClaw task submission",
    "Wire Codex and GPT-5.4 execution backends",
    "Wire CI and Playwright verification"
  ],
  nonGoals: [
    "Do not touch production systems in the first version",
    "Do not automate payments or irreversible data changes in the first version"
  ],
  design: {
    tone: "Clear, practical, and beginner-friendly",
    references: ["https://docs.openclaw.ai", "https://openai.com/codex"],
    mobileRequired: false,
    desktopRequired: true
  },
  technicalConstraints: {
    preferredStack: ["Node.js", "JSON-based workflow definitions", "Markdown artifacts"],
    forbiddenTools: [
      "Unapproved direct production changes",
      "Claiming completion without verification"
    ],
    deploymentTarget: "Local machine or VPS command-line workflow"
  },
  integrations: [
    {
      name: "OpenClaw",
      status: "planned",
      notes: "Primary orchestrator"
    },
    {
      name: "Codex",
      status: "planned",
      notes: "Primary executor"
    },
    {
      name: "GPT-5.4 / GPT-5.4 Pro",
      status: "optional",
      notes: "Planning and review surface with human-in-the-loop operation"
    }
  ],
  dataSources: ["Project requirement document", "Acceptance checklist", "Risk-stop rules"],
  definitionOfDone: [
    "The spec validates successfully",
    "The execution plan is generated",
    "The outputs are ready to connect to OpenClaw, Codex, and CI"
  ],
  acceptanceCriteria: [
    "The CLI supports init, validate, and plan commands",
    "The plan command writes JSON and Markdown outputs",
    "Validation errors are returned when the spec is incomplete"
  ],
  riskStopRules: [
    "Pause if the workflow needs to delete production data",
    "Pause if an irreversible migration is required",
    "Pause if a new paid external service must be added"
  ],
  priorities: [
    "Clarity before polish",
    "Verification before full automation"
  ],
  deliverables: [
    "Runnable CLI starter",
    "Example project spec",
    "Execution plan artifacts",
    "Templates and docs"
  ]
};
