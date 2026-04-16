export const runtimeDefinitions = {
  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    mode: "automated",
    roles: ["orchestrator"]
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    mode: "hybrid",
    roles: ["planner", "reviewer"]
  },
  codex: {
    id: "codex",
    label: "Codex",
    mode: "automated",
    roles: ["executor"]
  },
  "local-ci": {
    id: "local-ci",
    label: "Local CI",
    mode: "automated",
    roles: ["verifier"]
  },
  manual: {
    id: "manual",
    label: "Manual",
    mode: "manual",
    roles: ["planner", "reviewer", "executor", "verifier", "orchestrator"]
  }
};

const rolePreferences = {
  orchestrator: ["openclaw", "manual"],
  planner: ["manual"],
  reviewer: ["manual"],
  executor: ["codex", "manual"],
  verifier: ["local-ci", "manual"]
};

export function normalizeRuntimeChecks(report) {
  const checks = report?.checks ?? [];
  const normalized = {};

  for (const runtimeId of Object.keys(runtimeDefinitions)) {
    if (runtimeId === "manual") {
      normalized[runtimeId] = {
        installed: true,
        ok: true
      };
      continue;
    }

    const match = checks.find((check) => check.id === runtimeId);
    normalized[runtimeId] = match
      ? {
          installed: Boolean(match.installed),
          ok: Boolean(match.ok),
          source: match.source ?? null,
          error: match.error ?? null
        }
      : {
          installed: false,
          ok: false,
          source: null,
          error: "No doctor result found."
        };
  }

  return normalized;
}

export function pickRuntimeForRole(role, runtimeChecks) {
  const preferences = rolePreferences[role] ?? ["manual"];

  for (const [index, runtimeId] of preferences.entries()) {
    const status = runtimeChecks[runtimeId];

    if (runtimeId === "manual") {
      return {
        runtimeId,
        status: index === 0 ? "ready" : "fallback",
        reason:
          index === 0
            ? "This role is intentionally handled through a manual surface by default."
            : "No ready automated runtime was available, so this task falls back to manual handling."
      };
    }

    if (status?.ok) {
      return {
        runtimeId,
        status: "ready",
        reason: `${runtimeDefinitions[runtimeId].label} is ready for this role.`
      };
    }
  }

  return {
    runtimeId: "manual",
    status: "fallback",
    reason: "No runtime is currently ready for this role."
  };
}

export function describeRuntime(runtimeId) {
  return runtimeDefinitions[runtimeId] ?? runtimeDefinitions.manual;
}
