export const runtimeDefinitions = {
  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    mode: "automated",
    roles: ["orchestrator"]
  },
  "gpt-runner": {
    id: "gpt-runner",
    label: "GPT Runner",
    mode: "automated",
    roles: ["planner", "reviewer", "orchestrator"]
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
  orchestrator: ["gpt-runner", "manual"],
  planner: ["gpt-runner", "manual"],
  reviewer: ["gpt-runner", "manual"],
  executor: ["codex", "manual"],
  verifier: ["local-ci", "manual"]
};

const defaultTimeoutMsByRuntime = {
  openclaw: 300000,
  "gpt-runner": 300000,
  cursor: 300000,
  codex: 300000,
  "local-ci": 900000,
  manual: 0
};

const defaultRetryBudgetByRole = {
  planner: 2,
  reviewer: 2,
  executor: 3,
  verifier: 2,
  orchestrator: 2
};

const defaultMaxOutputTokensByRole = {
  planner: 6000,
  reviewer: 6000,
  executor: 8000,
  orchestrator: 6000
};

function normalizePositiveInteger(value, fallbackValue) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : fallbackValue;
}

function supportsDeterministicLauncherControls(runtimeId) {
  return ["openclaw", "gpt-runner", "cursor", "codex"].includes(runtimeId);
}

function resolveRetryBudget(task, runState) {
  const role = task?.role;
  const retryPolicy = runState?.retryPolicy ?? {};

  if (role === "executor") {
    return normalizePositiveInteger(
      task?.retriesBeforeReplan,
      normalizePositiveInteger(retryPolicy.implementation, defaultRetryBudgetByRole.executor)
    );
  }

  if (role === "reviewer") {
    return normalizePositiveInteger(retryPolicy.review, defaultRetryBudgetByRole.reviewer);
  }

  if (role === "verifier") {
    return normalizePositiveInteger(retryPolicy.verification, defaultRetryBudgetByRole.verifier);
  }

  if (role === "planner" || role === "orchestrator") {
    return normalizePositiveInteger(retryPolicy.replanning, defaultRetryBudgetByRole[role]);
  }

  return normalizePositiveInteger(defaultRetryBudgetByRole[role], 1);
}

/**
 * @param {{
 *   runtimeId?: string | null,
 *   task?: { role?: string | null, retriesBeforeReplan?: number | null } | null,
 *   runState?: {
 *     retryPolicy?: {
 *       implementation?: number | null,
 *       review?: number | null,
 *       verification?: number | null,
 *       replanning?: number | null
 *     } | null,
 *     escalation?: { maxConsecutiveFailures?: number | null } | null
 *   } | null,
 *   modelSelection?: { preferredModel?: string | null } | null
 * }} [options]
 */
export function getRuntimeExecutionProfile({
  runtimeId,
  task,
  runState,
  modelSelection = null
} = {}) {
  const role = task?.role ?? null;
  const retryBudget = resolveRetryBudget(task, runState);
  const configuredFailureLimit = normalizePositiveInteger(
    runState?.escalation?.maxConsecutiveFailures,
    retryBudget
  );
  const deterministicControls = supportsDeterministicLauncherControls(runtimeId)
    ? {
        fixedModel: modelSelection?.preferredModel ?? null,
        temperature: 0,
        maxOutputTokens: normalizePositiveInteger(
          defaultMaxOutputTokensByRole[role],
          6000
        )
      }
    : {};

  return {
    runtimeId,
    launcherMetadata: deterministicControls,
    execution: {
      timeoutMs: normalizePositiveInteger(
        defaultTimeoutMsByRuntime[runtimeId],
        300000
      ),
      retryBudget,
      circuitBreakerLimit: Math.max(1, Math.min(retryBudget, configuredFailureLimit))
    }
  };
}

function getAllowedRoleRuntimeIds(role) {
  return Object.entries(runtimeDefinitions)
    .filter(([, runtime]) => runtime.roles.includes(role))
    .map(([runtimeId]) => runtimeId);
}

export function resolveRuntimePreferences(role, runtimeRouting = null) {
  const defaultPreferences = rolePreferences[role] ?? ["manual"];
  const configuredPreferences = runtimeRouting?.roleOverrides?.[role];

  if (!Array.isArray(configuredPreferences) || configuredPreferences.length === 0) {
    return {
      preferences: [...defaultPreferences],
      source: "default"
    };
  }

  const allowedRuntimeIds = new Set(getAllowedRoleRuntimeIds(role));
  const sanitizedPreferences = configuredPreferences.filter(
    (runtimeId) => typeof runtimeId === "string" && allowedRuntimeIds.has(runtimeId)
  );

  if (sanitizedPreferences.length === 0) {
    return {
      preferences: [...defaultPreferences],
      source: "default"
    };
  }

  if (!sanitizedPreferences.includes("manual")) {
    sanitizedPreferences.push("manual");
  }

  return {
    preferences: sanitizedPreferences,
    source: "override"
  };
}

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

export function pickRuntimeForRole(role, runtimeChecks, runtimeRouting = null) {
  const { preferences, source } = resolveRuntimePreferences(role, runtimeRouting);

  for (const [index, runtimeId] of preferences.entries()) {
    const status = runtimeChecks[runtimeId];

    if (runtimeId === "manual") {
      return {
        runtimeId,
        status: index === 0 ? "ready" : "fallback",
        reason:
          index === 0
            ? source === "override"
              ? "This role is explicitly routed to a manual surface by runtimeRouting.roleOverrides."
              : "This role is intentionally handled through a manual surface by default."
            : source === "override"
              ? "No override-selected runtime was ready, so this task falls back to manual handling."
              : "No ready automated runtime was available, so this task falls back to manual handling."
      };
    }

    if (status?.ok) {
      return {
        runtimeId,
        status: "ready",
        reason:
          source === "override"
            ? `${runtimeDefinitions[runtimeId].label} was explicitly enabled for this role via runtimeRouting.roleOverrides.`
            : `${runtimeDefinitions[runtimeId].label} is ready for this role.`
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
