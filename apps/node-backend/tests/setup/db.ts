/**
 * Shared DB test helpers (ADR-263).
 *
 * Every test file runs against its own copy of the migrated SQLite template
 * (tests/setup/sqliteDatabase.ts), so DB-backed tests always run: there is no
 * external database to configure and nothing to skip. `getTestPool()` keeps
 * the PostgreSQL-era call shape for fixture SQL; its statements go through the
 * backend's own driver (src/database/connection.ts), so fixtures and the code
 * under test share one database, one writer and one transaction context.
 *
 * Isolation: call `resetTestDatabase()` (for example in `beforeEach`) to start
 * from the pristine migrated schema; it closes the backend's connections and
 * copies the template over this file's database.
 */
import { copyFileSync, rmSync } from "node:fs";
import {
  closePool,
  getClient,
  query,
  withTransaction,
} from "../../src/database/connection.ts";
import type { PgPoolClient } from "../../src/database/connection.ts";

/** A result row whose columns a test reads without a fixed shape. */
export type DbRow = Record<string, unknown>;

export interface TestQueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

export interface TestPool {
  query<R = DbRow>(text: string, params?: readonly unknown[]): Promise<TestQueryResult<R>>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

const pool: TestPool = {
  query: <R = DbRow>(text: string, params?: readonly unknown[]) =>
    query<R>(text, params),
  connect: () => getClient(),
  end: () => closePool(),
};

/** The test database handle. Never null: every test file has a database. */
export function getTestPool(): TestPool {
  return pool;
}

/** Close the backend's connections (they reopen on the next query). */
export async function closeTestPool(): Promise<void> {
  await closePool();
}

/** Always true; kept for suites written as `describe.skipIf(!hasTestDatabase())`. */
export function hasTestDatabase(): boolean {
  return true;
}

/** Replace this file's database with a fresh copy of the migrated template. */
export async function resetTestDatabase(): Promise<void> {
  const file = process.env.VISION_DATABASE_PATH;
  const template = process.env.VISION_TEST_DB_TEMPLATE;
  if (!file || !template) throw new Error("The SQLite test harness is not set up");
  await closePool();
  for (const suffix of ["-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  copyFileSync(template, file);
}

/**
 * Delete category fixtures from leaves toward roots. The hierarchy's
 * restrictive self-reference rejects deleting a parent that still has
 * children. Call only after other fixture tables that reference categories
 * are cleared.
 */
export async function deleteAllCategoryFixtures(
  runner: Pick<TestPool, "query"> = pool,
): Promise<void> {
  await runner.query("DELETE FROM category_merge_aliases");
  await runner.query("DELETE FROM category_root_aliases");
  let deleted: number | null;
  do {
    ({ rowCount: deleted } = await runner.query(`
      DELETE FROM categories
      WHERE NOT EXISTS (SELECT 1 FROM categories child WHERE child.parent_id = categories.id)
    `));
  } while (deleted !== null && deleted > 0);
}

/** Thrown to end inRollbackTransaction(); never escapes it. */
class RollbackSignal extends Error {}

/**
 * Run `fn` in a transaction that is always rolled back (the PostgreSQL-era
 * `BEGIN … ROLLBACK` on a dedicated client). Code under test that calls
 * `query()` or `withTransaction()` inside `fn` joins the same transaction.
 */
export async function inRollbackTransaction<T>(fn: (client: PgPoolClient) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await withTransaction(async (client) => {
      result = await fn(client);
      throw new RollbackSignal("rollback");
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
  return result as T;
}

/**
 * Expect one statement to fail with `code`, inside a savepoint so the
 * surrounding transaction stays usable.
 */
export async function expectSqlError(
  client: Pick<PgPoolClient, "query">,
  text: string,
  params: readonly unknown[],
  code: string,
): Promise<void> {
  await client.query("SAVEPOINT expected_failure");
  let failure: unknown;
  try {
    await client.query(text, [...params]);
  } catch (err) {
    failure = err;
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_failure");
  await client.query("RELEASE SAVEPOINT expected_failure");
  if (failure === undefined) throw new Error(`Expected SQLSTATE ${code}, but the statement succeeded: ${text}`);
  const actual = (failure as { code?: unknown }).code;
  if (actual !== code) {
    throw new Error(
      `Expected SQLSTATE ${code}, got ${String(actual)}: ${failure instanceof Error ? failure.message : JSON.stringify(failure)}`,
    );
  }
}

/** No-op: each test file has its own database, so suites need no serialization. */
export async function acquireDbSuiteLock(): Promise<void> {}

/** No-op counterpart of {@link acquireDbSuiteLock}. */
export async function releaseDbSuiteLock(): Promise<void> {}
