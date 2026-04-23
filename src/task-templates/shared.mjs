import { TASK_MODES, TASK_TEMPLATE_IDS } from "../agents/contracts.mjs";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function nonEmptyString(value, fieldName) {
  invariant(typeof value === "string" && value.trim().length > 0, `${fieldName} must be a non-empty string.`);
  return value.trim();
}

function stringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

function normalizeMode(mode) {
  invariant(TASK_MODES.includes(mode), `Unsupported task mode: ${mode}`);
  return mode;
}

export function createTaskTemplate(definition) {
  const templateId = nonEmptyString(definition?.id, "template.id");
  invariant(TASK_TEMPLATE_IDS.includes(templateId), `Unsupported task template id: ${templateId}`);

  const supportedModes = stringList(definition.supportedModes);
  invariant(supportedModes.length > 0, "Task template must support at least one mode.");
  supportedModes.forEach((mode) => normalizeMode(mode));

  return Object.freeze({
    id: templateId,
    label: nonEmptyString(definition.label, "template.label"),
    description: nonEmptyString(definition.description, "template.description"),
    supportedModes,
    modes: Object.freeze(definition.modes ?? {})
  });
}

export function createTaskTemplateInstance(template, {
  taskMode = "generic",
  title = template.label,
  goal = template.description,
  repoContext = null,
  overrides = {}
} = {}) {
  const normalizedMode = normalizeMode(taskMode);
  invariant(template.supportedModes.includes(normalizedMode), `Template ${template.id} does not support mode ${normalizedMode}.`);
  const modeDefinition = template.modes?.[normalizedMode];
  invariant(modeDefinition, `Template ${template.id} is missing a mode definition for ${normalizedMode}.`);

  return {
    templateId: template.id,
    taskMode: normalizedMode,
    title: nonEmptyString(title, "title"),
    goal: nonEmptyString(goal, "goal"),
    description: template.description,
    requiredInputs: stringList(modeDefinition.requiredInputs),
    deliverables: stringList(modeDefinition.deliverables),
    acceptanceCriteria: stringList(modeDefinition.acceptanceCriteria),
    roleGuidance: {
      planner: stringList(modeDefinition.roleGuidance?.planner),
      executor: stringList(modeDefinition.roleGuidance?.executor),
      reviewer: stringList(modeDefinition.roleGuidance?.reviewer),
      verifier: stringList(modeDefinition.roleGuidance?.verifier)
    },
    repoContext: normalizedMode === "repo" ? repoContext ?? {} : null,
    overrides
  };
}

