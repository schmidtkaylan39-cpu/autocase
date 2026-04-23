import { createTaskTemplate } from "./shared.mjs";

export const autofixTemplate = createTaskTemplate({
  id: "autofix",
  label: "CI Autofix",
  description: "Triage failing automation, patch the smallest safe fix, and prove the relevant gates changed state.",
  supportedModes: ["generic", "repo"],
  modes: {
    generic: {
      requiredInputs: [
        "failure description",
        "reproduction steps",
        "constraints",
        "allowed retries",
        "success signal"
      ],
      deliverables: [
        "failure triage",
        "fix plan",
        "patch summary",
        "verification results",
        "residual risk notes"
      ],
      acceptanceCriteria: [
        "The response identifies the likely root cause before proposing the fix.",
        "Verification is tied to the failing signal instead of a generic pass claim.",
        "Residual risks and retry limits are explicit."
      ],
      roleGuidance: {
        planner: [
          "Separate diagnosis, patch, and verification steps.",
          "Prefer the smallest reversible fix that addresses the observed failure."
        ],
        executor: [
          "Focus on the failing surface and avoid unrelated cleanup.",
          "Record what changed and why it should affect the failure."
        ],
        reviewer: [
          "Reject speculative fixes without evidence that they touch the failure mode.",
          "Check for silent risk transfer to adjacent flows."
        ],
        verifier: [
          "Run the closest failing gate or an equivalent reproducible check.",
          "Fail when the original failure signal was not re-tested."
        ]
      }
    },
    repo: {
      requiredInputs: [
        "failing command or workflow",
        "log excerpt",
        "target files",
        "allowed write scope",
        "required verification commands"
      ],
      deliverables: [
        "repo patch",
        "failure analysis",
        "verification evidence",
        "follow-up notes"
      ],
      acceptanceCriteria: [
        "The patch stays inside the requested repo scope.",
        "The updated verification evidence covers the original failure mode.",
        "Reviewer can map the fix to concrete logs, files, or tests."
      ],
      roleGuidance: {
        planner: [
          "Anchor the plan to the failing command, logs, and target paths.",
          "Keep retry and rollback thinking explicit."
        ],
        executor: [
          "Apply the smallest repo-local fix that addresses the logged failure.",
          "Capture before/after evidence for the relevant gate."
        ],
        reviewer: [
          "Fail closed if the fix dodges the actual failing check or lacks evidence.",
          "Reject broad refactors hidden inside an autofix round."
        ],
        verifier: [
          "Run the failing repo command or a documented equivalent.",
          "Report exact pass/fail status and residual risk if coverage is partial."
        ]
      }
    }
  }
});

