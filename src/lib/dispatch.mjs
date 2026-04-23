import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDirectory, readJson, writeJson } from "./fs-utils.mjs";
import { readHandoffIndexArtifact, readRunStateArtifact } from "./control-plane-artifacts.mjs";
import { ensureRunStateIntakePlanningReady } from "./intake-state.mjs";
import {
  appendNoteFragment,
  sleep,
  tryAcquireDescriptorExecutionLock,
  withDispatchLock
} from "./dispatch-locks.mjs";
import {
  classifyGptRunnerTransientSignal,
  computeGptRunnerRetryDelayMs,
  executionFromError,
  getGptRunnerLauncherAttempts,
  getLauncherTimeoutMs,
  isExhaustedTransientGptRunnerFailure,
  isLauncherPermissionDeniedError,
  isLauncherTimeoutError,
  isMissingResultArtifactReason,
  runLauncherScript,
  shouldRetryGptRunnerLauncher,
  tailTruncateExecutionOutput
} from "./dispatch-launcher.mjs";
import {
  dedupeText,
  fileExists,
  hashTextSha256,
  isNonEmptyString,
  normalizePositiveInteger
} from "./dispatch-utils.mjs";
import { validateResultArtifact } from "./result-artifact.mjs";
import { applyTaskArtifactToRunState } from "./result-application.mjs";
import { renderRunReport, updateTaskInRunState } from "./run-state.mjs";

const defaultLauncherPermissionRetryDelayMinutes = 1;

function fallbackRetryBudgetForRole(role) {
  if (role === "executor") {
    return 3;
  }

  if (role === "reviewer" || role === "verifier") {
    return 2;
  }

  return 1;
}

function parseRetryAfterDelayMinutes(value) {
  const text = String(value ?? "");
  const retryAfterMatch =
    /\bretry-after\b[^0-9]*(\d+)(?:\s*(seconds?|secs?|minutes?|mins?))?/i.exec(text) ??
    /\bretry after\b[^0-9]*(\d+)(?:\s*(seconds?|secs?|minutes?|mins?))?/i.exec(text);

  if (!retryAfterMatch) {
    return 1;
  }

  const amount = Number.parseInt(retryAfterMatch[1], 10);

  if (!Number.isFinite(amount) || amount <= 0) {
    return 1;
  }

  const unit = String(retryAfterMatch[2] ?? "").toLowerCase();

  if (/min/.test(unit)) {
    return Math.max(1, amount);
  }

  return Math.max(1, Math.ceil(amount / 60));
}

function classifyDoctorRuntimeDriftSignal({
  runtimeId,
  execution = null,
  error = null,
  resultArtifact = null
}) {
  if (runtimeId !== "gpt-runner") {
    return null;
  }

  if (resultArtifact?.valid) {
    return null;
  }

  if (resultArtifact && !error && !isMissingResultArtifactReason(resultArtifact.reason)) {
    return null;
  }

  const text = dedupeText([
    error instanceof Error ? error.message : error,
    error?.stdout,
    error?.stderr,
    execution?.stdout,
    execution?.stderr,
    resultArtifact?.reason
  ]);

  if (!isNonEmptyString(text)) {
    return null;
  }

  const normalizedText = text.toLowerCase();

  if (
    /\b401\b|\b403\b|unauthorized|forbidden|auth drift|authentication (failed|required)|login (expired|required)|not logged in|session expired|expired token|token expired|invalid api key/.test(
      normalizedText
    )
  ) {
    return {
      retryable: false,
      delayMinutes: 0,
      summary:
        "Doctor reported gpt-runner ready, but the first real task hit auth drift (401/403/login/session) and cannot continue automatically.",
      verification:
        "Observed post-doctor auth drift during first real GPT Runner execution; blocking for manual re-authentication.",
      signalSnippet: tailTruncateExecutionOutput(text)
    };
  }

  if (
    /model denial|model access denied|model .*denied|access to model|model .*not allowed|model .*not available|model .*unavailable|unsupported model|unknown model|invalid model|model .*not found/.test(
      normalizedText
    )
  ) {
    return {
      retryable: false,
      delayMinutes: 0,
      summary:
        "Doctor reported gpt-runner ready, but the first real task hit model denial or unavailable model access and cannot continue automatically.",
      verification:
        "Observed post-doctor model denial during first real GPT Runner execution; blocking for manual model access follow-up.",
      signalSnippet: tailTruncateExecutionOutput(text)
    };
  }

  if (/retry-after|rate limit|too many requests|\b429\b/.test(normalizedText)) {
    return {
      retryable: true,
      delayMinutes: parseRetryAfterDelayMinutes(text),
      summary:
        "Doctor reported gpt-runner ready, but the first real task hit upstream rate limiting (429 / Retry-After). Failing closed with an automatic retry window.",
      verification:
        "Observed upstream rate limiting after doctor readiness and scheduled an automatic retry.",
      signalSnippet: tailTruncateExecutionOutput(text)
    };
  }

  if (
    /provider timeout|gateway timeout|\b504\b|deadline exceeded|request timed out|timed out while waiting|upstream timed out|operation timed out|timeout contacting/.test(
      normalizedText
    )
  ) {
    return {
      retryable: true,
      delayMinutes: 1,
      summary:
        "Doctor reported gpt-runner ready, but the first real task hit a provider timeout. Failing closed with an automatic retry.",
      verification:
        "Observed provider timeout symptoms after doctor readiness and scheduled an automatic retry.",
      signalSnippet: tailTruncateExecutionOutput(text)
    };
  }

  return null;
}

