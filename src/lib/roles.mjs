import { defaultModelPolicy } from "./model-policy.mjs";

export const defaultFactoryConfig = {
  version: 1,
  roles: {
    orchestrator: {
      tool: "GPT Runner (gpt-5.4 / gpt-5.4-pro via Codex CLI)",
      automation: "automated",
      responsibilities: [
        "release coordination",
        "dispatch oversight",
        "retry policy decisions",
        "risk-stop enforcement"
      ],
      finalAuthority: false
    },
    planner: {
      tool: "GPT Runner (gpt-5.4 / gpt-5.4-pro via Codex CLI)",
      automation: "automated",
      responsibilities: ["spec breakdown", "risk clarification", "task sequencing"],
      finalAuthority: false
    },
    executor: {
      tool: "Codex",
      automation: "automated",
      responsibilities: ["implementation", "bug fixing", "execution work"],
      finalAuthority: false
    },
    reviewer: {
      tool: "GPT Runner (gpt-5.4 / gpt-5.4-pro via Codex CLI)",
      automation: "automated",
      responsibilities: ["requirements review", "quality review", "risk review"],
      finalAuthority: false
    },
    verifier: {
      tool: "CI / automated test system",
      automation: "automated",
      responsibilities: [
        "build",
        "lint",
        "typecheck",
        "unit test",
        "integration test",
        "e2e test"
      ],
      finalAuthority: true
    }
  },
  retryPolicy: {
    implementation: 3,
    review: 2,
    verification: 2,
    replanning: 2,
    hybridSurface: {
      maxAttempts: 3,
      retryDelayMinutes: 3,
      unlockAfterMinutes: 30
    }
  },
  mandatoryGates: ["build", "lint", "typecheck", "unit test", "integration test", "e2e test"],
  escalation: {
    stopOnRiskRules: true,
    maxConsecutiveFailures: 3
  },
  runtimeRouting: {
    roleOverrides: {}
  },
  modelPolicy: defaultModelPolicy,
  artifacts: {
    runDirectory: "runs",
    briefDirectory: "task-briefs",
    reportFile: "report.md",
    planJsonFile: "execution-plan.json",
    planMarkdownFile: "execution-plan.md",
    stateFile: "run-state.json",
    rolesFile: "roles.json",
    specSnapshotFile: "spec.snapshot.json",
    clarificationDirectory: "artifacts/clarification",
    intakeSpecFile: "intake-spec.json",
    intakeSummaryFile: "intake-summary.md"
  }
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return Array.isArray(override) ? [...override] : [...base];
  }

  const result = { ...base };

  for (const [key, value] of Object.entries(override ?? {})) {
    const currentValue = result[key];

    if (isPlainObject(currentValue) && isPlainObject(value)) {
      result[key] = deepMerge(currentValue, value);
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = [...value];
      continue;
    }

    result[key] = value;
  }

  return result;
}

export function mergeFactoryConfig(userConfig = {}) {
  return deepMerge(defaultFactoryConfig, userConfig);
}

export function roleDirectoryFromConfig(config) {
  return Object.entries(config.roles).map(([roleId, settings]) => ({
    roleId,
    ...settings
  }));
}
