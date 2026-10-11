#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

type JsonObject = Record<string, unknown>;

/** The file-system operations a bump needs; tests inject failures through it. */
export interface VersionBumpFileSystem {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  existsSync(path: string): boolean;
  rmSync(path: string, options: { force: boolean }): void;
  renameSync(oldPath: string, newPath: string): void;
}

interface ManifestEntry {
  filePath: string;
  originalText: string;
  manifest: JsonObject;
}

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MANIFESTS = [
  "package.json",
  "apps/frontend/package.json",
  "packaging/electron/package.json",
];

function readManifest(
  repoRoot: string,
  relativePath: string,
  fileSystem: VersionBumpFileSystem,
): ManifestEntry {
  const filePath = path.join(repoRoot, relativePath);
  const originalText = fileSystem.readFileSync(filePath, "utf8");
  const manifest: unknown = JSON.parse(originalText);
  if (!isJsonObject(manifest)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return { filePath, originalText, manifest };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function cleanup(fileSystem: VersionBumpFileSystem, filePath: string): void {
  if (fileSystem.existsSync(filePath))
    fileSystem.rmSync(filePath, { force: true });
}

export function bumpVersions(
  repoRoot: string,
  nextVersion: string,
  fileSystem: VersionBumpFileSystem = fs,
): string[] {
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

function main(): void {
  const nextVersion = process.argv[2];
  if (!nextVersion || process.argv.length !== 3) {
    console.error("Usage: bun run version:bump <x.y.z>");
    process.exitCode = 1;
    return;
  }

  try {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const changed = bumpVersions(repoRoot, nextVersion);
    for (const filePath of changed) {
      console.log(
        `Updated ${path.relative(repoRoot, filePath)} to ${nextVersion}`,
      );
    }
  } catch (error) {
    console.error(
      `Version bump failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) main();
