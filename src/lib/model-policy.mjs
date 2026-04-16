export const defaultModelPolicy = {
  orchestrator: {
    defaultModel: "openclaw",
    autoSwitch: false
  },
  planner: {
    defaultModel: "gpt-5.4",
    escalatedModel: "gpt-5.4-pro",
    autoSwitch: true
  },
  reviewer: {
    defaultModel: "gpt-5.4",
    escalatedModel: "gpt-5.4-pro",
    autoSwitch: true
  },
  executor: {
    defaultModel: "codex",
    autoSwitch: false
  },
  verifier: {
    defaultModel: "local-ci",
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

export function selectModelForTask(task, runState) {
  const modelPolicy = {
    ...defaultModelPolicy,
    ...(runState?.modelPolicy ?? {})
  };
  const rolePolicy = {
    ...(defaultModelPolicy[task.role] ?? {
      defaultModel: "manual",
      autoSwitch: false
    }),
    ...(modelPolicy?.[task.role] ?? {})
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
    escalated,
    triggers: reasons
  };
}
