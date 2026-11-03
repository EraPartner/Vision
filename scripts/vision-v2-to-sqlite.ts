#!/usr/bin/env bun
/**
 * Vision 2.0.0 -> SQLite transition (ADR-263): converts a Vision 2.0
 * backup (.visionbak / .visionbak.enc, PostgreSQL dump inside) into Vision's
 * SQLite database, verifies every value, and installs it.
 *
 *   bun run transition:v2 -- <backup file> [--dry-run] [--to-backup <file>] [--user-data <dir>] ...
 *   bun scripts/vision-v2-to-sqlite.ts --help
 *
 * The library lives in apps/node-backend/scripts/transition/. This entry
 * prepares the environment before the backend modules load: no .env files
 * (the transition needs no secrets or database settings), no log noise
 * unless --verbose, and a placeholder VISION_DATABASE_PATH so the backend's
 * config accepts the run (the transition opens only the files it creates).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
process.env.VISION_SKIP_DOTENV = "1";
if (!argv.includes("--verbose")) process.env.ENABLE_LOGGING = "false";
process.env.VISION_DATABASE_PATH ??= path.join(os.tmpdir(), "vision-transition-unused.sqlite3");

const { main } = await import("../apps/node-backend/scripts/transition/cli.ts");

let workDir: string | null = null;
const removeWorkDir = (): void => {
  if (workDir !== null) fs.rmSync(workDir, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    removeWorkDir();
    process.stderr.write(`\nInterrupted (${signal}). Nothing was installed unless the run said so.\n`);
    process.exit(1);
  });
}

const { exitCode } = await main(argv, {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  interactive: process.stdin.isTTY,
  onWorkDir: (dir) => {
    workDir = dir;
  },
});
process.exitCode = exitCode;
