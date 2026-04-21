import { TASK_TEMPLATE_IDS } from "../agents/contracts.mjs";
import { autofixTemplate } from "./autofix.mjs";
import { ebookTemplate } from "./ebook.mjs";
import { researchTemplate } from "./research.mjs";
import { createTaskTemplateInstance } from "./shared.mjs";
import { websiteTemplate } from "./website.mjs";

const templates = Object.freeze({
  ebook: ebookTemplate,
  website: websiteTemplate,
  research: researchTemplate,
  autofix: autofixTemplate
});

export function getTaskTemplate(templateId) {
  if (!TASK_TEMPLATE_IDS.includes(templateId)) {
    throw new Error(`Unknown task template: ${templateId}`);
  }

  return templates[templateId];
}

export function listTaskTemplates() {
  return TASK_TEMPLATE_IDS.map((templateId) => templates[templateId]);
}

export function buildTaskTemplateInstance({
  templateId,
  taskMode = "generic",
  title,
  goal,
  repoContext = null,
  overrides = {}
}) {
  return createTaskTemplateInstance(getTaskTemplate(templateId), {
    taskMode,
    title,
    goal,
    repoContext,
    overrides
  });
}