function buildDoctorRuntimeDriftResult(
  descriptor,
  runtimeId,
  driftSignal,
  execution = null,
  notePrefix = null
) {
  const summary = dedupeText([
    driftSignal.summary,
    isNonEmptyString(driftSignal.signalSnippet)
      ? `launcherSignal=${driftSignal.signalSnippet}`
      : null
  ]);
  const artifact = validateResultArtifact(
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? null,
      status: "blocked",
      summary,
      changedFiles: [],
      verification: [driftSignal.verification],
      notes: [summary],
      ...(driftSignal.retryable
        ? {
            automationDecision: {
              action: "retry_task",
              reason: summary,
              delayMinutes: driftSignal.delayMinutes
            }
          }
        : {})
    },
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? undefined
    }
  );

  return buildDispatchResultFromArtifact(
    descriptor,
    runtimeId,
    {
      exists: true,
      valid: true,
      artifact,
      reason: null
    },
    execution,
    appendNoteFragment(
      notePrefix,
      "Converted doctor-to-runtime drift into a fail-closed blocked result."
    )
  );
}

function maybeBuildDoctorRuntimeDriftResult(
  descriptor,
  runtimeId,
  {
    execution = null,
    error = null,
    resultArtifact = null,
    notePrefix = null
  } = {}
) {
  const driftSignal = classifyDoctorRuntimeDriftSignal({
    runtimeId,
    execution,
    error,
    resultArtifact
  });

  if (!driftSignal) {
    return null;
  }

  return buildDoctorRuntimeDriftResult(
    descriptor,
    runtimeId,
    driftSignal,
    error ? executionFromError(error) : execution,
    notePrefix
  );
}

function normalizeExecutionGuardrails(descriptor) {
  const role = descriptor.role ?? descriptor.task?.role ?? null;
  const promptHash =
    descriptor.prompt?.hash ??
    descriptor.launcher?.metadata?.promptHash ??
    null;
  const promptHashAlgorithm =
    descriptor.prompt?.hashAlgorithm ??
    descriptor.launcher?.metadata?.promptHashAlgorithm ??
    null;
  const retryBudget = normalizePositiveInteger(
    descriptor.execution?.retryBudget,
    fallbackRetryBudgetForRole(role)
  );
  const timeoutMs = normalizePositiveInteger(
    descriptor.execution?.timeoutMs,
    descriptor.runtime?.id === "local-ci" ? 900000 : 300000
  );
  const circuitBreakerLimit = normalizePositiveInteger(
    descriptor.execution?.circuitBreakerLimit,
    retryBudget
  );
  const expectedIdempotencyKey = hashTextSha256(
    JSON.stringify({
      runId: descriptor.runId ?? null,
      taskId: descriptor.taskId ?? descriptor.task?.id ?? null,
      handoffId: descriptor.handoffId ?? null,
      runtimeId: descriptor.runtime?.id ?? null,
      promptHash
    })
  );
  const persistedIdempotencyKey = descriptor.execution?.idempotencyKey;

  if (isNonEmptyString(persistedIdempotencyKey) && persistedIdempotencyKey !== expectedIdempotencyKey) {
    throw new Error(
      `Descriptor idempotency key mismatch for task ${descriptor.taskId}: expected ${expectedIdempotencyKey}, received ${persistedIdempotencyKey}.`
    );
  }

  return {
    timeoutMs,
    retryBudget,
    circuitBreakerLimit,
    promptHash,
    promptHashAlgorithm,
    idempotencyKey: persistedIdempotencyKey ?? expectedIdempotencyKey
  };
}

function countDispatchFailureNotes(task) {
  return Array.isArray(task?.notes)
    ? task.notes.filter((note) => /dispatch:(failed|incomplete|prompt-hash-mismatch|retry-budget-exhausted|circuit-open)/i.test(note)).length
    : 0;
}

function countRetryBudgetConsumption(task) {
  const attempts = normalizePositiveInteger(task?.attempts, 0);
  const retryCount = normalizePositiveInteger(task?.retryCount, 0);
  const automaticRetriesConsumed = Math.max(0, retryCount - 1);

  return {
    attempts,
    retryCount,
    consumed: Math.max(attempts, automaticRetriesConsumed)
  };
}

function renderDispatchReport(summary, results) {
  return [
    "# Dispatch Report",
    "",
    `- mode: ${summary.mode}`,
    `- total: ${summary.total}`,
    `- executed: ${summary.executed}`,
    `- completed: ${summary.completed}`,
    `- continued: ${summary.continued}`,
    `- incomplete: ${summary.incomplete}`,
    `- would_execute: ${summary.wouldExecute}`,
    `- skipped: ${summary.skipped}`,
    `- would_skip: ${summary.wouldSkip}`,
    `- failed: ${summary.failed}`,
    "",
    "## Results",
    ...results.map(
      (result) =>
        `- ${result.taskId} -> ${result.status}${result.nextTaskStatus ? ` [task=${result.nextTaskStatus}]` : ""} (${result.runtime})`
    )
  ].join("\n");
}

