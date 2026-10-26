#!/usr/bin/env bun
/**
 * Fail closed on mutable Actions or checkout credentials in trusted workflows,
 * and on dependency-install policy drift (ADR-245): no dependency lifecycle
 * scripts, a 7-day minimum release age, and lockfiles that resolve only from
 * the npm registry or the one pinned SheetJS tarball.
 */
import fs from "node:fs";
import path from "node:path";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const USE = /^\s*(?:-\s*)?uses:\s+(\S+)/;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

export function checkWorkflow(text: string, name: string): string[] {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((line, number) => {
    const action = USE.exec(line)?.[1];
    if (action === undefined) return;
    if (!action.startsWith("./") && !PINNED.test(action)) {
      errors.push(
        `${name}:${number + 1}: external action needs a full SHA pin`,
      );
    }
    if (!action.startsWith("actions/checkout@")) return;
    let stepIndent = indentOf(line);
    if (!line.trimStart().startsWith("- ")) stepIndent -= 2;
    const following: string[] = [];
    for (const candidate of lines.slice(number + 1)) {
      if (
        candidate.trimStart().startsWith("- ") &&
        indentOf(candidate) <= stepIndent
      )
        break;
      following.push(candidate);
    }
    const usesIndent = line.indexOf("uses:");
    const withLine = `${" ".repeat(usesIndent)}with:`;
    const setting = new RegExp(
      `^${" ".repeat(usesIndent + 2)}persist-credentials:\\s*false\\s*(?:#.*)?$`,
    );
    let hasSetting = false;
    const withIndex = following.indexOf(withLine);
    if (withIndex !== -1) {
      for (const attribute of following.slice(withIndex + 1)) {
        if (attribute.trim() && indentOf(attribute) <= usesIndent) break;
        if (setting.test(attribute)) hasSetting = true;
      }
    }
    if (!hasSetting)
      errors.push(
        `${name}:${number + 1}: checkout must disable persisted credentials`,
      );
    const block = following.join("\n");
    if (/^\s+repository:\s+([^\s#]+)/m.test(block)) {
      const revision = /^\s+ref:\s+([^\s#]+)/m.exec(block)?.[1];
      if (revision === undefined || !/^[0-9a-f]{40}$/.test(revision)) {
        errors.push(
          `${name}:${number + 1}: external repository checkout needs a full SHA ref`,
        );
      }
    }
  });
  if (/\bbunx\b/.test(text))
    errors.push(`${name}: dynamic bunx fallback is forbidden in trusted jobs`);
  return errors;
}

function listYaml(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => path.join(directory, file));
}

export function discoverActions(root: string): string[] {
  const actionsDir = path.join(root, ".github/actions");
  const actions = fs.existsSync(actionsDir)
    ? fs
        .readdirSync(actionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          ["action.yml", "action.yaml"]
            .map((file) => path.join(actionsDir, entry.name, file))
            .filter((file) => fs.existsSync(file)),
        )
    : [];
  return [...listYaml(path.join(root, ".github/workflows")), ...actions].sort();
}

/** Package roots with their own lockfile; each needs the same install policy. */
export const PACKAGE_ROOTS = [".", "packaging/electron"] as const;
export const MIN_RELEASE_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Non-registry tarballs that may appear in a lockfile (SheetJS is not on npm). */
export const ALLOWED_TARBALLS = [
  "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
] as const;

/** bun.lock is JSON with trailing commas. */
function parseBunLock(text: string): unknown {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

export function checkLockfile(text: string, name: string): string[] {
  const errors: string[] = [];
  let lock: unknown;
  try {
    lock = parseBunLock(text);
  } catch {
    return [`${name}: lockfile could not be parsed`];
  }
  const packages =
    typeof lock === "object" && lock !== null && "packages" in lock
      ? lock.packages
      : undefined;
  if (typeof packages !== "object" || packages === null)
    return [`${name}: lockfile has no packages table`];
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      errors.push(`${name}: ${key}: unrecognised lockfile entry`);
      continue;
    }
    const id = entry[0];
    const at = id.indexOf("@", 1);
    const source = at === -1 ? "" : id.slice(at + 1);
    if (source.startsWith("workspace:")) continue;
    if ((ALLOWED_TARBALLS as readonly string[]).includes(source)) continue;
    // Registry entries are ["name@<semver>", "", meta, integrity]; the empty
    // second slot means the default npm registry.
    const registry = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(source);
    if (!registry || entry[1] !== "" || typeof entry[3] !== "string") {
      errors.push(
        `${name}: ${key}: resolves outside the npm registry (${source || "no version"})`,
      );
    } else if (!entry[3].startsWith("sha512-")) {
      errors.push(`${name}: ${key}: missing sha512 integrity`);
    }
  }
  return errors;
}

export function checkInstallPolicy(
  manifest: string,
  bunfig: string | undefined,
  name: string,
): string[] {
  const errors: string[] = [];
  const parsed = JSON.parse(manifest) as { trustedDependencies?: unknown };
  if (
    !Array.isArray(parsed.trustedDependencies) ||
    parsed.trustedDependencies.length !== 0
  ) {
    errors.push(
      `${name}/package.json: trustedDependencies must be [] so no dependency install script runs`,
    );
  }
  const age = /^\s*minimumReleaseAge\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(
    bunfig ?? "",
  )?.[1];
  if (age === undefined || Number(age) < MIN_RELEASE_AGE_SECONDS) {
    errors.push(
      `${name}/bunfig.toml: [install] minimumReleaseAge must be at least ${MIN_RELEASE_AGE_SECONDS}`,
    );
  }
  return errors;
}

export function checkDependencyPolicy(root: string): string[] {
  return PACKAGE_ROOTS.flatMap((dir) => {
    const read = (file: string) => {
      const target = path.join(root, dir, file);
      return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
    };
    const manifest = read("package.json");
    const lock = read("bun.lock");
    if (manifest === undefined || lock === undefined)
      return [`${dir}: package.json and bun.lock are required`];
    return [
      ...checkInstallPolicy(manifest, read("bunfig.toml"), dir),
      ...checkLockfile(lock, path.join(dir, "bun.lock")),
    ];
  });
}

export function checkRepository(root: string): string[] {
  const errors = discoverActions(root).flatMap((file) =>
    checkWorkflow(fs.readFileSync(file, "utf8"), path.relative(root, file)),
  );
  errors.push(...checkDependencyPolicy(root));
  const setup = fs.readFileSync(
    path.join(root, ".github/actions/setup/action.yml"),
    "utf8",
  );
  if (!setup.includes("bun install --frozen-lockfile --ignore-scripts")) {
    errors.push(
      ".github/actions/setup/action.yml: install must be frozen and script-disabled",
    );
  }
  const release = fs.readFileSync(
    path.join(root, ".github/workflows/release.yml"),
    "utf8",
  );
  if (release.includes("actions/cache@") || release.includes("cache: npm")) {
    errors.push(
      ".github/workflows/release.yml: release build must not restore a general dependency cache",
    );
  }
  return errors;
}

if (isEntrypoint(import.meta)) {
  const errors = checkRepository(ROOT);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("Trusted workflow and dependency install policy OK");
}
