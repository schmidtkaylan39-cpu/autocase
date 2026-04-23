function assertCondition(condition, message) {
  if (!condition) {
    throw new TypeError(message);
  }
}

/** @typedef {Record<string, unknown>} RunRecord */
/** @typedef {Record<string, unknown>} TransitionRecord */

/**
 * @typedef {object} RunStore
 * @property {string} kind
 * @property {(runRecord: RunRecord) => Promise<RunRecord>} saveRun
 * @property {(runId: string) => Promise<RunRecord | null>} loadRun
 * @property {(runId: string) => Promise<boolean>} hasRun
 * @property {() => Promise<string[]>} listRunIds
 * @property {(runId: string, transition: TransitionRecord) => Promise<TransitionRecord>} appendTransition
 * @property {(runId: string) => Promise<TransitionRecord[]>} loadTransitions
 */

export const RUN_STORE_METHODS = Object.freeze([
  "saveRun",
  "loadRun",
  "hasRun",
  "listRunIds",
  "appendTransition",
  "loadTransitions"
]);

export function assertRunStore(runStore) {
  assertCondition(runStore !== null && typeof runStore === "object", "RunStore must be an object.");
  assertCondition(typeof runStore.kind === "string" && runStore.kind.trim().length > 0, "RunStore.kind must be a non-empty string.");

  for (const methodName of RUN_STORE_METHODS) {
    assertCondition(
      typeof runStore[methodName] === "function",
      `RunStore.${methodName} must be a function.`
    );
  }
}