function shouldAutoExecute(runtimeId) {
  return (
    runtimeId === "openclaw" ||
    runtimeId === "gpt-runner" ||
    runtimeId === "local-ci" ||
    runtimeId === "codex"
  );
}

async function hydrateDescriptor(indexDescriptor) {
  const handoffJsonPath = indexDescriptor.handoffJsonPath;

  if (!isNonEmptyString(handoffJsonPath) || !(await fileExists(handoffJsonPath))) {
    return indexDescriptor;
  }

  const persistedDescriptor = await readJson(handoffJsonPath);

  return {
    ...persistedDescriptor,
    ...indexDescriptor,
    taskId: indexDescriptor.taskId ?? persistedDescriptor.taskId,
    handoffId: indexDescriptor.handoffId ?? persistedDescriptor.handoffId,
    runId: indexDescriptor.runId ?? persistedDescriptor.runId,
    role: indexDescriptor.role ?? persistedDescriptor.role,
    runtime: {
      ...(persistedDescriptor.runtime ?? {}),
      ...(indexDescriptor.runtime ?? {})
    },
    task: {
      ...(persistedDescriptor.task ?? {}),
      ...(indexDescriptor.task ?? {})
    },
    launcher: {
      ...(persistedDescriptor.launcher ?? {}),
      ...(indexDescriptor.launcher ?? {})
    },
    paths: {
      ...(persistedDescriptor.paths ?? {}),
      ...(indexDescriptor.paths ?? {})
    },
    prompt: indexDescriptor.prompt ?? persistedDescriptor.prompt,
    execution: indexDescriptor.execution ?? persistedDescriptor.execution,
    launcherPath:
      indexDescriptor.launcherPath ??
      persistedDescriptor.launcherPath ??
      persistedDescriptor.paths?.launcherPath ??
      null,
    promptPath:
      indexDescriptor.promptPath ??
      persistedDescriptor.promptPath ??
      persistedDescriptor.paths?.promptPath ??
      null,
    resultPath:
      indexDescriptor.resultPath ??
      persistedDescriptor.resultPath ??
      persistedDescriptor.paths?.resultPath ??
      null
  };
}

async function validatePromptIntegrity(descriptor, executionGuardrails) {
  if (!isNonEmptyString(executionGuardrails.promptHash)) {
    return;
  }

  const algorithm = String(executionGuardrails.promptHashAlgorithm ?? "sha256").toLowerCase();

  if (algorithm !== "sha256") {
    throw new Error(
      `Unsupported prompt hash algorithm for task ${descriptor.taskId}: ${executionGuardrails.promptHashAlgorithm}`
    );
  }

  const promptPath = descriptor.promptPath ?? descriptor.paths?.promptPath ?? null;

  if (!isNonEmptyString(promptPath) || !(await fileExists(promptPath))) {
    throw new Error(`Prompt file not found for prompt-hash validation: ${promptPath ?? "unknown"}`);
  }

  const promptText = await readFile(promptPath, "utf8");
  const actualPromptHash = hashTextSha256(promptText);

  if (actualPromptHash !== executionGuardrails.promptHash) {
    throw new Error(
      `Prompt hash mismatch for ${promptPath}: expected ${executionGuardrails.promptHash}, received ${actualPromptHash}.`
    );
  }
}

