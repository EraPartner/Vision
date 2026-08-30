#!/usr/bin/env bun
/**
 * Standalone migration CLI for the DATABASE_URL database.
 *
 * This deliberately delegates to `src/database/migrate.js` (the exact code the
 * app runs on boot) rather than shelling out to bare alembic, because a plain
 * alembic invocation CANNOT safely write the version table in this repo:
 * alembic auto-creates `alembic_version.version_num` as VARCHAR(32), and the
 * chain's revision identifiers are longer than that (e.g.
 * `0003_import_batch_id_on_transactions` is 36 chars), so a fresh database
 * dies on the third revision with `value too long for type character
 * varying(32)`. `runMigrations()` preflights that table at VARCHAR(64) via
 * `stampBaselineIfLegacy()` first, which is why the app boots fine and a bare
 * `alembic upgrade head` does not. `downgrade`/`stamp`/`reset` run the same
 * preflight before their alembic command for the same reason.
 *
 * Used by CI ("Test (Backend)" migrates its Postgres service with this), by
 * scripts/with-test-db.sh for local real-DB runs, and by the root/back-end
 * `db:migrate`/`db:upgrade`/`db:downgrade`/`db:stamp`/`db:reset` npm scripts.
 * Requires the Python alembic toolchain (config/requirements.txt): resolution
 * order is $ALEMBIC_BIN, an Alembic beside $VISION_PYTHON_BIN, the native-build
 * venv, the prepared standalone native runtime, a usable repo venv, then PATH.
 *
 * Usage: DATABASE_URL=postgres://... bun run apps/node-backend/scripts/db-migrate.js [command]
 *   (no command)         upgrade to head
 *   upgrade [target]     alembic upgrade (default target: head)
 *   downgrade [target]   alembic downgrade (default target: -1)
 *   stamp [target]       alembic stamp (default target: head)
 *   reset                alembic downgrade base, then upgrade to head
 *
 * DATABASE_URL is read from the environment; when unset, config/.env.local is
 * consulted (mirrors alembic/env.py, and covers workspace cwds where bun's own
 * .env.local auto-load does not see the repo-root file).
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const USAGE = `Usage: db-migrate.js [upgrade [target] | downgrade [target] | stamp [target] | reset]
  (no command)         upgrade to head
  upgrade [target]     alembic upgrade (default target: head)
  downgrade [target]   alembic downgrade (default target: -1)
  stamp [target]       alembic stamp (default target: head)
  reset                alembic downgrade base, then upgrade to head
All commands run the boot-path VARCHAR(64) preflight on alembic_version first.
Env: DATABASE_URL (required; falls back to config/.env.local), ALEMBIC_BIN, ALEMBIC_CONFIG.`;

const rawArgs = process.argv.slice(2).filter((a) => a !== "--");

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const command = rawArgs[0] ?? "upgrade";
const target = rawArgs[1];

if (!["upgrade", "downgrade", "stamp", "reset"].includes(command)) {
  console.error(`[db-migrate] unknown command: ${command}\n${USAGE}`);
  process.exit(1);
}
if (command === "reset" && target !== undefined) {
  console.error(`[db-migrate] reset takes no target\n${USAGE}`);
  process.exit(1);
}

// Resolve only a runnable Alembic. A repository venv can have an executable
// script whose shebang points into an old container; existsSync() alone then
// selects it and fails later with ENOENT. Must happen before migrate.js is
// imported because it captures ALEMBIC_BIN at module load.
if (!process.env.ALEMBIC_BIN) {
  const candidates = [];
  if (process.env.VISION_PYTHON_BIN) {
    candidates.push(
      path.join(path.dirname(process.env.VISION_PYTHON_BIN), "alembic"),
    );
  }
  candidates.push(
    path.join(REPO_ROOT, ".venv-native-build", "bin", "alembic"),
    path.join(
      REPO_ROOT,
      "packaging",
      "electron",
      "native-runtime",
      "vision-alembic",
    ),
    path.join(REPO_ROOT, "venv", "bin", "alembic"),
  );

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) {
      process.env.ALEMBIC_BIN = candidate;
      break;
    }
  }
}

// Parity with alembic/env.py, which loads config/.env.local when present, so
// `bun run db:upgrade` keeps working for operators who only configured that
// file. Only fills variables that are not already set; never overrides the
// environment. Must happen before connection.js is imported — the pg pool
// captures DATABASE_URL at module load.
function loadConfigEnvLocal() {
  const envLocalPath = path.join(REPO_ROOT, "config", ".env.local");
  if (!existsSync(envLocalPath)) return;
  for (const line of readFileSync(envLocalPath, "utf8").split("\n")) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value =
      (rawValue.startsWith('"') &&
        rawValue.endsWith('"') &&
        rawValue.length >= 2) ||
      (rawValue.startsWith("'") &&
        rawValue.endsWith("'") &&
        rawValue.length >= 2)
        ? rawValue.slice(1, -1)
        : rawValue;
    process.env[key] = value;
  }
}

if (!process.env.DATABASE_URL) {
  loadConfigEnvLocal();
}

if (!process.env.DATABASE_URL) {
  console.error(
    "[db-migrate] DATABASE_URL is not set — refusing to guess a target database.",
  );
  process.exit(1);
}

const { runMigrations, runAlembicCommand } =
  await import("../src/database/migrate.js");
const { closePool } = await import("../src/database/connection.js");

try {
  if (command === "upgrade") {
    await runMigrations(target === undefined ? {} : { target });
    console.log(`[db-migrate] schema is at ${target ?? "head"}`);
  } else if (command === "downgrade") {
    await runAlembicCommand(["downgrade", target ?? "-1"]);
    console.log(`[db-migrate] downgraded to ${target ?? "-1"}`);
  } else if (command === "stamp") {
    await runAlembicCommand(["stamp", target ?? "head"]);
    console.log(`[db-migrate] stamped at ${target ?? "head"}`);
  } else {
    await runAlembicCommand(["downgrade", "base"]);
    await runMigrations();
    console.log("[db-migrate] reset: schema rebuilt to head");
  }
} catch (error) {
  console.error(`[db-migrate] ${command} failed: ${error.message}`);
  await closePool().catch(() => {});
  process.exit(1);
}

await closePool().catch(() => {});
process.exit(0);
