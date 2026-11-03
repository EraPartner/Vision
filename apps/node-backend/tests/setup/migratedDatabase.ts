/**
 * Disposable database files for suites that need a schema of their own
 * (migrator lifecycle, adoption, journals that must start empty). Each file
 * lives in the run's temporary directory and is removed by `drop()`.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../../src/database/migrate.ts";
import type { MigrateOptions, RunMigrationsResult } from "../../src/database/migrate.ts";

export interface DisposableDatabase {
  name: string;
  file: string;
  drop(): Promise<void>;
}

/** Always true: creating a database is creating a file. */
export function hasIsolatedTestDatabase(): boolean {
  return true;
}

/** A path for a new, empty database file. */
export function createEmptyDatabase(prefix: string): Promise<DisposableDatabase> {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const dir = process.env.VISION_TEST_DB_DIR ?? os.tmpdir();
  const file = path.join(dir, `${name}.sqlite3`);
  return Promise.resolve({
    name,
    file,
    drop: () => {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${file}${suffix}`, { force: true });
      return Promise.resolve();
    },
  });
}

/** Run the production migrator against `file`. */
export async function migrateDatabase(
  file: string,
  options: MigrateOptions = {},
): Promise<RunMigrationsResult> {
  return runMigrations(file, options);
}

/** Create a database file and migrate it to the current head. */
export async function createMigratedDatabase(prefix: string): Promise<DisposableDatabase> {
  const database = await createEmptyDatabase(prefix);
  try {
    await migrateDatabase(database.file, { skipBackup: true });
  } catch (err) {
    await database.drop();
    throw err;
  }
  return database;
}
