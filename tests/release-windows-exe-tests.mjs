import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createBackups,
  createReleaseManifestPayload,
  createWindowsReleaseNames,
  getWindowsArchitectureMetadata,
  reserveReleaseOutputRoot,
  stageSourceBackupSnapshot
} from "../scripts/release-windows-exe.mjs";
import { readZipEntriesFromFile } from "../src/lib/zip-archive.mjs";

const execFileAsync = promisify(execFile);

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function run(command, args, cwd) {
  return execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
}

async function createFixtureGitRepository() {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-release-git-fixture-"));

  await writeFile(path.join(repositoryRoot, "README.md"), "fixture repo\n", "utf8");
  await run("git", ["init"], repositoryRoot);
  await run("git", ["config", "user.email", "fixture@example.com"], repositoryRoot);
  await run("git", ["config", "user.name", "Fixture Runner"], repositoryRoot);
  await run("git", ["add", "README.md"], repositoryRoot);
  await run("git", ["commit", "-m", "fixture"], repositoryRoot);

  return repositoryRoot;
}

async function main() {
  await runTest("windows architecture metadata maps supported Node architectures", async () => {
    assert.deepEqual(getWindowsArchitectureMetadata("x64"), {
      nodeArchitecture: "x64",
      windowsTarget: "win-x64"
    });
    assert.deepEqual(getWindowsArchitectureMetadata("arm64"), {
      nodeArchitecture: "arm64",
      windowsTarget: "win-arm64"
    });
    assert.deepEqual(getWindowsArchitectureMetadata("ia32"), {
      nodeArchitecture: "ia32",
      windowsTarget: "win-x86"
    });
  });

  await runTest("unsupported Windows architectures fail fast", async () => {
    assert.throws(
      () => getWindowsArchitectureMetadata("loong64"),
      /Unsupported Windows architecture/i
    );
  });

  await runTest(
    "source backup staging excludes transient generated trees and nested output roots",
    async () => {
      const projectRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-release-stage-project-"));
      const outputRoot = path.join(projectRoot, "custom-output", "nested-release");
      const snapshotRoot = path.join(
        await mkdtemp(path.join(os.tmpdir(), "ai-factory-release-stage-snapshot-")),
        "source-snapshot"
      );

      await mkdir(path.join(projectRoot, "src"), { recursive: true });
      await mkdir(path.join(projectRoot, ".git"), { recursive: true });
      await mkdir(path.join(projectRoot, "node_modules", "pkg"), { recursive: true });
      await mkdir(path.join(projectRoot, "release-artifacts", "older-run"), { recursive: true });
      await mkdir(path.join(projectRoot, "reports", "release-readiness"), { recursive: true });
      await mkdir(path.join(projectRoot, "review-bundles", "bundle-a"), { recursive: true });
      await mkdir(path.join(projectRoot, "runs", "run-a"), { recursive: true });
      await mkdir(path.join(projectRoot, "tmp", "scratch"), { recursive: true });
      await mkdir(path.join(projectRoot, "custom-output", "nested-release", "generated"), { recursive: true });
      await mkdir(path.join(projectRoot, "custom-output"), { recursive: true });
      await mkdir(
        path.join(projectRoot, "custom-output", "windows-release-smoke", "20260417-000000-abc1234", "backups"),
        { recursive: true }
      );
      await mkdir(
        path.join(projectRoot, "custom-output", "windows-release-smoke", "20260417-000000-abc1234", "packages"),
        { recursive: true }
      );
      await mkdir(
        path.join(
          projectRoot,
          "custom-output",
          "windows-release-smoke",
          "20260417-000000-abc1234",
          "ai-factory-starter-win-x64-abc1234"
        ),
        { recursive: true }
      );

      await writeFile(path.join(projectRoot, "README.md"), "release test\n", "utf8");
      await writeFile(path.join(projectRoot, "src", "index.mjs"), "export {};\n", "utf8");
      await writeFile(path.join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
      await writeFile(path.join(projectRoot, "node_modules", "pkg", "index.js"), "module.exports = {};\n", "utf8");
      await writeFile(path.join(projectRoot, "release-artifacts", "older-run", "artifact.txt"), "old\n", "utf8");
      await writeFile(path.join(projectRoot, "reports", "release-readiness", "summary.json"), "{}\n", "utf8");
      await writeFile(path.join(projectRoot, "review-bundles", "bundle-a", "README.md"), "bundle\n", "utf8");
      await writeFile(path.join(projectRoot, "runs", "run-a", "run-state.json"), "{}\n", "utf8");
      await writeFile(path.join(projectRoot, "tmp", "scratch", "note.txt"), "scratch\n", "utf8");
      await writeFile(path.join(projectRoot, "custom-output", "keep.txt"), "keep\n", "utf8");
      await writeFile(
        path.join(projectRoot, "custom-output", "nested-release", "generated", "artifact.txt"),
        "generated\n",
        "utf8"
      );
      await writeFile(
        path.join(
          projectRoot,
          "custom-output",
          "windows-release-smoke",
          "20260417-000000-abc1234",
          "release-manifest.json"
        ),
        "{}\n",
        "utf8"
      );
      await writeFile(
        path.join(
          projectRoot,
          "custom-output",
          "windows-release-smoke",
          "20260417-000000-abc1234",
          "backups",
          "ai-factory-starter-20260417-000000-abc1234.git.bundle.lock"
        ),
        "lock\n",
        "utf8"
      );
      await writeFile(
        path.join(
          projectRoot,
          "custom-output",
          "windows-release-smoke",
          "20260417-000000-abc1234",
          "packages",
          "ai-factory-starter-0.1.0.tgz"
        ),
        "package\n",
        "utf8"
      );
      await writeFile(
        path.join(
          projectRoot,
          "custom-output",
          "windows-release-smoke",
          "20260417-000000-abc1234",
          "ai-factory-starter-win-x64-abc1234",
          "ai-factory-starter.exe"
        ),
        "exe\n",
        "utf8"
      );
      await writeFile(
        path.join(
          projectRoot,
          "custom-output",
          "windows-release-smoke",
          "20260417-000000-abc1234",
          "ai-factory-starter-win-x64-abc1234.zip"
        ),
        "zip\n",
        "utf8"
      );
      await mkdir(path.join(projectRoot, "notes", "20260417-000000-abc1234", "backups"), { recursive: true });
      await writeFile(
        path.join(projectRoot, "notes", "20260417-000000-abc1234", "backups", "release-notes.md"),
        "keep me\n",
        "utf8"
      );

      const result = await stageSourceBackupSnapshot(snapshotRoot, projectRoot, outputRoot);
      const stagedRelativePaths = result.files.map((file) => file.relativePath);

      assert.ok(stagedRelativePaths.includes("README.md"));
      assert.ok(stagedRelativePaths.includes("src/index.mjs"));
      assert.ok(stagedRelativePaths.includes("custom-output/keep.txt"));
      assert.ok(stagedRelativePaths.includes("notes/20260417-000000-abc1234/backups/release-notes.md"));
      assert.ok(!stagedRelativePaths.some((file) => file.startsWith(".git/")));
      assert.ok(!stagedRelativePaths.some((file) => file.startsWith("node_modules/")));
      assert.ok(!stagedRelativePaths.some((file) => file.startsWith("release-artifacts/")));
      assert.ok(!stagedRelativePaths.some((file) => file.startsWith("reports/")));
      assert.ok(!stagedRelativePaths.some((file) => file.startsWith("review-bundles/")));
      assert.ok(!stagedRelativePaths.some((file) => file.startsWith("runs/")));
      assert.ok(!stagedRelativePaths.some((file) => file.startsWith("tmp/")));
      assert.ok(!stagedRelativePaths.some((file) => file.startsWith("custom-output/nested-release/")));
      assert.ok(
        !stagedRelativePaths.some((file) =>
          file.startsWith("custom-output/windows-release-smoke/20260417-000000-abc1234/")
        )
      );

      await stat(path.join(snapshotRoot, "README.md"));
      await stat(path.join(snapshotRoot, "src", "index.mjs"));
      await assert.rejects(() => stat(path.join(snapshotRoot, ".git", "HEAD")));
      await assert.rejects(() => stat(path.join(snapshotRoot, "node_modules", "pkg", "index.js")));
      await assert.rejects(() => stat(path.join(snapshotRoot, "reports", "release-readiness", "summary.json")));
      await assert.rejects(() => stat(path.join(snapshotRoot, "review-bundles", "bundle-a", "README.md")));
      await assert.rejects(() => stat(path.join(snapshotRoot, "runs", "run-a", "run-state.json")));
      await assert.rejects(() => stat(path.join(snapshotRoot, "tmp", "scratch", "note.txt")));
      await assert.rejects(
        () => stat(path.join(snapshotRoot, "custom-output", "nested-release", "generated", "artifact.txt"))
      );
      await assert.rejects(() =>
        stat(
          path.join(
            snapshotRoot,
            "custom-output",
            "windows-release-smoke",
            "20260417-000000-abc1234",
            "backups",
            "ai-factory-starter-20260417-000000-abc1234.git.bundle.lock"
          )
        )
      );
    }
  );

  await runTest("release output root reservation avoids same-second collisions", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-release-output-root-"));
    const [firstPath, secondPath] = await Promise.all([
      reserveReleaseOutputRoot(outputRoot, "20260417-000000", "abc1234"),
      reserveReleaseOutputRoot(outputRoot, "20260417-000000", "abc1234")
    ]);
    const reservedNames = [path.basename(firstPath), path.basename(secondPath)].sort();

    assert.notEqual(firstPath, secondPath);
    assert.deepEqual(reservedNames, ["20260417-000000-abc1234", "20260417-000000-abc1234-2"]);
    await stat(firstPath);
    await stat(secondPath);
  });

  await runTest("release manifest payload records architecture-aware Windows artifact names", async () => {
    const releaseNames = createWindowsReleaseNames("abc1234", "arm64");
    const releaseDirectory = path.join("C:\\release", releaseNames.releaseDirectoryName);
    const releaseArchivePath = path.join("C:\\release", releaseNames.releaseArchiveFileName);
    const payload = createReleaseManifestPayload({
      branch: "main",
      commit: "abc1234",
      backupArtifacts: {
        bundlePath: "C:\\release\\backups\\repo.git.bundle",
        sourceZipPath: "C:\\release\\backups\\source.zip"
      },
      packageVersion: "0.1.0",
      packageArtifacts: {
        tarballPath: "C:\\release\\packages\\ai-factory-starter-0.1.0.tgz",
        tarballFileName: "ai-factory-starter-0.1.0.tgz"
      },
      releaseArtifacts: {
        nodeArchitecture: releaseNames.nodeArchitecture,
        windowsTarget: releaseNames.windowsTarget,
        releaseDirectoryName: releaseNames.releaseDirectoryName,
        releaseArchiveFileName: releaseNames.releaseArchiveFileName,
        releaseDirectory,
        releaseArchivePath,
        executablePath: path.join(releaseDirectory, "ai-factory-starter.exe"),
        appDirectory: path.join(releaseDirectory, "app")
      }
    });

    assert.equal(payload.backupOnly, false);
    assert.equal(payload.nodeArchitecture, "arm64");
    assert.equal(payload.windowsTarget, "win-arm64");
    assert.equal(payload.releaseDirectoryName, "ai-factory-starter-win-arm64-abc1234");
    assert.equal(payload.releaseArchiveFileName, "ai-factory-starter-win-arm64-abc1234.zip");
    assert.equal(payload.releaseDirectory, releaseDirectory);
    assert.equal(payload.releaseArchivePath, releaseArchivePath);
  });

  await runTest("backup artifacts include a real source zip in the requested output directory", async () => {
    const projectRoot = await createFixtureGitRepository();
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "ai-factory-release-backup-output-"));
    await mkdir(path.join(projectRoot, "reports"), { recursive: true });
    await mkdir(path.join(projectRoot, "review-bundles", "bundle-a"), { recursive: true });
    await mkdir(path.join(projectRoot, "runs", "run-a"), { recursive: true });
    await mkdir(path.join(projectRoot, "tmp"), { recursive: true });
    await writeFile(path.join(projectRoot, "reports", "runtime-doctor.json"), "{}\n", "utf8");
    await writeFile(path.join(projectRoot, "review-bundles", "bundle-a", "README.md"), "bundle\n", "utf8");
    await writeFile(path.join(projectRoot, "runs", "run-a", "run-state.json"), "{}\n", "utf8");
    await writeFile(path.join(projectRoot, "tmp", "artifact.tmp"), "tmp\n", "utf8");
    const backupArtifacts = await createBackups(outputRoot, "20260417-000000", "abc1234", {
      projectRootPath: projectRoot
    });

    await stat(backupArtifacts.bundlePath);
    await stat(backupArtifacts.sourceZipPath);
    assert.equal(path.dirname(backupArtifacts.sourceZipPath), backupArtifacts.backupsDirectory);
    assert.match(path.basename(backupArtifacts.sourceZipPath), /-source\.zip$/i);
    const zipEntries = await readZipEntriesFromFile(backupArtifacts.sourceZipPath);
    assert.ok(zipEntries.length > 0);
    assert.ok(zipEntries.every((entry) => !entry.name.includes("\\")));
    assert.ok(zipEntries.some((entry) => entry.name.endsWith("/README.md")));
    assert.ok(!zipEntries.some((entry) => entry.name.includes("/reports/")));
    assert.ok(!zipEntries.some((entry) => entry.name.includes("/review-bundles/")));
    assert.ok(!zipEntries.some((entry) => entry.name.includes("/runs/")));
    assert.ok(!zipEntries.some((entry) => entry.name.includes("/tmp/")));
  });

  console.log("Windows release packaging tests passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
