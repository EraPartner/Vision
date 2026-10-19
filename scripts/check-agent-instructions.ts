#!/usr/bin/env bun
/**
 * Check instruction structure without installing application dependencies.
 *
 * This is a structural check; semantic instruction quality still needs review.
 */
import fs from "node:fs";
import path from "node:path";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

interface BunToml {
  TOML: { parse(source: string): unknown };
}

function parseToml(source: string): unknown {
  const runtime = (globalThis as { Bun?: BunToml }).Bun;
  if (!runtime)
    throw new Error("check-agent-instructions requires Bun (TOML parser)");
  return runtime.TOML.parse(source);
}

function walkMarkdown(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walkMarkdown(full));
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

/** Returns the first structural error in one Markdown instruction file. */
export function checkMarkdown(name: string, text: string): string | undefined {
  if (!text.trim() || /^(<<<<<<< |=======$|>>>>>>> )/m.test(text)) {
    return `${name}: empty content or unresolved conflict`;
  }
  if (path.basename(name) !== "SKILL.md") return undefined;
  const separator = text.indexOf("---");
  const closing = separator === -1 ? -1 : text.indexOf("---", separator + 3);
  if (closing === -1 || text.slice(0, separator).trim()) {
    return `${name}: missing skill frontmatter`;
  }
  const frontmatter = text.slice(separator + 3, closing);
  for (const field of ["name", "description"]) {
    if (!new RegExp(`^${field}:\\s*\\S`, "m").test(frontmatter)) {
      return `${name}: missing ${field}`;
    }
  }
  return undefined;
}

/** Returns the first missing required field in one Codex agent role. */
export function checkAgentRole(
  name: string,
  agent: unknown,
): string | undefined {
  const record = (
    typeof agent === "object" && agent !== null ? agent : {}
  ) as Record<string, unknown>;
  for (const field of ["name", "description", "developer_instructions"]) {
    const value = record[field];
    if (typeof value !== "string" || !value.trim())
      return `${name}: missing ${field}`;
  }
  return undefined;
}

// Opening with O_NOFOLLOW makes the symlink check and the read one operation.
function readWithoutFollowing(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return undefined;
    throw error;
  }
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function checkRepository(root: string): string | undefined {
  for (const directory of [".agents", ".codex"]) {
    for (const file of walkMarkdown(path.join(root, directory)).sort()) {
      const name = path.relative(root, file);
      const text = readWithoutFollowing(file);
      if (text === undefined) {
        return `${name}: instruction symlinks require explicit review`;
      }
      const error = checkMarkdown(name, text);
      if (error) return error;
    }
  }
  const agents = path.join(root, ".codex/agents");
  const roles = fs.existsSync(agents)
    ? fs
        .readdirSync(agents)
        .filter((file) => file.endsWith(".toml"))
        .sort()
    : [];
  for (const file of roles) {
    const full = path.join(agents, file);
    const error = checkAgentRole(
      path.relative(root, full),
      parseToml(fs.readFileSync(full, "utf8")),
    );
    if (error) return error;
  }
  return undefined;
}

if (isEntrypoint(import.meta)) {
  const error = checkRepository(ROOT);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(
    "Agent Markdown and role TOML structure passed; semantic quality requires review.",
  );
}
