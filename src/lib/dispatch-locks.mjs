import { open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { isNonEmptyString } from "./dispatch-utils.mjs";

const dispatchLockSuffix = ".dispatch.lock";
const descriptorExecutionLockSuffix = ".execute.lock";
const dispatchLockTimeoutMs = 15000;
const dispatchLockRetryDelayMs = 100;
const dispatchLockStaleMs = 120000;
const descriptorExecutionLockUninitializedMs = 5000;

function parseLockPid(lockContent) {
  const match = /^(\d+)/.exec(String(lockContent).trim());

  if (!match) {
    return null;
  }

  const parsedPid = Number.parseInt(match[1], 10);
  return Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "EINVAL")
    ) {
      return false;
    }

    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }

    return true;
  }
}

export function sleep(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function acquireDispatchLock(lockPath) {
  const deadline = Date.now() + dispatchLockTimeoutMs;

  while (true) {
    try {
      const lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");

      return async () => {
        await lockHandle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      try {
        const existingLockStats = await stat(lockPath);

        if (Date.now() - existingLockStats.mtimeMs > dispatchLockStaleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (!(statError instanceof Error) || !("code" in statError) || statError.code !== "ENOENT") {
          throw statError;
        }

        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for dispatch run-state lock: ${lockPath}`, {
          cause: error
        });
      }

      await sleep(dispatchLockRetryDelayMs);
    }
  }
}

export async function withDispatchLock(runStatePath, action) {
  const releaseLock = await acquireDispatchLock(`${runStatePath}${dispatchLockSuffix}`);

  try {
    return await action();
  } finally {
    await releaseLock();
  }
}

function resolveDescriptorExecutionLockPath(descriptor) {
  const lockTarget = descriptor.resultPath ?? descriptor.launcherPath;
  return `${path.resolve(lockTarget)}${descriptorExecutionLockSuffix}`;
}

export function appendNoteFragment(baseNote, nextNote) {
  if (!isNonEmptyString(baseNote)) {
    return isNonEmptyString(nextNote) ? nextNote.trim() : null;
  }

  if (!isNonEmptyString(nextNote)) {
    return baseNote.trim();
  }

  return `${baseNote.trim()} ${nextNote.trim()}`.trim();
}

async function recoverDescriptorExecutionLock(lockPath, descriptor) {
  let lockContent;
  let lockStats;

  try {
    [lockContent, lockStats] = await Promise.all([
      readFile(lockPath, "utf8").catch(() => ""),
      stat(lockPath)
    ]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        recovered: true,
        note: null
      };
    }

    throw error;
  }

  const lockPid = parseLockPid(lockContent);
  const lockAgeMs = Date.now() - lockStats.mtimeMs;

  if (lockPid !== null && !isProcessAlive(lockPid)) {
    await rm(lockPath, { force: true });
    return {
      recovered: true,
      note:
        `Recovered stale orphaned execution lock for task ${descriptor.taskId} ` +
        `(dead pid ${lockPid}).`
    };
  }

  if ((lockStats.size === 0 || lockPid === null) && lockAgeMs > descriptorExecutionLockUninitializedMs) {
    await rm(lockPath, { force: true });
    return {
      recovered: true,
      note:
        `Recovered uninitialized execution lock for task ${descriptor.taskId} ` +
        `(age ${lockAgeMs}ms).`
    };
  }

  if (lockAgeMs > dispatchLockStaleMs) {
    await rm(lockPath, { force: true });
    return {
      recovered: true,
      note:
        `Recovered aged execution lock for task ${descriptor.taskId} ` +
        `(pid ${lockPid}, age ${lockAgeMs}ms).`
    };
  }

  return {
    recovered: false,
    note: null
  };
}

export async function tryAcquireDescriptorExecutionLock(descriptor, recoveredNote = null) {
  const lockPath = resolveDescriptorExecutionLockPath(descriptor);

  try {
    const lockHandle = await open(lockPath, "wx");
    await lockHandle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");

    return {
      recoveredNote,
      release: async () => {
        await lockHandle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }

    const recovery = await recoverDescriptorExecutionLock(lockPath, descriptor);

    if (recovery.recovered) {
      return tryAcquireDescriptorExecutionLock(
        descriptor,
        appendNoteFragment(recoveredNote, recovery.note)
      );
    }

    return null;
  }
}
