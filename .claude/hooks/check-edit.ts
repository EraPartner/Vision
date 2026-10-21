#!/usr/bin/env bun
/**
 * PostToolUse hook: after Claude edits TypeScript or JavaScript files, run the
 * owning TypeScript projects, ESLint and dependency-cruiser on them and report
 * problems back to Claude.
 *
 * Edit, MultiEdit and Write name their file. Bash does not, so a PreToolUse
 * hook on Bash records the start time per tool call, and the PostToolUse run
 * checks the files git reports as changed or untracked whose mtime is at or
 * after that start. That covers sed, heredocs, scripts and formatters.
 *
 * Registered with `asyncRewake` in .claude/settings.json, so it runs in the
 * background and never delays the edit. A clean result exits 0 silently; any
 * problem exits 2 with a short report on stderr, which wakes Claude with it.
 *
 * tsc runs incrementally with build info under node_modules/.cache, so after
 * the first run (or the session-start warm-up) a frontend check takes seconds.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { file_path?: string };
}

const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const CACHE = path.join(ROOT, "node_modules/.cache/claude-edit-check");
const BIN = path.join(ROOT, "node_modules/.bin");
const MARKS = path.join(CACHE, "bash-start");
const MAX_LINES = 40;
const TIMEOUT_MS = 180_000;
// More changed files than this after one Bash call is a checkout, rebase or
// generator run, not an edit; checking it would take minutes.
const MAX_BASH_FILES = 25;
// Start marks older than this belong to calls that never reached PostToolUse.
const STALE_MARK_MS = 6 * 60 * 60 * 1000;

const CHECKED = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIPPED = [
  /(^|\/)node_modules\//,
  /(^|\/)(out|out-[^/]+|dist[^/]*|coverage)\//,
  /\.generated\.ts$/,
  /^apps\/frontend\/src\/types\/generated\.ts$/,
  /^apps\/frontend\/src\/locales\//,
];

// The first matching prefix decides the TypeScript project, mirroring the
// typecheck scripts in package.json.
const PROJECTS: Array<[RegExp, string]> = [
  [/^apps\/frontend\/src\//, "apps/frontend/tsconfig.app.json"],
  [
    /^apps\/frontend\/(vite\.config\.ts|scripts\/)/,
    "apps/frontend/tsconfig.node.json",
  ],
  [/^apps\/node-backend\/src\//, "apps/node-backend/tsconfig.json"],
  [/^apps\/node-backend\/tests\//, "apps/node-backend/tsconfig.tests.json"],
  [/^apps\/node-backend\/scripts\//, "apps/node-backend/tsconfig.scripts.json"],
  [/^packages\/types\//, "packages/types/tsconfig.json"],
  [/^packages\/shared-utils\/src\//, "packages/shared-utils/tsconfig.json"],
  [/^packages\/shared-utils\//, "packages/shared-utils/tsconfig.tests.json"],
  [
    /^packaging\/electron\/(preload\.ts|electron-api\.d\.ts)$/,
    "packaging/electron/tsconfig.preload.json",
  ],
  [/^packaging\/electron\/build\.ts$/, "scripts/tsconfig.json"],
  [/^packaging\/electron\//, "packaging/electron/tsconfig.json"],
  [/^scripts\//, "scripts/tsconfig.json"],
];

// ESLint configs live per app; the backend lints src/ only (see its lint script).
const ESLINT: Array<[RegExp, string]> = [
  [/^apps\/frontend\//, "apps/frontend"],
  [/^apps\/node-backend\/src\//, "apps/node-backend"],
];

// Same roots as `bun run lint:deps`.
const DEPCRUISE =
  /^(apps\/frontend\/(src|scripts)\/|apps\/frontend\/vite\.config\.ts$|apps\/node-backend\/(src|scripts|tests)\/|packages\/(types|shared-utils)\/(src|tests)\/|packaging\/electron\/|scripts\/)/;

interface Result {
  name: string;
  ok: boolean;
  output: string;
}

function run(
  name: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, output: output.trim() });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ name, ok: false, output: String(error) });
    });
  });
}

function firstMatch(
  rules: Array<[RegExp, string]>,
  file: string,
): string | undefined {
  return rules.find(([pattern]) => pattern.test(file))?.[1];
}

function clip(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length <= MAX_LINES) return lines.join("\n");
  return [
    ...lines.slice(0, MAX_LINES),
    `… ${lines.length - MAX_LINES} more lines`,
  ].join("\n");
}

function relative(file: string): string {
  return path
    .relative(ROOT, path.resolve(ROOT, file))
    .split(path.sep)
    .join("/");
}

function checkable(file: string): boolean {
  return (
    !file.startsWith("..") &&
    CHECKED.test(file) &&
    !SKIPPED.some((p) => p.test(file))
  );
}

function markPath(toolUseId: string): string {
  return path.join(MARKS, toolUseId.replace(/[^\w-]/g, "_"));
}

/** PreToolUse on Bash: remember when this call started. */
function markBashStart(toolUseId: string): void {
  mkdirSync(MARKS, { recursive: true });
  writeFileSync(markPath(toolUseId), String(Date.now()));
  const now = Date.now();
  for (const name of readdirSync(MARKS)) {
    const mark = path.join(MARKS, name);
    if (now - statSync(mark).mtimeMs > STALE_MARK_MS)
      rmSync(mark, { force: true });
  }
}

