#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
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
    "07040d0c72f0978b82a87b6df3e07f73e469b75d864a01d2b79504fcf1a377c6",
  ],
  [
    "packaging/electron/package.json:postinstall",
    "bc2fb5676aa1e7bd7a7cdbbee5c40d429d6ea60def1dad7590d2876209410de0",
  ],
]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

// Bun writes trailing commas in bun.lock. Remove only commas outside JSON strings.
function parseBunLock(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
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

function checkBoundaries(manifests, rootLock, electronLock) {
  const errors = [];
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
    if (manifest.name !== name)
      errors.push(`${pathname}: expected internal name ${name}`);
    if (manifest.private !== true)
      errors.push(`${pathname}: must declare private: true`);
    for (const [hook, command] of Object.entries(manifest.scripts || {})) {
      if (!INSTALL_HOOKS.has(hook)) continue;
      const digest = createHash("sha256").update(command).digest("hex");
      if (REVIEWED_HOOKS.get(`${pathname}:${hook}`) !== digest)
        errors.push(`${pathname}: unreviewed executable install hook ${hook}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, specifier] of Object.entries(
        manifest[field] || {},
      )) {
        if (
          typeof specifier !== "string" ||
          /^(?:https?:|git\+|github:|file:|link:)/i.test(specifier)
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

  for (const [lockName, lock, workspaces] of [
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
  ]) {
    for (const [pathname, name] of workspaces) {
      const key =
        pathname === "package.json" ||
        pathname === "packaging/electron/package.json"
          ? ""
          : path.dirname(pathname);
      if (lock.workspaces?.[key]?.name !== name) {
        errors.push(
          `${lockName}: missing workspace ${key || "<root>"} (${name})`,
        );
      }
      const manifest = manifests.get(pathname);
      const locked = lock.workspaces?.[key];
      if (manifest && locked) {
        for (const field of DEPENDENCY_FIELDS) {
          const actual = manifest[field] || {};
          const recorded = locked[field] || {};
          if (
            JSON.stringify(Object.entries(actual).sort()) !==
            JSON.stringify(Object.entries(recorded).sort())
          )
            errors.push(
              `${lockName}: ${pathname} ${field} differs from the committed lockfile`,
            );
        }
      }
    }
    const internalNames = new Set(INTERNAL.values());
    for (const [name, record] of Object.entries(lock.packages || {})) {
      if (Array.isArray(record) && !String(record[0]).includes("@workspace:")) {
        if (
          !/^(@[^/]+\/)?[^@]+@\d/.test(record[0]) ||
          !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record[3] || "")
        )
          errors.push(
            `${lockName}: ${name} has an unreviewed source or missing integrity digest`,
          );
      }
      if (!name.startsWith("@vision/") && !internalNames.has(name)) continue;
      if (
        !internalNames.has(name) ||
        !Array.isArray(record) ||
        typeof record[0] !== "string" ||
        !record[0].startsWith(`${name}@workspace:`)
      ) {
        errors.push(
          `${lockName}: ${name} unexpectedly resolves outside a reviewed workspace`,
        );
      }
    }
  }
  return errors;
}

function main() {
  const tracked = execFileSync("git", ["ls-files", "-z", "*package.json"], {
    cwd: ROOT,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const manifests = new Map(
    tracked.map((pathname) => [
      pathname,
      JSON.parse(fs.readFileSync(path.join(ROOT, pathname), "utf8")),
    ]),
  );
  const errors = checkBoundaries(
    manifests,
    parseBunLock(fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8")),
    parseBunLock(
      fs.readFileSync(path.join(ROOT, "packaging/electron/bun.lock"), "utf8"),
    ),
  );
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("Internal package boundaries OK");
  }
}

if (require.main === module) main();

module.exports = { checkBoundaries, parseBunLock };
