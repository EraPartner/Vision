/**
 * Global setup: build one migrated SQLite template database per test run
 * (ADR-263). Every test file gets its own copy (tests/setup/sqliteDatabase.ts),
 * so DB-backed suites run in parallel without sharing state and no test needs
 * an external database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export default async function setup(): Promise<() => void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vision-tests-"));
  const template = path.join(dir, "template.sqlite3");
  process.env.VISION_TEST_DB_DIR = dir;
  process.env.VISION_TEST_DB_TEMPLATE = template;
  const { runMigrations } = await import("../../src/database/migrate.ts");
  await runMigrations(template, { skipBackup: true });
  // One file without a WAL beside it, so a byte copy is a complete database.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(template);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  db.close();
  return () => {
    if (process.env.VISION_TEST_DB_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
  };
}
