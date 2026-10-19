#!/usr/bin/env bun
/**
 * Migration CLI for the DATABASE_URL database. Delegates to
 * `src/database/migrate.ts`, the exact code the app runs on boot (ADR-222).
 *
 * Usage: DATABASE_URL=postgres://... bun run apps/node-backend/scripts/db-migrate.ts [command]
 *   (no command) | up   apply every pending migration
 *   down                revert the latest migration (needs its .down.sql)
 *   status              list migrations and when each was applied
 *   new <name>          create db/migrations/NNNN_<name>.sql
 *
 * DATABASE_URL is read from the environment; when unset, config/.env.local is
 * consulted. DATABASE_URL_MIGRATIONS, when set, is the owner role used.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "db", "migrations");

const USAGE = `Usage: db-migrate.ts [up | down | status | new <name>]
  (no command) | up   apply every pending migration
  down                revert the latest migration (needs its .down.sql)
  status              list migrations and when each was applied
  new <name>          create db/migrations/NNNN_<name>.sql
Env: DATABASE_URL (falls back to config/.env.local), DATABASE_URL_MIGRATIONS.`;

const args = process.argv.slice(2).filter((a) => a !== "--");
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const command = args[0] ?? "up";

if (command === "new") {
  const name = args[1];
  if (!name || !/^[a-z0-9_]+$/.test(name) || args.length !== 2) {
    console.error(`[db-migrate] new needs one snake_case name\n${USAGE}`);
    process.exit(1);
  }
  const numbers = readdirSync(MIGRATIONS_DIR)
    .map((file) => Number.parseInt(file.slice(0, 4), 10))
    .filter(Number.isFinite);
  const next = String(Math.max(0, ...numbers) + 1).padStart(4, "0");
  const file = path.join(MIGRATIONS_DIR, `${next}_${name}.sql`);
  writeFileSync(
    file,
    `-- ${next}_${name}\n-- Runs inside the migrator's transaction. Add ${next}_${name}.down.sql to make it reversible.\n`,
    { flag: "wx" },
  );
  console.log(`[db-migrate] created ${path.relative(REPO_ROOT, file)}`);
  process.exit(0);
}

if (!["up", "down", "status"].includes(command) || args.length > 1) {
  console.error(`[db-migrate] unknown command: ${args.join(" ")}\n${USAGE}`);
  process.exit(1);
}

// Only fills variables that are not already set. Must happen before
// connection.ts is imported: the pg pool captures DATABASE_URL at module load.
function loadConfigEnvLocal(): void {
  const envLocalPath = path.join(REPO_ROOT, "config", ".env.local");
  if (!existsSync(envLocalPath)) return;
  for (const line of readFileSync(envLocalPath, "utf8").split("\n")) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;
    if (process.env[key] !== undefined) continue;
    const quoted =
      rawValue.length >= 2 &&
      ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'")));
    process.env[key] = quoted ? rawValue.slice(1, -1) : rawValue;
  }
}

if (!process.env.DATABASE_URL) loadConfigEnvLocal();
if (!process.env.DATABASE_URL) {
  console.error(
    "[db-migrate] DATABASE_URL is not set — refusing to guess a target database.",
  );
  process.exit(1);
}

const { runMigrations, revertLatestMigration, readMigrationStatus } =
  await import("../src/database/migrate.ts");
const { closePool } = await import("../src/database/connection.ts");

let exitCode = 0;
try {
  if (command === "up") {
    const result = await runMigrations();
    console.log(
      `[db-migrate] schema is at ${result.revision}` +
        (result.applied.length ? ` (applied ${result.applied.join(", ")})` : ""),
    );
  } else if (command === "down") {
    const revision = await revertLatestMigration();
    console.log(`[db-migrate] reverted; schema is at ${revision}`);
  } else {
    for (const { name, executedAt } of await readMigrationStatus()) {
      console.log(
        `${executedAt ? executedAt.toISOString() : "pending".padEnd(24)}  ${name}`,
      );
    }
  }
} catch (error) {
  console.error(
    `[db-migrate] ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  exitCode = 1;
}
await closePool().catch(() => {});
process.exit(exitCode);
