#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MANIFESTS = [
  "package.json",
  "apps/frontend/package.json",
  "packaging/electron/package.json",
];

function readManifest(repoRoot, relativePath, fileSystem) {
  const filePath = path.join(repoRoot, relativePath);
  const originalText = fileSystem.readFileSync(filePath, "utf8");
  return { filePath, originalText, manifest: JSON.parse(originalText) };
}

function cleanup(fileSystem, filePath) {
  if (fileSystem.existsSync(filePath))
    fileSystem.rmSync(filePath, { force: true });
}

function bumpVersions(repoRoot, nextVersion, fileSystem = fs) {
  if (!VERSION_RE.test(nextVersion)) {
    throw new Error(
      `Version must use canonical x.y.z with no prefix, prerelease, or leading zeros: ${nextVersion}`,
    );
  }

  const entries = MANIFESTS.map((relativePath, index) => {
    const entry = readManifest(repoRoot, relativePath, fileSystem);
    const suffix = `.version-bump-${process.pid}-${Date.now()}-${index}`;
    return {
      ...entry,
      backupPath: `${entry.filePath}${suffix}.bak`,
      stagedPath: `${entry.filePath}${suffix}.tmp`,
    };
  });
  const currentVersions = new Set(
    entries.map(({ manifest }) => manifest.version),
  );
  if (currentVersions.size !== 1) {
    throw new Error(
      `Refusing to hide an existing version mismatch: ${[...currentVersions].join(", ")}`,
    );
  }

  try {
    for (const { manifest, stagedPath } of entries) {
      manifest.version = nextVersion;
      fileSystem.writeFileSync(
        stagedPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
    }

    for (const { backupPath, filePath, stagedPath } of entries) {
      fileSystem.renameSync(filePath, backupPath);
      fileSystem.renameSync(stagedPath, filePath);
    }
  } catch (error) {
    for (const { backupPath, filePath, stagedPath } of [...entries].reverse()) {
      cleanup(fileSystem, stagedPath);
      if (fileSystem.existsSync(backupPath)) {
        cleanup(fileSystem, filePath);
        fileSystem.renameSync(backupPath, filePath);
      }
    }
    throw error;
  }

  for (const { backupPath } of entries) {
    cleanup(fileSystem, backupPath);
  }

  return entries.map(({ filePath }) => filePath);
}

function main() {
  const nextVersion = process.argv[2];
  if (!nextVersion || process.argv.length !== 3) {
    console.error("Usage: bun run version:bump <x.y.z>");
    process.exitCode = 1;
    return;
  }

  try {
    const changed = bumpVersions(path.resolve(__dirname, ".."), nextVersion);
    for (const filePath of changed) {
      console.log(
        `Updated ${path.relative(path.resolve(__dirname, ".."), filePath)} to ${nextVersion}`,
      );
    }
  } catch (error) {
    console.error(`Version bump failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { bumpVersions };
