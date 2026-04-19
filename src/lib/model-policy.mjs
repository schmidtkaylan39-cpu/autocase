export const defaultModelPolicy = {
  orchestrator: {
    defaultModel: "gpt-5.4",
    deterministicSettings: {
      temperature: 0,
      maxTokens: 12000,
      topP: 1
    },
    autoSwitch: false
  },
  planner: {
    defaultModel: "gpt-5.4",
    escalatedModel: "gpt-5.4-pro",
    deterministicSettings: {
      temperature: 0,
      maxTokens: 12000,
      topP: 1
    },
    escalatedDeterministicSettings: {
      temperature: 0,
      maxTokens: 12000,
      topP: 1
    },
    autoSwitch: true
  },
  reviewer: {
    defaultModel: "gpt-5.4",
    escalatedModel: "gpt-5.4-pro",
    deterministicSettings: {
      temperature: 0,
      maxTokens: 12000,
      topP: 1
    },
    escalatedDeterministicSettings: {
      temperature: 0,
      maxTokens: 12000,
      topP: 1
    },
    autoSwitch: true
  },
  executor: {
    defaultModel: "codex",
    deterministicSettings: {
      temperature: 0,
      maxTokens: 12000,
      topP: 1
    },
    autoSwitch: false
  },
  verifier: {
    defaultModel: "local-ci",
    deterministicSettings: {},
    autoSwitch: false
  },
  escalation: {
    minimumRetryCount: 2,
    minimumAttempts: 2,
    escalateOnAttentionRequired: true,
    escalateOnBlockedHistory: true,
    escalateOnDispatchFailure: true,
    forceProTaskIds: [],
    forceProTaskPatterns: [
      "dispatch",
      "handoff",
      "retry",
      "artifact",
      "run-state",
      "risk",
      "security",
      "release"
    ]
  }
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePatternList(values) {
  return Array.isArray(values)
    ? values
        .map((value) => String(value).trim().toLowerCase())
        .filter((value) => value.length > 0)
    : [];
}

function taskText(task) {
  return [
    task.id,
    task.title,
    task.description,
    ...(Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : []),
    ...(Array.isArray(task.notes) ? task.notes : [])
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .toLowerCase();
}

function buildUnicodeBoundaryPattern(pattern) {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(pattern)}([^\\p{L}\\p{N}]|$)`,
    "iu"
  );
}

function matchesConfiguredTaskPattern(task, modelPolicy) {
  const patterns = normalizePatternList(modelPolicy?.escalation?.forceProTaskPatterns);
  const haystack = taskText(task);

  return patterns.find((pattern) => buildUnicodeBoundaryPattern(pattern).test(haystack)) ?? null;
}

function hasBlockedHistory(task) {
  return Array.isArray(task.notes) && task.notes.some((note) => /retry-escalated:|result:blocked/i.test(note));
}

function hasDispatchFailureHistory(task) {
  return Array.isArray(task.notes) && task.notes.some((note) => /dispatch:(failed|incomplete)/i.test(note));
}

function usesSamplingControls(modelId) {
  return !["local-ci", "manual"].includes(String(modelId).trim().toLowerCase());
}

function normalizeDeterministicNumber(value, fallback, { minimum = Number.NEGATIVE_INFINITY, maximum = Number.POSITIVE_INFINITY } = {}) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, minimum), maximum);
}

function buildDeterministicSettings(modelId, configuredSettings = {}) {
  const settings = {
    fixedModelId: modelId
  };

  if (!usesSamplingControls(modelId)) {
    return settings;
  }

  settings.temperature = normalizeDeterministicNumber(
    configuredSettings.temperature,
    0,
    { minimum: 0, maximum: 2 }
  );
  settings.maxTokens = Math.trunc(
    normalizeDeterministicNumber(configuredSettings.maxTokens, 12000, { minimum: 1 })
  );

  if (configuredSettings.topP !== undefined && configuredSettings.topP !== null) {
    settings.topP = normalizeDeterministicNumber(
      configuredSettings.topP,
      1,
      { minimum: 0, maximum: 1 }
    );
  }

  return settings;
}

export function selectModelForTask(task, runState) {
  const configuredModelPolicy = runState?.modelPolicy ?? {};
  const modelPolicy = {
    ...defaultModelPolicy,
    ...configuredModelPolicy
  };
  const defaultRolePolicy = defaultModelPolicy[task.role] ?? {
    defaultModel: "manual",
    deterministicSettings: {},
    escalatedDeterministicSettings: {},
    autoSwitch: false
  };
  const configuredRolePolicy = configuredModelPolicy?.[task.role] ?? {};
  const rolePolicy = {
    ...defaultRolePolicy,
    ...configuredRolePolicy,
    deterministicSettings: {
      ...(defaultRolePolicy.deterministicSettings ?? {}),
      ...(configuredRolePolicy.deterministicSettings ?? {})
    },
    escalatedDeterministicSettings: {
      ...(defaultRolePolicy.deterministicSettings ?? {}),
      ...(defaultRolePolicy.escalatedDeterministicSettings ?? {}),
      ...(configuredRolePolicy.deterministicSettings ?? {}),
      ...(configuredRolePolicy.escalatedDeterministicSettings ?? {})
    }
  };
  const escalationPolicy = {
    ...defaultModelPolicy.escalation,
    ...(modelPolicy?.escalation ?? {})
  };
  const reasons = [];

  if (rolePolicy.autoSwitch && rolePolicy.escalatedModel) {
    if (
      escalationPolicy.escalateOnAttentionRequired &&
      runState?.status === "attention_required"
    ) {
      reasons.push("run is in attention_required");
    }

    if ((task.retryCount ?? 0) >= escalationPolicy.minimumRetryCount) {
      reasons.push(`retryCount >= ${escalationPolicy.minimumRetryCount}`);
    }

    if ((task.attempts ?? 0) >= escalationPolicy.minimumAttempts) {
      reasons.push(`attempts >= ${escalationPolicy.minimumAttempts}`);
    }

    if (escalationPolicy.escalateOnBlockedHistory && hasBlockedHistory(task)) {
      reasons.push("task previously escalated or hit a blocked result");
    }

    if (escalationPolicy.escalateOnDispatchFailure && hasDispatchFailureHistory(task)) {
      reasons.push("task has prior dispatch failure history");
    }

    if (Array.isArray(escalationPolicy.forceProTaskIds) && escalationPolicy.forceProTaskIds.includes(task.id)) {
      reasons.push("task id is configured for forced pro review");
    }

    const matchedPattern = matchesConfiguredTaskPattern(task, modelPolicy);

    if (matchedPattern) {
      reasons.push(`task text matches configured pro pattern "${matchedPattern}"`);
    }
  }

  const escalated = reasons.length > 0 && rolePolicy.autoSwitch && Boolean(rolePolicy.escalatedModel);
  const preferredModel = escalated ? rolePolicy.escalatedModel : rolePolicy.defaultModel;
  const deterministicSettings = buildDeterministicSettings(
    preferredModel,
    escalated ? rolePolicy.escalatedDeterministicSettings : rolePolicy.deterministicSettings
  );
  const selectionMode = escalated ? "escalated" : "default";
  const selectionReason = escalated
    ? `Escalated to ${preferredModel} because ${reasons.join("; ")}.`
    : `${preferredModel} is the default model for ${task.role}.`;

  return {
    role: task.role,
    preferredModel,
    fallbackModel: rolePolicy.defaultModel,
    autoSwitch: Boolean(rolePolicy.autoSwitch),
    selectionMode,
    selectionReason,
    deterministicSettings,
    escalated,
    triggers: reasons
  };
}