async function readResultArtifactForExecution(
  resultPath,
  {
    runId = null,
    taskId = null,
    handoffId = null,
    minimumMtimeMs = null,
    maximumMtimeMs = null
  } = {}
) {
  if (!resultPath || !(await fileExists(resultPath))) {
    return {
      exists: false,
      valid: false,
      artifact: null,
      reason: "Result artifact was not written."
    };
  }

  try {
    const resultStats = await stat(resultPath);
    const minimumArtifactMtimeMs =
      typeof minimumMtimeMs === "number" ? minimumMtimeMs - 1000 : null;
    const maximumArtifactMtimeMs =
      typeof maximumMtimeMs === "number" ? maximumMtimeMs : null;

    if (typeof minimumArtifactMtimeMs === "number" && resultStats.mtimeMs < minimumArtifactMtimeMs) {
      return {
        exists: true,
        valid: false,
        artifact: null,
        reason: "Result artifact predates this launcher execution."
      };
    }

    if (typeof maximumArtifactMtimeMs === "number" && resultStats.mtimeMs > maximumArtifactMtimeMs) {
      return {
        exists: true,
        valid: false,
        artifact: null,
        reason: "Result artifact was written after the launcher timeout window."
      };
    }

    const artifact = await readJson(resultPath);

    try {
      return {
        exists: true,
        valid: true,
        artifact: validateResultArtifact(artifact, {
          runId: runId ?? undefined,
          taskId: taskId ?? undefined,
          handoffId: handoffId ?? undefined
        }),
        reason: null
      };
    } catch (validationError) {
      return {
        exists: true,
        valid: false,
        artifact,
        reason: validationError instanceof Error ? validationError.message : String(validationError)
      };
    }
  } catch (error) {
    return {
      exists: true,
      valid: false,
      artifact: null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function removeExistingResultArtifact(resultPath) {
  if (!resultPath) {
    return;
  }

  await rm(resultPath, {
    force: true
  });
}

function clearActiveHandoffFields(task) {
  return {
    ...task,
    activeHandoffId: null,
    activeResultPath: null,
    activeHandoffOutputDir: null
  };
}

function buildDispatchResultFromArtifact(descriptor, runtimeId, resultArtifact, execution = null, notePrefix = null) {
  const withPrefix = (message) => (notePrefix ? `${notePrefix} ${message}` : message);
  let status = "incomplete";
  let note = resultArtifact.reason ?? "Launcher finished but no result artifact was written.";

  if (resultArtifact.valid && resultArtifact.artifact?.status === "completed") {
    status = "completed";
    note = withPrefix("Result artifact passed validation.");
  } else if (resultArtifact.valid && resultArtifact.artifact?.status === "failed") {
    status = "failed";
    note = withPrefix("Runtime reported a failed task in the result artifact.");
  } else if (resultArtifact.valid && resultArtifact.artifact?.status === "blocked") {
    status = resultArtifact.artifact?.automationDecision ? "continued" : "incomplete";
    note = resultArtifact.artifact?.automationDecision
      ? withPrefix("Runtime reported a blocked task with an automatic continuation decision.")
      : withPrefix("Runtime reported a blocked task in the result artifact.");
  }

  return {
    taskId: descriptor.taskId,
    handoffId: descriptor.handoffId ?? null,
    runtime: runtimeId,
    status,
    launcherPath: descriptor.launcherPath,
    resultPath: descriptor.resultPath ?? null,
    artifact: resultArtifact.artifact,
    artifactValid: resultArtifact.valid,
    note,
    stdout: tailTruncateExecutionOutput(execution?.stdout),
    stderr: tailTruncateExecutionOutput(execution?.stderr)
  };
}

function buildTransientGptRunnerRetryResult(descriptor, execution = null, notePrefix = null) {
  const stdout = tailTruncateExecutionOutput(execution?.stdout);
  const stderr = tailTruncateExecutionOutput(execution?.stderr);
  const reason = dedupeText([
    "Transient GPT Runner upstream failure; automatically retrying the same task.",
    classifyGptRunnerTransientSignal(`${stdout}\n${stderr}`)
      ? "Observed transient provider or transport symptoms in launcher output."
      : null
  ]);
  const artifact = validateResultArtifact(
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? null,
      status: "blocked",
      summary: reason,
      changedFiles: [],
      verification: ["Observed transient GPT Runner provider failure and scheduled an automatic retry."],
      notes: [reason],
      automationDecision: {
        action: "retry_task",
        reason,
        delayMinutes: 0
      }
    },
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? undefined
    }
  );

  return buildDispatchResultFromArtifact(
    descriptor,
    "gpt-runner",
    {
      exists: true,
      valid: true,
      artifact,
      reason: null
    },
    execution,
    appendNoteFragment(notePrefix, "Converted exhausted transient GPT Runner failure into an automatic retry.")
  );
}

function buildLauncherPermissionRetryResult(
  descriptor,
  runtimeId,
  error = null,
  notePrefix = null
) {
  const execution = executionFromError(error);
  const stdout = tailTruncateExecutionOutput(execution.stdout);
  const stderr = tailTruncateExecutionOutput(execution.stderr);
  const errorMessage = error instanceof Error ? error.message : String(error ?? "");
  const reason = dedupeText([
    `Launcher process creation was denied for runtime ${runtimeId}; automatically retrying the same task after a short cooldown.`,
    "The host environment reported a permission or policy restriction while starting the launcher.",
    isNonEmptyString(errorMessage) ? errorMessage : null
  ]);
  const artifact = validateResultArtifact(
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? null,
      status: "blocked",
      summary: reason,
      changedFiles: [],
      verification: [
        `Observed launcher process creation denial while starting runtime ${runtimeId}.`
      ],
      notes: [reason],
      automationDecision: {
        action: "retry_task",
        reason,
        delayMinutes: defaultLauncherPermissionRetryDelayMinutes
      }
    },
    {
      runId: descriptor.runId,
      taskId: descriptor.taskId,
      handoffId: descriptor.handoffId ?? undefined
    }
  );

  return buildDispatchResultFromArtifact(
    descriptor,
    runtimeId,
    {
      exists: true,
      valid: true,
      artifact,
      reason: null
    },
    {
      stdout,
      stderr
    },
    appendNoteFragment(
      notePrefix,
      "Converted launcher process permission denial into an automatic retry."
    )
  );
}

