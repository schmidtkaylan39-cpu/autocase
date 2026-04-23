import { createTaskTemplate } from "./shared.mjs";

export const websiteTemplate = createTaskTemplate({
  id: "website",
  label: "Website",
  description: "Deliver a website implementation or delivery plan without assuming a single frontend framework or UI shell.",
  supportedModes: ["generic", "repo"],
  modes: {
    generic: {
      requiredInputs: [
        "site purpose",
        "target audience",
        "content sections",
        "brand or visual direction",
        "responsive expectations"
      ],
      deliverables: [
        "information architecture",
        "page or route plan",
        "interaction notes",
        "content requirements",
        "QA checklist"
      ],
      acceptanceCriteria: [
        "The website plan covers core flows and responsive behavior.",
        "The deliverable is not tied to one UI framework unless requested.",
        "Success criteria are concrete enough for implementation and review."
      ],
      roleGuidance: {
        planner: [
          "Separate content, layout, and validation concerns.",
          "Highlight any accessibility or performance requirements."
        ],
        executor: [
          "Implement the requested flow rather than a vague landing page mockup.",
          "Document meaningful responsive and interaction choices."
        ],
        reviewer: [
          "Check user flow coverage, readability, and likely regressions.",
          "Reject shallow placeholder sections or broken core navigation."
        ],
        verifier: [
          "Use available build, lint, typecheck, and smoke evidence.",
          "Call out missing accessibility or responsive evidence when applicable."
        ]
      }
    },
    repo: {
      requiredInputs: [
        "target routes or pages",
        "component or styling boundaries",
        "test entry points",
        "build commands",
        "acceptance environment"
      ],
      deliverables: [
        "repo code changes",
        "route or page updates",
        "test evidence",
        "release notes"
      ],
      acceptanceCriteria: [
        "The requested repo surfaces are updated without unrelated refactors.",
        "Core page flow is verifiable through repo-level checks or smoke evidence.",
        "Reviewer findings can reference concrete changed files."
      ],
      roleGuidance: {
        planner: [
          "Map the request to route, component, asset, and validation scope.",
          "Keep framework assumptions explicit instead of implied."
        ],
        executor: [
          "Stay within the requested repo paths and preserve design-system patterns when they exist.",
          "Record the exact checks or smoke evidence that support the change."
        ],
        reviewer: [
          "Fail closed on broken routes, missing states, or unclear validation.",
          "Do not approve if critical UX states lack evidence."
        ],
        verifier: [
          "Run the closest available repo checks and smoke paths.",
          "Return fail when required UI evidence is missing."
        ]
      }
    }
  }
});

