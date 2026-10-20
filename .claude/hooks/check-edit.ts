#!/usr/bin/env bun
/**
 * PostToolUse hook: after Claude edits a TypeScript or JavaScript file, run the
 * owning TypeScript project, ESLint and dependency-cruiser on it and report
 * problems back to Claude.
 *
 * Registered with `asyncRewake` in .claude/settings.json, so it runs in the
 * background and never delays the edit. A clean result exits 0 silently; any
 * problem exits 2 with a short report on stderr, which wakes Claude with it.
 *
 * tsc runs incrementally with build info under node_modules/.cache, so after
 * the first run (or the session-start warm-up) a frontend check takes seconds.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

interface HookInput {
  tool_input?: { file_path?: string };
}

const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const CACHE = path.join(ROOT, "node_modules/.cache/claude-edit-check");
const BIN = path.join(ROOT, "node_modules/.bin");
const MAX_LINES = 40;
const TIMEOUT_MS = 180_000;

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

async function main(): Promise<number> {
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  const input = JSON.parse(raw) as HookInput;
  const absolute = input.tool_input?.file_path;
  if (absolute === undefined) return 0;
  const file = path
    .relative(ROOT, path.resolve(ROOT, absolute))
    .split(path.sep)
    .join("/");
  if (
    file.startsWith("..") ||
    !CHECKED.test(file) ||
    SKIPPED.some((p) => p.test(file))
  )
    return 0;
  if (!existsSync(path.join(BIN, "tsc"))) return 0; // dependencies not installed yet

  const checks: Array<Promise<Result>> = [];
  const project = firstMatch(PROJECTS, file);
  if (project !== undefined) {
    mkdirSync(CACHE, { recursive: true });
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
  const eslintDir = firstMatch(ESLINT, file);
  if (eslintDir !== undefined) {
    checks.push(
      run(
        "eslint",
        path.join(ROOT, eslintDir, "node_modules/.bin/eslint"),
        [path.relative(eslintDir, file)],
        path.join(ROOT, eslintDir),
      ),
    );
  }
  if (DEPCRUISE.test(file)) {
    checks.push(
      run(
        "depcruise",
        path.join(BIN, "depcruise"),
        [
          "--config",
          "config/dependency-cruiser.cjs",
          "--output-type",
          "err",
          file,
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
  process.stderr.write(
    `Checks after editing ${file} found problems:\n\n${report}\n`,
  );
  return 2;
}

process.exit(await main());
