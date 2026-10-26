#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

type JsonObject = Record<string, unknown>;

const ROOT = path.resolve(import.meta.dirname, "..");
const INTERNAL = new Map([
  ["package.json", "vision"],
  ["apps/frontend/package.json", "vision-frontend"],
  ["apps/node-backend/package.json", "financial-transaction-manager-node"],
  ["packages/shared-utils/package.json", "@vision/shared-utils"],
  ["packages/types/package.json", "@vision/types"],
  ["packaging/electron/package.json", "vision-desktop"],
]);
const INSTALL_HOOKS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepack",
  "postpack",
]);
const REVIEWED_HOOKS = new Map([
  [
    "package.json:prepare",
    "12e7ff4466c1b2d5a774d93e35bd5ad2a1c4abf85de1641716f7d456b34d3c49",
  ],
  [
    "packaging/electron/package.json:postinstall",
    "bc2fb5676aa1e7bd7a7cdbbee5c40d429d6ea60def1dad7590d2876209410de0",
  ],
]);
// External tarball sources admitted after review, pinned by exact URL and the
// lockfile's sha512 integrity. SheetJS publishes xlsx only on its own CDN; the
// npm registry copy stops at 0.18.5, which has unpatched advisories.
const REVIEWED_EXTERNAL_SOURCES = new Map([
  [
    "xlsx",
    {
      url: "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
      integrity:
        "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==",
    },
  ],
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function entriesOf(value: unknown): [string, unknown][] {
  return value ? Object.entries(value) : [];
}

function byEntryName(left: [string, unknown], right: [string, unknown]): number {
  if (left[0] < right[0]) return -1;
  return left[0] > right[0] ? 1 : 0;
}

function isReviewedExternalSpecifier(
  dependency: string,
  specifier: string,
): boolean {
  return REVIEWED_EXTERNAL_SOURCES.get(dependency)?.url === specifier;
}

function isReviewedExternalLockRecord(
  name: string,
  record: readonly unknown[],
): boolean {
  const reviewed = REVIEWED_EXTERNAL_SOURCES.get(name);
  return (
    reviewed !== undefined &&
    record[0] === `${name}@${reviewed.url}` &&
    record[2] === reviewed.integrity
  );
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

// Bun writes trailing commas in bun.lock. Remove only commas outside JSON strings.
export function parseBunLock(source: string): unknown {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "," && /^\s*[}\]]/.test(source.slice(i + 1))) {
      // Bun's JSONC-style trailing comma.
    } else {
      result += char;
    }
  }
  return JSON.parse(result);
}

export function checkBoundaries(
  manifests: ReadonlyMap<string, unknown>,
  rootLock: unknown,
  electronLock: unknown,
): string[] {
  const errors: string[] = [];
  const expectedPaths = new Set(INTERNAL.keys());
  for (const pathname of manifests.keys()) {
    if (!expectedPaths.has(pathname))
      errors.push(`Unreviewed package manifest: ${pathname}`);
  }
  for (const [pathname, name] of INTERNAL) {
    const manifest = manifests.get(pathname);
    if (!manifest) {
      errors.push(`Missing internal package manifest: ${pathname}`);
      continue;
    }
    if (field(manifest, "name") !== name)
      errors.push(`${pathname}: expected internal name ${name}`);
    if (field(manifest, "private") !== true)
      errors.push(`${pathname}: must declare private: true`);
    for (const [hook, command] of entriesOf(field(manifest, "scripts"))) {
      if (!INSTALL_HOOKS.has(hook)) continue;
      const digest =
        typeof command === "string"
          ? createHash("sha256").update(command).digest("hex")
          : undefined;
      if (
        digest === undefined ||
        REVIEWED_HOOKS.get(`${pathname}:${hook}`) !== digest
      )
        errors.push(`${pathname}: unreviewed executable install hook ${hook}`);
    }
    for (const dependencyField of DEPENDENCY_FIELDS) {
      for (const [dependency, specifier] of entriesOf(
        field(manifest, dependencyField),
      )) {
        if (
          typeof specifier !== "string" ||
          (/^(?:https?:|git\+|github:|file:|link:)/i.test(specifier) &&
            !isReviewedExternalSpecifier(dependency, specifier))
        )
          errors.push(
            `${pathname}: unreviewed external dependency source ${dependency}`,
          );
        if (
          dependency.startsWith("@vision/") &&
          (!Array.from(INTERNAL.values()).includes(dependency) ||
            specifier !== "workspace:*")
        ) {
          errors.push(
            `${pathname}: ${dependency} must be a reviewed workspace dependency`,
          );
        }
      }
    }
  }

  const lockfiles: [string, unknown, [string, string][]][] = [
    [
      "bun.lock",
      rootLock,
      Array.from(INTERNAL.entries()).filter(
        ([p]) => p !== "packaging/electron/package.json",
      ),
    ],
    [
      "packaging/electron/bun.lock",
      electronLock,
      [["packaging/electron/package.json", "vision-desktop"]],
    ],
  ];
  for (const [lockName, lock, workspaces] of lockfiles) {
    for (const [pathname, name] of workspaces) {
      const key =
        pathname === "package.json" ||
        pathname === "packaging/electron/package.json"
          ? ""
          : path.dirname(pathname);
      const locked = field(field(lock, "workspaces"), key);
      if (field(locked, "name") !== name) {
        errors.push(
          `${lockName}: missing workspace ${key || "<root>"} (${name})`,
        );
      }
      const manifest = manifests.get(pathname);
      if (manifest && locked) {
        for (const dependencyField of DEPENDENCY_FIELDS) {
          const actual = entriesOf(field(manifest, dependencyField));
          const recorded = entriesOf(field(locked, dependencyField));
          if (
            JSON.stringify(actual.sort(byEntryName)) !==
            JSON.stringify(recorded.sort(byEntryName))
          )
            errors.push(
              `${lockName}: ${pathname} ${dependencyField} differs from the committed lockfile`,
            );
        }
      }
    }
    const internalNames = new Set(INTERNAL.values());
    for (const [name, record] of entriesOf(field(lock, "packages"))) {
      const entry: unknown[] | undefined = Array.isArray(record)
        ? record
        : undefined;
      if (entry && !String(entry[0]).includes("@workspace:")) {
        if (
          !isReviewedExternalLockRecord(name, entry) &&
          (!/^(@[^/]+\/)?[^@]+@\d/.test(String(entry[0])) ||
            !(
              typeof entry[3] === "string" &&
              /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry[3])
            ))
        )
          errors.push(
            `${lockName}: ${name} has an unreviewed source or missing integrity digest`,
          );
      }
      if (!name.startsWith("@vision/") && !internalNames.has(name)) continue;
      const resolution = entry?.[0];
      if (
        !internalNames.has(name) ||
        typeof resolution !== "string" ||
        !resolution.startsWith(`${name}@workspace:`)
      ) {
        errors.push(
          `${lockName}: ${name} unexpectedly resolves outside a reviewed workspace`,
        );
      }
    }
  }
  return errors;
}

function main(): void {
  const tracked = execFileSync("git", ["ls-files", "-z", "*package.json"], {
    cwd: ROOT,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const manifests = new Map<string, unknown>();
  for (const pathname of tracked) {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(ROOT, pathname), "utf8"),
    );
    manifests.set(pathname, manifest);
  }
  const errors = checkBoundaries(
    manifests,
    parseBunLock(fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8")),
    parseBunLock(
      fs.readFileSync(path.join(ROOT, "packaging/electron/bun.lock"), "utf8"),
    ),
  );
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("Internal package boundaries OK");
  }
}

if (isEntrypoint(import.meta)) main();
