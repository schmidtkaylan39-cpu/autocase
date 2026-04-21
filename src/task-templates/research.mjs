import { createTaskTemplate } from "./shared.mjs";

export const researchTemplate = createTaskTemplate({
  id: "research",
  label: "Research",
  description: "Produce an evidence-backed research package with explicit assumptions, sources, and synthesis.",
  supportedModes: ["generic", "repo"],
  modes: {
    generic: {
      requiredInputs: [
        "research question",
        "scope boundaries",
        "required depth",
        "source expectations",
        "delivery format"
      ],
      deliverables: [
        "question framing",
        "source list",
        "findings summary",
        "synthesis",
        "risks and unknowns"
      ],
      acceptanceCriteria: [
        "Findings separate sourced facts from inference.",
        "The summary addresses the original question directly.",
        "Risks, unknowns, and follow-up gaps are explicit."
      ],
      roleGuidance: {
        planner: [
          "Define scope and evidence standards before gathering results.",
          "Make the output shape clear enough for downstream execution."
        ],
        executor: [
          "Organize sources and synthesis rather than dumping notes.",
          "Mark uncertain claims instead of smoothing over gaps."
        ],
        reviewer: [
          "Check for unsupported conclusions and hidden leaps.",
          "Reject work that blurs sourced content with speculation."
        ],
        verifier: [
          "Confirm sources, summaries, and risks are present in the package.",
          "Fail if required evidence is absent."
        ]
      }
    },
    repo: {
      requiredInputs: [
        "repo surface under review",
        "target files or modules",
        "question or incident being researched",
        "available diagnostics",
        "expected handoff format"
      ],
      deliverables: [
        "codebase findings",
        "source file references",
        "root cause or hypothesis summary",
        "next-step recommendations"
      ],
      acceptanceCriteria: [
        "The research package cites concrete repo surfaces.",
        "Findings distinguish observed evidence from likely inference.",
        "Recommendations are actionable for the next agent round."
      ],
      roleGuidance: {
        planner: [
          "List the exact repo surfaces that need inspection.",
          "Avoid vague 'look around' directions."
        ],
        executor: [
          "Capture concise findings with file references and evidence.",
          "Preserve uncertainty where the code does not prove a claim."
        ],
        reviewer: [
          "Fail closed if recommendations overstate what the evidence shows.",
          "Require concrete source references for important conclusions."
        ],
        verifier: [
          "Check that cited files, logs, or artifacts are actually represented.",
          "Report missing repo evidence explicitly."
        ]
      }
    }
  }
});

