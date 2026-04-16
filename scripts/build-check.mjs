import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function collectFiles(directory, extension, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectFiles(fullPath, extension, files);
      continue;
    }

    if (entry.isFile() && fullPath.endsWith(extension)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function checkSyntax(files) {
  for (const filePath of files) {
    await execFileAsync(process.execPath, ["--check", filePath], {
      cwd: projectRoot,
      encoding: "utf8"
    });
  }
}

async function validateJsonFiles(files) {
  for (const filePath of files) {
    const raw = await readFile(filePath, "utf8");
    JSON.parse(raw);
  }
}

async function main() {
  const jsFiles = [
    ...(await collectFiles(path.join(projectRoot, "src"), ".mjs")),
    ...(await collectFiles(path.join(projectRoot, "tests"), ".mjs")),
    ...(await collectFiles(path.join(projectRoot, "scripts"), ".mjs"))
  ];
  const jsonFiles = [
    path.join(projectRoot, "package.json"),
    path.join(projectRoot, "config", "factory.config.json"),
    path.join(projectRoot, "examples", "project-spec.valid.json"),
    path.join(projectRoot, "examples", "project-spec.invalid.json")
  ];

  await checkSyntax(jsFiles);
  await validateJsonFiles(jsonFiles);

  console.log(`Build check passed for ${jsFiles.length} JS files and ${jsonFiles.length} JSON files.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
