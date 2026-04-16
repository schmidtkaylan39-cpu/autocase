import { mkdir, readFile, writeFile } from "node:fs/promises";

export async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
}

export async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson(filePath) {
  const raw = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}
