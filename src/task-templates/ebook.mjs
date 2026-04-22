import { createTaskTemplate } from "./shared.mjs";

export const ebookTemplate = createTaskTemplate({
  id: "ebook",
  label: "Ebook",
  description: "Produce a structured long-form manuscript package with clear scope, chapter flow, and validation evidence.",
  supportedModes: ["generic", "repo"],
  modes: {
    generic: {
      requiredInputs: [
        "audience",
        "goal",
        "target length",
        "tone",
        "source materials or assumptions"
      ],
      deliverables: [
        "outline",
        "chapter plan",
        "draft manuscript",
        "fact and citation appendix",
        "delivery summary"
      ],
      acceptanceCriteria: [
        "The manuscript has a coherent outline and chapter sequence.",
        "Claims are sourced or explicitly marked as assumptions.",
        "The final package is readable without extra operator context."
      ],
      roleGuidance: {
        planner: [
          "Break the book into clear sections with review checkpoints.",
          "Call out any research gaps before drafting."
        ],
        executor: [
          "Produce chapter-ready content instead of bullet-only placeholders.",
          "Keep style and terminology consistent across sections."
        ],
        reviewer: [
          "Check for weak structure, unsupported claims, and repetitive filler.",
          "Do not approve when major sections are still outline-only."
        ],
        verifier: [
          "Confirm the required sections and source appendix exist.",
          "Mark the run failed if citations or factual notes are missing."
        ]
      }
    },
    repo: {
      requiredInputs: [
        "target manuscript paths",
        "build or export command",
        "style guide",
        "existing chapter files",
        "asset constraints"
      ],
      deliverables: [
        "updated manuscript files",
        "supporting assets",
        "export notes",
        "verification summary"
      ],
      acceptanceCriteria: [
        "All required manuscript files are updated in the target paths.",
        "Repo-specific export or preview steps are documented or validated.",
        "The reviewer can inspect a concrete manuscript delta."
      ],
      roleGuidance: {
        planner: [
          "Identify which files, chapters, and export steps are in scope.",
          "Preserve repository structure and authoring conventions."
        ],
        executor: [
          "Modify only the requested manuscript and support files.",
          "Record export or preview evidence when available."
        ],
        reviewer: [
          "Fail closed if the repo diff lacks substantive manuscript changes.",
          "Check that references, links, or appendix files stay aligned."
        ],
        verifier: [
          "Run or describe the closest manuscript build, export, or lint checks.",
          "Report missing repo gates explicitly."
        ]
      }
    }
  }
});