async function tryRecoverExistingResultArtifact(runStatePath, descriptor, runtimeId, runId, notePrefix) {
  if (!(await fileExists(runStatePath)) || !descriptor.resultPath) {
    return null;
  }

  const recoveryState = await withDispatchLock(runStatePath, async () => {
    const runState = await readRunStateArtifact(runStatePath);
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

    if (!task || task.status !== "in_progress") {
      return null;
    }

    if (
      descriptor.handoffId &&
      (typeof task.activeHandoffId !== "string" ||
        task.activeHandoffId.trim().length === 0 ||
        task.activeHandoffId !== descriptor.handoffId)
    ) {
      return null;
    }

    if (
      typeof task.activeResultPath !== "string" ||
      task.activeResultPath.trim().length === 0 ||
      path.resolve(task.activeResultPath) !== path.resolve(descriptor.resultPath)
    ) {
      return null;
    }

    return {
      taskId: task.id,
      activeHandoffId: task.activeHandoffId,
      activeResultPath: task.activeResultPath
    };
  });

  if (!recoveryState) {
    return null;
  }

  const existingResultArtifact = await readResultArtifactForExecution(descriptor.resultPath, {
    runId: runId ?? null,
    taskId: descriptor.taskId,
    handoffId: descriptor.handoffId ?? null
  });

  if (!existingResultArtifact.valid) {
    return null;
  }

  return buildDispatchResultFromArtifact(
    descriptor,
    runtimeId,
    existingResultArtifact,
    null,
    notePrefix
  );
}

async function prepareTaskForExecution(
  runStatePath,
  planPath,
  reportPath,
  descriptor,
  executionGuardrails
) {
  if (!(await fileExists(runStatePath))) {
    return { shouldExecute: true, note: null };
  }

  return withDispatchLock(runStatePath, async () => {
    const runState = await readRunStateArtifact(runStatePath);
    const task = runState.taskLedger.find((item) => item.id === descriptor.taskId);

    if (!task) {
      return {
        shouldExecute: false,
        note: `Task not found in run-state: ${descriptor.taskId}`
      };
    }

    if (
      descriptor.handoffId &&
      (typeof task.activeHandoffId !== "string" ||
        task.activeHandoffId.trim().length === 0 ||
        task.activeHandoffId !== descriptor.handoffId)
    ) {
      return {
        shouldExecute: false,
        note: `Descriptor handoff ${descriptor.handoffId} is stale for task ${descriptor.taskId}.`
      };
    }

    if (
      descriptor.resultPath &&
      (typeof task.activeResultPath !== "string" ||
        task.activeResultPath.trim().length === 0 ||
        path.resolve(task.activeResultPath) !== path.resolve(descriptor.resultPath))
    ) {
      return {
        shouldExecute: false,
        note: `Descriptor result path is stale for task ${descriptor.taskId}.`
      };
    }

    if (!["ready", "in_progress"].includes(task.status)) {
      return {
        shouldExecute: false,
        note: `Task ${descriptor.taskId} is ${task.status}; launcher execution was skipped.`
      };
    }

    const retryBudgetState = countRetryBudgetConsumption(task);

    if (retryBudgetState.consumed >= executionGuardrails.retryBudget) {
      const guardedRunState = updateTaskInRunState(
        {
          ...runState,
          taskLedger: runState.taskLedger.map((item) =>
            item.id === descriptor.taskId ? clearActiveHandoffFields(item) : item
          )
        },
        descriptor.taskId,
        "blocked",
        `dispatch:retry-budget-exhausted attempts=${retryBudgetState.attempts} ` +
          `retryCount=${retryBudgetState.retryCount} budget=${executionGuardrails.retryBudget}`
      );

      await writeJson(runStatePath, guardedRunState);

      if (await fileExists(planPath)) {
        const plan = await readJson(planPath);
        await writeFile(reportPath, `${renderRunReport(guardedRunState, plan)}\n`, "utf8");
      }

      return {
        shouldExecute: false,
        note:
          `Retry budget exhausted for task ${descriptor.taskId} ` +
          `(attempts=${retryBudgetState.attempts}, retryCount=${retryBudgetState.retryCount}, ` +
          `budget=${executionGuardrails.retryBudget}).`
      };
    }

    const dispatchFailureCount = countDispatchFailureNotes(task);

    if (dispatchFailureCount >= executionGuardrails.circuitBreakerLimit) {
      const guardedRunState = updateTaskInRunState(
        {
          ...runState,
          taskLedger: runState.taskLedger.map((item) =>
            item.id === descriptor.taskId ? clearActiveHandoffFields(item) : item
          )
        },
        descriptor.taskId,
        "blocked",
        `dispatch:circuit-open failures=${dispatchFailureCount} limit=${executionGuardrails.circuitBreakerLimit}`
      );

      await writeJson(runStatePath, guardedRunState);

      if (await fileExists(planPath)) {
        const plan = await readJson(planPath);
        await writeFile(reportPath, `${renderRunReport(guardedRunState, plan)}\n`, "utf8");
      }

      return {
        shouldExecute: false,
        note:
          `Execution circuit breaker is open for task ${descriptor.taskId} ` +
          `(${dispatchFailureCount}/${executionGuardrails.circuitBreakerLimit} dispatch failures).`
      };
    }

    const taskStatus = task.status;

    if (task.status === "ready") {
      const nextRunState = updateTaskInRunState(
        runState,
        descriptor.taskId,
        "in_progress",
        `dispatch:claimed ${descriptor.handoffId ?? "unknown"}`
      );

      await writeJson(runStatePath, nextRunState);

      if (await fileExists(planPath)) {
        const plan = await readJson(planPath);
        await writeFile(reportPath, `${renderRunReport(nextRunState, plan)}\n`, "utf8");
      }
    }

    return { shouldExecute: true, note: null, taskStatus };
  });
}

