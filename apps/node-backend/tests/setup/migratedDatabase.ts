/**
 * Disposable sibling databases for suites that need a pristine schema of
 * their own (adoption, migrator lifecycle, receipt journals that must start
 * empty). Each database is created next to TEST_DATABASE_URL and dropped by
 * the returned `drop()`. Callers gate on `hasIsolatedTestDatabase()`: creating
 * databases needs CREATEDB, which only the disposable harness guarantees.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { runMigrations } from "../../src/database/migrate.ts";
import type { RunMigrationsResult } from "../../src/database/migrate.ts";
import { must } from "../helpers/must.ts";

export function hasIsolatedTestDatabase(): boolean {
  return (
    process.env.VISION_TEST_DB_ISOLATED === "1" &&
    Boolean(process.env.TEST_DATABASE_URL)
  );
}

export interface DisposableDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

async function withAdmin<T>(run: (admin: pg.Client) => Promise<T>) {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

/** Create an empty database (no schema) beside TEST_DATABASE_URL. */
export async function createEmptyDatabase(
  prefix: string,
): Promise<DisposableDatabase> {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
  const url = new URL(must(process.env.TEST_DATABASE_URL, "process.env.TEST_DATABASE_URL"));
  url.pathname = `/${name}`;
  await withAdmin((admin) =>
    admin.query(
      `CREATE DATABASE ${name} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    ),
  );
  return {
    name,
    url: url.toString(),
    drop: () =>
      withAdmin(async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }),
  };
}

/**
 * Run the production migrator against `url`. The migrator reads its target
 * from the environment, so both URLs are pointed at the scratch database for
 * the duration of the call and restored afterwards.
 */
export async function migrateDatabase(
  url: string,
): Promise<RunMigrationsResult> {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_MIGRATIONS: process.env.DATABASE_URL_MIGRATIONS,
  };
  process.env.DATABASE_URL = url;
  process.env.DATABASE_URL_MIGRATIONS = url;
  try {
    return await runMigrations();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

/** Create a database and migrate it to the current head. */
export async function createMigratedDatabase(
  prefix: string,
): Promise<DisposableDatabase> {
  const database = await createEmptyDatabase(prefix);
  try {
    await migrateDatabase(database.url);
  } catch (err) {
    await database.drop();
    throw err;
  }
  return database;
}
