const requiredTopLevelStringFields = ["projectName", "summary"];
const requiredArrayFields = [
  "targetUsers",
  "coreFeatures",
  "definitionOfDone",
  "acceptanceCriteria",
  "riskStopRules",
  "deliverables"
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function validateFeature(feature, index) {
  const errors = [];
  const label = `coreFeatures[${index}]`;

  if (!feature || typeof feature !== "object") {
    return [`${label} must be an object.`];
  }

  if (!isNonEmptyString(feature.id)) {
    errors.push(`${label}.id cannot be empty.`);
  }

  if (!isNonEmptyString(feature.title)) {
    errors.push(`${label}.title cannot be empty.`);
  }

  if (!isNonEmptyString(feature.description)) {
    errors.push(`${label}.description cannot be empty.`);
  }

  if (!isNonEmptyArray(feature.acceptanceCriteria)) {
    errors.push(`${label}.acceptanceCriteria must contain at least one item.`);
  }

  return errors;
}

export function validateProjectSpec(spec) {
  const errors = [];

  if (!spec || typeof spec !== "object") {
    return {
      valid: false,
      errors: ["Project spec must be a JSON object."]
    };
  }

  for (const field of requiredTopLevelStringFields) {
    if (!isNonEmptyString(spec[field])) {
      errors.push(`${field} cannot be empty.`);
    }
  }

  if (!spec.projectGoal || typeof spec.projectGoal !== "object") {
    errors.push("projectGoal must exist.");
  } else {
    if (!isNonEmptyString(spec.projectGoal.oneLine)) {
      errors.push("projectGoal.oneLine cannot be empty.");
    }
    if (!isNonEmptyString(spec.projectGoal.details)) {
      errors.push("projectGoal.details cannot be empty.");
    }
  }

  for (const field of requiredArrayFields) {
    if (!isNonEmptyArray(spec[field])) {
      errors.push(`${field} must contain at least one item.`);
    }
  }

  if (Array.isArray(spec.coreFeatures)) {
    spec.coreFeatures.forEach((feature, index) => {
      errors.push(...validateFeature(feature, index));
    });
  }

  if (!spec.technicalConstraints || typeof spec.technicalConstraints !== "object") {
    errors.push("technicalConstraints must exist.");
  } else if (!isNonEmptyArray(spec.technicalConstraints.preferredStack)) {
    errors.push("technicalConstraints.preferredStack must contain at least one item.");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function summarizeSpec(spec) {
  return {
    projectName: spec.projectName,
    coreFeatureCount: Array.isArray(spec.coreFeatures) ? spec.coreFeatures.length : 0,
    riskStopRuleCount: Array.isArray(spec.riskStopRules) ? spec.riskStopRules.length : 0,
    deliverableCount: Array.isArray(spec.deliverables) ? spec.deliverables.length : 0
  };
}