async function syncDispatchResults(runStatePath, planPath, reportPath, results) {
  if (!(await fileExists(runStatePath))) {
    return null;
  }

  return withDispatchLock(runStatePath, async () => {
    let runState = await readRunStateArtifact(runStatePath);
    const updatedTasks = [];
    const resultUpdates = [];

    for (const result of results) {
      if (!["completed", "failed", "incomplete", "continued"].includes(result.status)) {
        continue;
      }

      const task = runState.taskLedger.find((item) => item.id === result.taskId);

      if (!task) {
        continue;
      }

      if (
        result.handoffId &&
        (typeof task.activeHandoffId !== "string" ||
          task.activeHandoffId.trim().length === 0 ||
          task.activeHandoffId !== result.handoffId)
      ) {
        continue;
      }

      if (
        result.resultPath &&
        (typeof task.activeResultPath !== "string" ||
          task.activeResultPath.trim().length === 0 ||
          path.resolve(task.activeResultPath) !== path.resolve(result.resultPath))
      ) {
        continue;
      }

      try {
        if (result.artifact && result.artifactValid) {
          const application = applyTaskArtifactToRunState(runState, result.taskId, result.artifact, {
            notePrefix: "dispatch"
          });
          runState = application.runState;
          updatedTasks.push(...application.updatedTasks);
          resultUpdates.push({
            taskId: result.taskId,
            status: result.status,
            nextTaskStatus: application.task?.status ?? null,
            appliedDecision: application.appliedDecision
          });
          continue;
        }

        runState = updateTaskInRunState(
          {
            ...runState,
            taskLedger: runState.taskLedger.map((item) =>
              item.id === result.taskId ? clearActiveHandoffFields(item) : item
            )
          },
          result.taskId,
          result.status === "failed" ? "failed" : "blocked",
          `dispatch:${result.status}`
        );
        updatedTasks.push({
          taskId: result.taskId,
          nextStatus: result.status === "failed" ? "failed" : "blocked"
        });
        resultUpdates.push({
          taskId: result.taskId,
          status: result.status,
          nextTaskStatus: result.status === "failed" ? "failed" : "blocked",
          appliedDecision: null
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        runState = updateTaskInRunState(
          {
            ...runState,
            taskLedger: runState.taskLedger.map((item) =>
              item.id === result.taskId ? clearActiveHandoffFields(item) : item
            )
          },
          result.taskId,
          "blocked",
          `dispatch:invalid-automation-decision ${reason}`
        );
        updatedTasks.push({
          taskId: result.taskId,
          nextStatus: "blocked"
        });
        resultUpdates.push({
          taskId: result.taskId,
          status: "incomplete",
          nextTaskStatus: "blocked",
          appliedDecision: null,
          error: reason
        });
      }
    }

    await writeJson(runStatePath, runState);

    if (await fileExists(planPath)) {
      const plan = await readJson(planPath);
      await writeFile(reportPath, `${renderRunReport(runState, plan)}\n`, "utf8");
    }

    return {
      runStatePath,
      reportPath: (await fileExists(reportPath)) ? reportPath : null,
      updatedTasks,
      resultUpdates
    };
  });
}

export async function dispatchHandoffs(indexPath, mode = "dry-run") {
  if (mode !== "dry-run" && mode !== "execute") {
    throw new Error(`Unsupported dispatch mode: ${mode}`);
  }

  const resolvedIndexPath = path.resolve(indexPath);
  const handoffIndex = await readHandoffIndexArtifact(resolvedIndexPath);
  const outputDir = path.dirname(resolvedIndexPath);
  const runDirectory = handoffIndex.runDirectory
    ? path.resolve(handoffIndex.runDirectory)
    : path.resolve(outputDir, "..");
  const runStatePath = handoffIndex.runStatePath
    ? path.resolve(handoffIndex.runStatePath)
    : path.join(runDirectory, "run-state.json");

  if (await fileExists(runStatePath)) {
    const runState = await readRunStateArtifact(runStatePath);
    const workspaceRoot =
      typeof runState?.workspacePath === "string" && runState.workspacePath.trim().length > 0
        ? path.resolve(runState.workspacePath)
        : path.resolve(path.dirname(runDirectory));
    await ensureRunStateIntakePlanningReady(runState, workspaceRoot, null, `dispatch ${mode}`);
  }
  /** @type {Array<{
   *   taskId: string,
   *   handoffId?: string | null,
   *   runtime: string,
   *   status: string,
   *   launcherPath: string,
  *   resultPath?: string | null,
  *   note?: string,
  *   error?: string,
  *   artifact?: any,
  *   nextTaskStatus?: string | null,
  *   appliedDecision?: any,
  *   stdout?: string,
  *   stderr?: string
  * }>} */
  const results = [];
  const seenIdempotencyKeys = new Set();

  for (const indexDescriptor of handoffIndex.descriptors) {
    let descriptor;

    try {
      descriptor = await hydrateDescriptor(indexDescriptor);
    } catch (error) {
      results.push({
        taskId: indexDescriptor.taskId,
        handoffId: indexDescriptor.handoffId ?? null,
        runtime: indexDescriptor.runtime?.id ?? "unknown",
        status: "failed",
        launcherPath: indexDescriptor.launcherPath,
        resultPath: indexDescriptor.resultPath ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const runtimeId = descriptor.runtime.id;

    if (mode === "dry-run") {
      results.push({
        taskId: descriptor.taskId,
        handoffId: descriptor.handoffId ?? null,
        runtime: runtimeId,
        status: shouldAutoExecute(runtimeId) ? "would_execute" : "would_skip",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null
      });
      continue;
    }

    if (!shouldAutoExecute(runtimeId)) {
      results.push({
        taskId: descriptor.taskId,
        handoffId: descriptor.handoffId ?? null,
        runtime: runtimeId,
        status: "skipped",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        note: "This runtime is currently treated as manual or hybrid only."
      });
      continue;
    }

    let executionGuardrails;

    try {
      executionGuardrails = normalizeExecutionGuardrails(descriptor);
    } catch (error) {
      results.push({
        taskId: descriptor.taskId,
        handoffId: descriptor.handoffId ?? null,
        runtime: runtimeId,
        status: "failed",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    let executionLock = null;

    try {
      const planPath = path.join(runDirectory, "execution-plan.json");
      const reportPath = path.join(runDirectory, "report.md");
      const runId = descriptor.runId ?? handoffIndex.runId ?? null;

      if (seenIdempotencyKeys.has(executionGuardrails.idempotencyKey)) {
        results.push({
          taskId: descriptor.taskId,
          handoffId: descriptor.handoffId ?? null,
          runtime: runtimeId,
          status: "skipped",
          launcherPath: descriptor.launcherPath,
          resultPath: descriptor.resultPath ?? null,
          note: `Duplicate idempotency key detected for task ${descriptor.taskId}; launcher execution was skipped.`
        });
        continue;
      }

      seenIdempotencyKeys.add(executionGuardrails.idempotencyKey);
      executionLock = await tryAcquireDescriptorExecutionLock(descriptor);

      if (!executionLock) {
        const recoveredResult = await tryRecoverExistingResultArtifact(
          runStatePath,
          descriptor,
          runtimeId,
          runId,
          "Recovered existing result artifact after restart while the previous execution lock was still present."
        );

        if (recoveredResult) {
          results.push(recoveredResult);
          continue;
        }

        results.push({
          taskId: descriptor.taskId,
          runtime: runtimeId,
          status: "skipped",
          launcherPath: descriptor.launcherPath,
          resultPath: descriptor.resultPath ?? null,
          note: "Another dispatch process is already executing this handoff."
        });
        continue;
      }

      const lockRecoveryNote = executionLock.recoveredNote;

      try {
        const preparation = await prepareTaskForExecution(
          runStatePath,
          planPath,
          reportPath,
          descriptor,
          executionGuardrails
        );

        if (!preparation.shouldExecute) {
          results.push({
            taskId: descriptor.taskId,
            handoffId: descriptor.handoffId ?? null,
            runtime: runtimeId,
            status: "skipped",
            launcherPath: descriptor.launcherPath,
            resultPath: descriptor.resultPath ?? null,
            note: appendNoteFragment(lockRecoveryNote, preparation.note)
          });
          continue;
        }

        if (preparation.taskStatus === "in_progress") {
          const recoveredResult = await tryRecoverExistingResultArtifact(
            runStatePath,
            descriptor,
            runtimeId,
            runId,
            "Recovered existing result artifact after restart."
          );

          if (recoveredResult) {
            results.push(recoveredResult);
            continue;
          }
        }

        await validatePromptIntegrity(descriptor, executionGuardrails);
        const maxLauncherAttempts = runtimeId === "gpt-runner" ? getGptRunnerLauncherAttempts() : 1;
        let completedResult = null;

        for (let launcherAttempt = 1; launcherAttempt <= maxLauncherAttempts; launcherAttempt += 1) {
          await removeExistingResultArtifact(descriptor.resultPath ?? null);
          const launcherStartedAtMs = Date.now();
          const launcherTimeoutMs = getLauncherTimeoutMs(executionGuardrails.timeoutMs);
          let execution;
          let resultArtifact;

          try {
            execution = await runLauncherScript(descriptor.launcherPath, executionGuardrails.timeoutMs);
          } catch (error) {
            if (isLauncherTimeoutError(error)) {
              resultArtifact = await readResultArtifactForExecution(descriptor.resultPath ?? null, {
                runId,
                taskId: descriptor.taskId,
                handoffId: descriptor.handoffId ?? null,
                minimumMtimeMs: launcherStartedAtMs,
                maximumMtimeMs: launcherStartedAtMs + launcherTimeoutMs
              });

              if (resultArtifact.valid) {
                completedResult = buildDispatchResultFromArtifact(
                  descriptor,
                  runtimeId,
                  resultArtifact,
                  executionFromError(error),
                  appendNoteFragment(
                    lockRecoveryNote,
                    "Launcher timed out after writing a valid result artifact."
                  )
                );
                break;
              }
            }

            if (
              shouldRetryGptRunnerLauncher({
                runtimeId,
                attemptNumber: launcherAttempt,
                maxAttempts: maxLauncherAttempts,
                error,
                resultArtifact
              })
            ) {
              await sleep(computeGptRunnerRetryDelayMs(launcherAttempt));
              continue;
            }

            if (
              isExhaustedTransientGptRunnerFailure({
                runtimeId,
                attemptNumber: launcherAttempt,
                maxAttempts: maxLauncherAttempts,
                error,
                resultArtifact
              })
            ) {
              completedResult = buildTransientGptRunnerRetryResult(
                descriptor,
                executionFromError(error),
                lockRecoveryNote
              );
              break;
            }

            if (isLauncherPermissionDeniedError(error)) {
              completedResult = buildLauncherPermissionRetryResult(
                descriptor,
                runtimeId,
                error,
                lockRecoveryNote
              );
              break;
            }

            completedResult = maybeBuildDoctorRuntimeDriftResult(
              descriptor,
              runtimeId,
              {
                error,
                notePrefix: lockRecoveryNote
              }
            );

            if (completedResult) {
              break;
            }

            throw error;
          }

          resultArtifact = await readResultArtifactForExecution(descriptor.resultPath ?? null, {
            runId,
            taskId: descriptor.taskId,
            handoffId: descriptor.handoffId ?? null,
            minimumMtimeMs: launcherStartedAtMs
          });

          if (
            shouldRetryGptRunnerLauncher({
              runtimeId,
              attemptNumber: launcherAttempt,
              maxAttempts: maxLauncherAttempts,
              execution,
              resultArtifact
            })
          ) {
            await sleep(computeGptRunnerRetryDelayMs(launcherAttempt));
            continue;
          }

          if (
            isExhaustedTransientGptRunnerFailure({
              runtimeId,
              attemptNumber: launcherAttempt,
              maxAttempts: maxLauncherAttempts,
              execution,
              resultArtifact
            })
          ) {
            completedResult = buildTransientGptRunnerRetryResult(descriptor, execution, lockRecoveryNote);
            break;
          }

          completedResult = maybeBuildDoctorRuntimeDriftResult(
            descriptor,
            runtimeId,
            {
              execution,
              resultArtifact,
              notePrefix: lockRecoveryNote
            }
          );

          if (completedResult) {
            break;
          }

          completedResult = buildDispatchResultFromArtifact(
            descriptor,
            runtimeId,
            {
              ...resultArtifact,
              artifact: resultArtifact.artifact,
              reason: resultArtifact.reason
            },
            {
              stdout: execution.stdout,
              stderr: execution.stderr
            },
            appendNoteFragment(
              lockRecoveryNote,
              launcherAttempt > 1 ? `Launcher finished after ${launcherAttempt} attempts.` : "Launcher finished."
            )
          );
          break;
        }

        if (!completedResult) {
          throw new Error(`Launcher execution produced no dispatch result for task ${descriptor.taskId}.`);
        }

        results.push(completedResult);
      } finally {
        await executionLock.release();
      }
    } catch (error) {
      results.push({
        taskId: descriptor.taskId,
        handoffId: descriptor.handoffId ?? null,
        runtime: runtimeId,
        status: "failed",
        launcherPath: descriptor.launcherPath,
        resultPath: descriptor.resultPath ?? null,
        note: executionLock?.recoveredNote ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const planPath = path.join(runDirectory, "execution-plan.json");
  const reportPath = path.join(runDirectory, "report.md");
  const runStateSync =
    mode === "execute"
      ? await syncDispatchResults(runStatePath, planPath, reportPath, results)
      : null;
  const finalResults =
    mode === "execute" && Array.isArray(runStateSync?.resultUpdates)
      ? results.map((result) => {
          if (!["completed", "continued", "incomplete", "failed"].includes(result.status)) {
            return result;
          }

          const update = runStateSync.resultUpdates.find((candidate) => candidate.taskId === result.taskId);

          if (!update) {
            return result;
          }

          return {
            ...result,
            status: update.status ?? result.status,
            nextTaskStatus: update.nextTaskStatus ?? result.nextTaskStatus ?? null,
            appliedDecision: update.appliedDecision ?? result.appliedDecision ?? null,
            error: update.error ?? result.error
          };
        })
      : results;
  const summary = {
    generatedAt: new Date().toISOString(),
    mode,
    total: finalResults.length,
    executed: finalResults.filter((item) =>
      item.status === "completed" ||
      item.status === "continued" ||
      item.status === "incomplete" ||
      item.status === "failed"
    ).length,
    completed: finalResults.filter((item) => item.status === "completed").length,
    continued: finalResults.filter((item) => item.status === "continued").length,
    incomplete: finalResults.filter((item) => item.status === "incomplete").length,
    wouldExecute: finalResults.filter((item) => item.status === "would_execute").length,
    skipped: finalResults.filter((item) => item.status === "skipped" || item.status === "would_skip").length,
    wouldSkip: finalResults.filter((item) => item.status === "would_skip").length,
    failed: finalResults.filter((item) => item.status === "failed").length
  };

  await ensureDirectory(outputDir);

  const resultJsonPath = path.join(outputDir, "dispatch-results.json");
  const resultMarkdownPath = path.join(outputDir, "dispatch-results.md");

  await writeJson(resultJsonPath, {
    summary,
    results: finalResults,
    runStateSync
  });
  await writeFile(resultMarkdownPath, `${renderDispatchReport(summary, finalResults)}\n`, "utf8");

  return {
    resultJsonPath,
    resultMarkdownPath,
    summary,
    results: finalResults,
    runStateSync
  };
}