/** Files git sees as modified, added or untracked, written since `since`. */
function filesChangedSince(since: number): string[] {
  let status: string;
  try {
    status = execFileSync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    return [];
  }
  const entries = status.split("\0");
  const changed: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) i++; // skip the source path
    if (!checkable(file)) continue;
    try {
      if (statSync(path.join(ROOT, file)).mtimeMs >= since) changed.push(file);
    } catch {
      // deleted: nothing to check in place
    }
  }
  return changed;
}

/** PostToolUse on Bash: the checkable files this call changed. */
function bashChangedFiles(toolUseId: string): string[] {
  const mark = markPath(toolUseId);
  let since: number;
  try {
    since = Number(readFileSync(mark, "utf8"));
  } catch {
    return []; // no start mark, so no safe baseline
  } finally {
    rmSync(mark, { force: true });
  }
  if (!Number.isFinite(since)) return [];
  return filesChangedSince(since);
}

function group(
  rules: Array<[RegExp, string]>,
  files: string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const key = firstMatch(rules, file);
    if (key === undefined) continue;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  return groups;
}

async function main(): Promise<number> {
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  const input = JSON.parse(raw) as HookInput;

  let files: string[];
  if (input.tool_name === "Bash") {
    if (input.tool_use_id === undefined) return 0;
    if (input.hook_event_name === "PreToolUse") {
      markBashStart(input.tool_use_id);
      return 0;
    }
    files = bashChangedFiles(input.tool_use_id);
    if (files.length > MAX_BASH_FILES) return 0;
  } else {
    const absolute = input.tool_input?.file_path;
    if (absolute === undefined) return 0;
    files = [relative(absolute)].filter(checkable);
  }
  if (files.length === 0) return 0;
  if (!existsSync(path.join(BIN, "tsc"))) return 0; // dependencies not installed yet

  const checks: Array<Promise<Result>> = [];
  const projects = new Set(
    files.flatMap((file) => firstMatch(PROJECTS, file) ?? []),
  );
  if (projects.size > 0) mkdirSync(CACHE, { recursive: true });
  for (const project of projects) {
    const buildInfo = path.join(
      CACHE,
      `${project.replaceAll("/", "_")}.tsbuildinfo`,
    );
    checks.push(
      run(
        `tsc -p ${project}`,
        path.join(BIN, "tsc"),
        [
          "-p",
          project,
          "--noEmit",
          "--incremental",
          "--tsBuildInfoFile",
          buildInfo,
          "--pretty",
          "false",
        ],
        ROOT,
      ),
    );
  }
  for (const [eslintDir, dirFiles] of group(ESLINT, files)) {
    checks.push(
      run(
        "eslint",
        path.join(ROOT, eslintDir, "node_modules/.bin/eslint"),
        dirFiles.map((file) => path.relative(eslintDir, file)),
        path.join(ROOT, eslintDir),
      ),
    );
  }
  const cruised = files.filter((file) => DEPCRUISE.test(file));
  if (cruised.length > 0) {
    checks.push(
      run(
        "depcruise",
        path.join(BIN, "depcruise"),
        [
          "--config",
          "config/dependency-cruiser.cjs",
          "--output-type",
          "err",
          ...cruised,
        ],
        ROOT,
      ),
    );
  }

  const failed = (await Promise.all(checks)).filter((result) => !result.ok);
  if (failed.length === 0) return 0;
  const report = failed
    .map((result) => `## ${result.name}\n${clip(result.output)}`)
    .join("\n\n");
  const via = input.tool_name === "Bash" ? " with a shell command" : "";
  process.stderr.write(
    `Checks after editing ${files.join(", ")}${via} found problems:\n\n${report}\n`,
  );
  return 2;
}

process.exit(await main());
