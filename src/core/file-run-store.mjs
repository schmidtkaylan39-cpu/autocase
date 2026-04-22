import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertRunRecord, assertTransitionRecord } from "../contracts/run-model.mjs";
import { assertRunStore } from "../contracts/run-store.mjs";

async function pathExists(targetPath) {
  try {
    await readFile(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function getRunDirectory(rootDir, runId) {
  return path.join(rootDir, runId);
}

function getRunRecordPath(rootDir, runId) {
  return path.join(getRunDirectory(rootDir, runId), "run.json");
}

function getTransitionLogPath(rootDir, runId) {
  return path.join(getRunDirectory(rootDir, runId), "transitions.ndjson");
}

async function ensureRunDirectory(rootDir, runId) {
  await mkdir(getRunDirectory(rootDir, runId), { recursive: true });
}

export function createFileRunStore({ rootDir }) {
  const resolvedRootDir = path.resolve(rootDir);

  const runStore = {
    kind: "file",
    rootDir: resolvedRootDir,

    async saveRun(runRecord) {
      assertRunRecord(runRecord);
      await ensureRunDirectory(resolvedRootDir, runRecord.runId);

      await writeFile(
        getRunRecordPath(resolvedRootDir, runRecord.runId),
        `${JSON.stringify(runRecord, null, 2)}\n`,
        "utf8"
      );
      await writeFile(
        getTransitionLogPath(resolvedRootDir, runRecord.runId),
        runRecord.transitions.map((transition) => JSON.stringify(transition)).join("\n") +
          (runRecord.transitions.length > 0 ? "\n" : ""),
        "utf8"
      );

      return runRecord;
    },

    async loadRun(runId) {
      const runRecordPath = getRunRecordPath(resolvedRootDir, runId);

      if (!(await pathExists(runRecordPath))) {
        return null;
      }

      const runRecord = JSON.parse(await readFile(runRecordPath, "utf8"));
      assertRunRecord(runRecord);
      return runRecord;
    },

    async hasRun(runId) {
      return pathExists(getRunRecordPath(resolvedRootDir, runId));
    },

    async listRunIds() {
      await mkdir(resolvedRootDir, { recursive: true });
      const entries = await readdir(resolvedRootDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    },

    async appendTransition(runId, transition) {
      assertTransitionRecord(transition);
      await ensureRunDirectory(resolvedRootDir, runId);
      await appendFile(
        getTransitionLogPath(resolvedRootDir, runId),
        `${JSON.stringify(transition)}\n`,
        "utf8"
      );

      return transition;
    },

    async loadTransitions(runId) {
      const transitionLogPath = getTransitionLogPath(resolvedRootDir, runId);

      if (!(await pathExists(transitionLogPath))) {
        return [];
      }

      const rawLog = await readFile(transitionLogPath, "utf8");
      const transitions = rawLog
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      for (const transition of transitions) {
        assertTransitionRecord(transition);
      }

      return transitions;
    }
  };

  assertRunStore(runStore);
  return runStore;
}
