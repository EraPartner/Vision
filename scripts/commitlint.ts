#!/usr/bin/env bun
/**
 * Conventional Commits check (ADR-245). Replaces @commitlint/cli with
 * @commitlint/config-conventional and `defaultIgnores: false`: the same error
 * rules, the same conventional-changelog header pattern, no ignored messages
 * (merge commits fail). Warnings are printed and do not fail.
 *
 *   bun scripts/commitlint.ts --edit <file>      commit-msg hook
 *   bun scripts/commitlint.ts --from A --to B    every commit in A..B
 *   git log -1 --format=%B | bun scripts/commitlint.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

export const TYPES = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
] as const;
const MAX_LENGTH = 100;
// conventional-changelog-conventionalcommits headerPattern.
const HEADER = /^(\w*)(?:\((.*)\))?!?: (.*)$/;
// commitlint lets body and footer lines that contain a URL exceed the limit.
const URL = /\bhttps?:\/\/\S+/;
const SCISSORS = /^# -+ >8 -+$/;

export interface LintResult {
  errors: string[];
  warnings: string[];
}

/** Drop git comment lines and everything below the scissors line (hook input). */
export function stripComments(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (SCISSORS.test(line)) break;
    if (!line.startsWith("#")) lines.push(line);
  }
  return lines.join("\n");
}

export function lintMessage(raw: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = raw.split(/\r?\n/);
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  const [header = "", ...rest] = lines;
  const match = HEADER.exec(header);
  const type = match?.[1] ?? "";
  const subject = match?.[3] ?? "";

  if (header.length > MAX_LENGTH)
    errors.push(
      `header must not be longer than ${MAX_LENGTH} characters, current length is ${header.length} [header-max-length]`,
    );
  if (header !== header.trim())
    errors.push("header must not start or end with whitespace [header-trim]");
  if (type === "") errors.push("type may not be empty [type-empty]");
  else {
    if (type !== type.toLowerCase())
      errors.push("type must be lower-case [type-case]");
    if (!(TYPES as readonly string[]).includes(type))
      errors.push(`type must be one of [${TYPES.join(", ")}] [type-enum]`);
  }
  if (subject === "") errors.push("subject may not be empty [subject-empty]");
  else {
    // config-conventional forbids sentence-, start-, pascal- and upper-case
    // subjects. A subject that starts with a cased letter matches one of
    // those exactly when that letter is upper- or title-case.
    if (/^[\p{Lu}\p{Lt}]/u.test(subject))
      errors.push(
        "subject must not be sentence-case, start-case, pascal-case, upper-case [subject-case]",
      );
  }
  // commitlint tests the whole header here, so it also fires without a type.
  if (
    header.endsWith(".") &&
    !header.endsWith("...") &&
    header.indexOf(":") !== header.length - 1
  )
    errors.push("subject may not end with full stop [subject-full-stop]");
  const tooLong = rest.find(
    (line) => line.length > MAX_LENGTH && !URL.test(line),
  );
  if (tooLong !== undefined)
    errors.push(
      `body's lines must not be longer than ${MAX_LENGTH} characters [body-max-line-length]`,
    );
  if (rest.length > 0 && rest[0]?.trim() !== "")
    warnings.push("body must have leading blank line [body-leading-blank]");
  return { errors, warnings };
}

function messagesInRange(from: string, to: string): string[] {
  const out = execFileSync("git", ["log", "-z", "--format=%B", `${from}..${to}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((message) => message.trim() !== "");
}

function main(argv: string[]): number {
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const edit = flag("--edit");
  const from = flag("--from");
  const to = flag("--to");
  let messages: string[];
  if (edit !== undefined)
    messages = [stripComments(fs.readFileSync(edit, "utf8"))];
  else if (from !== undefined && to !== undefined)
    messages = messagesInRange(from, to);
  else if (argv.length === 0) messages = [fs.readFileSync(0, "utf8")];
  else {
    console.error(
      "usage: commitlint.ts --edit <file> | --from <rev> --to <rev> | < message",
    );
    return 2;
  }
  let failed = false;
  for (const message of messages) {
    const { errors, warnings } = lintMessage(message);
    if (errors.length === 0 && warnings.length === 0) continue;
    console.error(`input: ${message.split("\n", 1)[0]}`);
    for (const error of errors) console.error(`  x ${error}`);
    for (const warning of warnings) console.error(`  ! ${warning}`);
    if (errors.length > 0) failed = true;
  }
  if (failed)
    console.error(
      "Commit messages must follow Conventional Commits: type(scope): subject",
    );
  return failed ? 1 : 0;
}

if (isEntrypoint(import.meta)) process.exit(main(process.argv.slice(2)));
