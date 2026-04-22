import {
  AGENT_ROLES,
  createExecutorOutput,
  createPlannerOutput,
  createReviewerOutput,
  createVerifierOutput
} from "./contracts.mjs";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeSupportedRoles(roles) {
  const roleList = Array.isArray(roles) && roles.length > 0 ? roles : AGENT_ROLES;
  roleList.forEach((role) => {
    invariant(AGENT_ROLES.includes(role), `Unsupported adapter role: ${role}`);
  });
  return [...new Set(roleList)];
}

function createStubOutput(role, request = {}) {
  const taskTitle = request?.task?.title ?? "task";

  switch (role) {
    case "planner":
      return createPlannerOutput({
        status: "ready",
        summary: `Stub planner prepared a contract for ${taskTitle}.`,
        workPlan: [
          {
            id: "stub-plan",
            title: "Replace stub planner",
            description: "Wire this adapter to a real planner runtime before production use.",
            dependsOn: []
          }
        ],
        acceptanceChecks: ["Structured planner output is available."],
        nextActions: ["Swap the stub adapter for a real client."]
      });
    case "executor":
      return createExecutorOutput({
        status: "retry",
        summary: `Stub executor cannot safely modify ${taskTitle} yet.`,
        patchSummary: ["No code was changed because this adapter is a stub."],
        notes: ["Replace the stub executor adapter with a real client before enabling automation."]
      });
    case "reviewer":
      return createReviewerOutput({
        verdict: "comment_only",
        summary: `Stub reviewer cannot approve ${taskTitle}.`,
        findings: [
          {
            id: "stub-review",
            severity: "medium",
            title: "Stub reviewer in use",
            description: "Approval is blocked until a real reviewer runtime is configured.",
            suggestedAction: "Attach a real reviewer adapter."
          }
        ],
        notes: ["Stub reviewer always fail-closes the pipeline."]
      });
    case "verifier":
      return createVerifierOutput({
        status: "blocked",
        summary: `Stub verifier did not run checks for ${taskTitle}.`,
        checks: [
          {
            id: "stub-check",
            name: "stub-check",
            status: "blocked",
            evidence: "No verifier runtime configured.",
            required: true
          }
        ],
        failure: {
          category: "missing_dependency",
          message: "Verifier adapter is still a stub.",
          evidence: "No underlying client was invoked."
        }
      });
    default:
      throw new Error(`Unsupported adapter role: ${role}`);
  }
}

export function createRuntimeAdapter({
  id,
  label = id,
  supportedRoles = AGENT_ROLES,
  invoke
}) {
  invariant(typeof id === "string" && id.trim().length > 0, "Adapter id must be a non-empty string.");
  invariant(typeof label === "string" && label.trim().length > 0, "Adapter label must be a non-empty string.");
  invariant(typeof invoke === "function", "Adapter invoke must be a function.");

  const normalizedRoles = normalizeSupportedRoles(supportedRoles);

  return Object.freeze({
    id: id.trim(),
    label: label.trim(),
    supportedRoles: normalizedRoles,
    async run(request) {
      const role = request?.role;
      invariant(normalizedRoles.includes(role), `Adapter ${id} does not support role ${role}.`);
      return invoke(request);
    }
  });
}

export function createStubRuntimeAdapter({
  id = "stub-runtime",
  label = "Stub Runtime Adapter",
  supportedRoles = AGENT_ROLES
} = {}) {
  return createRuntimeAdapter({
    id,
    label,
    supportedRoles,
    async invoke(request) {
      const output = createStubOutput(request.role, request);
      return {
        adapterId: id,
        role: request.role,
        stub: true,
        rawOutput: JSON.stringify(output, null, 2),
        parsedOutput: output,
        warnings: [
          "Stub runtime adapter returned synthetic output.",
          "Replace this adapter with a real OpenClaw or Codex client before production use."
        ]
      };
    }
  });
}

