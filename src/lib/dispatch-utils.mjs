import { createHash } from "node:crypto";
import { access } from "node:fs/promises";

export function readPositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name];
  const parsedValue = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

export function hashTextSha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizePositiveInteger(value, fallbackValue) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : fallbackValue;
}

export async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function dedupeText(items) {
  return [...new Set((items ?? []).filter(isNonEmptyString).map((item) => item.trim()))].join(" ");
}
