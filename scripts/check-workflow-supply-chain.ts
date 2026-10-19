#!/usr/bin/env bun
/** Fail closed on mutable Actions or checkout credentials in trusted workflows. */
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

export function checkRepository(root: string): string[] {
  const errors = discoverActions(root).flatMap((file) =>
    checkWorkflow(fs.readFileSync(file, "utf8"), path.relative(root, file)),
  );
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
  console.log("Trusted workflow admission OK");
}
