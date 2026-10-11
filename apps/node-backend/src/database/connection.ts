/**
 * Database connection and pool management module.
 *
 * Uses node-postgres (pg) with a connection pool.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import settings from "../config/config.ts";
import { logger } from "../config/logger.ts";

/**
 * The slice of a pg `PoolClient` this module and its JS callers rely on. Kept
 * structural (rather than re-exporting `pg` types) because the legacy checkJs
 * program resolves `pg` through the ambient `declare module 'pg'` shim, where
 * pg's own types are `any`.
 */
export interface PgPoolClient {
  query: (
    text: string | { name: string; text: string; values?: unknown[] },
    params?: unknown[],
  ) => Promise<PgQueryResult>;
  release: (err?: Error | boolean) => void;
}

/**
 * `query<Row>(...)` is an unchecked claim about the row shape; untyped callers
 * get `unknown` rows. Prefer `queryRows`/`checkRows` (rowContracts.ts), which
 * check rows against a schema (ADR-193).
 */
export interface PgQueryResult<R = unknown> {
  rows: R[];
  rowCount: number | null;
}

export interface QueryOptions {
  retries?: number;
}

/** pg / Node errors carry a SQLSTATE or errno-style `code`. */
interface DbError {
  code?: string;
  message?: string;
}

interface TransactionStore {
  client: PgPoolClient | null;
  savepointCounter: { value: number };
  activeNested: Promise<unknown> | null;
}

// Ambient transaction context: withTransaction() runs its callback inside this
// store so module-level query() joins the transaction instead of grabbing a
// separate pool connection. Without it, a repo call inside withTransaction
// silently runs OUTSIDE the transaction — it can't see uncommitted rows and
// survives a rollback, which is exactly the partial-write bug transactions
// exist to prevent. The store is invalidated (client nulled) when the
// transaction ends so a leaked continuation can't write on a released client.
const txStorage = new AsyncLocalStorage<TransactionStore>();

/**
 * The pg client of the withTransaction() this code is running inside, or null.
 * Exposed for callers that must adapt to ambient-transaction mode (e.g. wrap a
 * catch-and-retry INSERT in a SAVEPOINT — see withSavepointIfInTransaction).
 */
function getAmbientTransactionClient(): PgPoolClient | null {
  return txStorage.getStore()?.client ?? null;
}

// pool.max should be the true ceiling for concurrent DB connections.
// settings.database.poolSize is the sustained pool size;
// settings.database.maxOverflow is kept for configuration parity but we use
// the larger of the two so burst traffic is absorbed without exhausting the DB.
const poolMax =
  Math.max(settings.database.poolSize, settings.database.maxOverflow) ||
  settings.database.poolSize ||
  10;

const pool = new pg.Pool({
  connectionString: settings.database.url,
  max: poolMax,
  idleTimeoutMillis: 60_000, // close idle connections after 60s
  connectionTimeoutMillis: 5_000, // fail fast if can't connect in 5s
  statement_timeout: 30_000, // kill queries running > 30s
  // statement_timeout does NOT fire while a session is idle *inside* a
  // transaction — if a withTransaction() callback stalls on a non-DB await
  // (hung network/stream) the lock + pool slot are held until restart, and
  // autovacuum's xmin horizon stalls (table bloat). node-postgres passes this
  // per-connection; kill any transaction left idle > 60s.
  idle_in_transaction_session_timeout: 60_000,
});

pool.on("error", (err: unknown) => {
  logger.error("Unexpected error on idle database client", err);
});

/**
 * A statement is safe to transparently retry only if it cannot have applied a
 * write before the connection dropped. A transient error (e.g. ECONNRESET) can
 * fire *after* the server committed an INSERT/UPDATE/DELETE — retrying that
 * would double-apply the write. Restrict retries to plain read statements.
 */
function isRetryableStatement(sql: string): boolean {
  return /^\s*(?:SELECT|SHOW|EXPLAIN)\b/i.test(sql);
}

/**
 * Execute a query against the database with optional retry on transient errors.
 * Retries apply to read-only statements only — see {@link isRetryableStatement}.
 * @param text - SQL query
 * @param params - Query parameters
 */
export async function query<R = unknown>(
  text: string,
  params?: readonly unknown[],
  opts: QueryOptions = {},
): Promise<PgQueryResult<R>> {
  // pg's typings require a mutable array; pg only reads the values.
  const values = params as unknown[] | undefined;
  // Inside withTransaction(): run on the transaction's client, and never
  // retry — after a connection error the transaction is dead, so a retried
  // statement would run outside it (or on a poisoned client).
  const ambient = getAmbientTransactionClient();
  if (ambient) {
    // `R` is the caller's unchecked claim, as for `pool.query` below; checked
    // callers go through rowContracts.ts.
    return (await ambient.query(text, values)) as PgQueryResult<R>;
  }

  const retries = opts.retries ?? 0;
  const maxRetries = retries > 0 && isRetryableStatement(text) ? retries : 0;
  let attempt = 0;

  while (true) {
    const start = Date.now();
    try {
      const result = await pool.query(text, values);
      const duration = Date.now() - start;
      // A >1s query is a production-relevant signal; keep it visible at the
      // default (info/warn) level instead of debug, where it was invisible in
      // prod. Plain echo tracing stays at debug.
      if (duration > 1000) {
        logger.warn(`Slow query (${duration}ms): ${text.slice(0, 100)}`);
      } else if (settings.database.echo) {
        logger.debug(`Query executed in ${duration}ms: ${text.slice(0, 100)}`);
      }
      return result;
    } catch (caught) {
      const err = caught as DbError;
      const duration = Date.now() - start;
      const isTransient =
        err.code === "ECONNRESET" ||
        err.code === "57P01" || // admin_shutdown
        err.code === "08006" || // connection_failure
        err.code === "08001" || // sqlclient_unable_to_establish_sqlconnection
        err.message?.includes("Connection terminated");

      if (isTransient && attempt < maxRetries) {
        attempt++;
        const backoff = Math.min(200 * attempt, 2000);
        logger.warn(
          `Transient DB error (attempt ${attempt}/${maxRetries}), retrying in ${backoff}ms: ${err.message}`,
        );
        // Global setTimeout, not node:timers/promises: connection.test.ts
        // drives this backoff with vi.useFakeTimers(), which cannot fake
        // timers/promises.
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      logger.error(`Query failed after ${duration}ms: ${text.slice(0, 100)}`, {
        error: err.message,
      });
      throw err;
    }
  }
}

/**
 * Execute a named prepared statement. PostgreSQL parses the plan once per
 * connection; pg passes text every call because pool connections are independent.
 *
 * @param name   - Unique statement name (stable across calls)
 * @param text   - SQL text
 * @param params - Bound parameters
 */
export async function queryPrepared(
  name: string,
  text: string,
  params?: readonly unknown[],
): Promise<PgQueryResult> {
  // pg's typings require a mutable array; pg only reads the values.
  const values = params as unknown[] | undefined;
  // Inside withTransaction(): run on the ambient client so repo methods built on
  // queryPrepared (e.g. transactionRepository.getById/create) participate in the
  // transaction instead of silently hitting the pool outside it — the same
  // partial-write class the query() reroute above closes.
  const ambient = getAmbientTransactionClient();
  if (ambient) {
    return ambient.query({ name, text, values });
  }
  return pool.query({ name, text, values });
}

/**
 * Get a client from the pool for transactions.
 * Remember to call client.release() when done.
 */
export async function getClient(): Promise<PgPoolClient> {
  return pool.connect();
}

/**
 * Run `fn` inside a database transaction.
 *
 * The outermost call acquires a pooled client, issues BEGIN, invokes
 * `fn(client)`, then COMMITs on success or ROLLBACKs on throw. A nested call
 * reuses the ambient client behind a unique savepoint, so it never opens an
 * independent transaction. The outermost call always releases the client.
 */
export async function withTransaction<T>(
  fn: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const ambientClient = getAmbientTransactionClient();
  const parentStore = txStorage.getStore();
  if (ambientClient && parentStore) {
    if (parentStore.activeNested) {
      try {
        await parentStore.activeNested;
      } catch {
        // The active scope reports its own error to its caller. This sibling
        // still rejects as an unsupported concurrent nesting attempt.
      }
      throw new Error(
        "Concurrent sibling withTransaction calls are not supported; await nested transactions sequentially",
      );
    }

    const runNested = async () => {
      parentStore.savepointCounter.value += 1;
      const savepointName = `vision_nested_tx_${parentStore.savepointCounter.value}`;
      const childStore: TransactionStore = {
        client: ambientClient,
        savepointCounter: parentStore.savepointCounter,
        activeNested: null,
      };
      try {
        return await withSavepointIfInTransaction(savepointName, () =>
          txStorage.run(childStore, () => fn(ambientClient)),
        );
      } finally {
        childStore.client = null;
      }
    };

    // pg clients execute one protocol stream. A sibling call observes this
    // active promise and rejects only after it settles, so the outer rollback
    // can never race an in-flight savepoint. Deeper nesting receives a child
    // store and remains properly lexical.
    const operation = runNested();
    parentStore.activeNested = operation;
    try {
      return await operation;
    } finally {
      if (parentStore.activeNested === operation) {
        parentStore.activeNested = null;
      }
    }
  }

  const client = await getClient();
  // The callback runs inside txStorage so module-level query() joins this
  // transaction (see getAmbientTransactionClient). fn still receives the
  // client for code that threads it explicitly — both routes hit the same
  // connection.
  const store: TransactionStore = {
    client,
    savepointCounter: { value: 0 },
    activeNested: null,
  };
  let rollbackFailed = false;
  try {
    await client.query("BEGIN");
    const result = await txStorage.run(store, () => fn(client));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.error("Transaction rollback failed", rollbackErr);
      rollbackFailed = true;
    }
    throw err;
  } finally {
    // Invalidate the ambient store: a continuation leaked out of the callback
    // (timer, un-awaited promise) must fall back to the pool, not write on a
    // released client.
    store.client = null;
    // If ROLLBACK threw, the connection's transaction state is unknown.
    // Passing a truthy arg to release() destroys the client instead of
    // returning a poisoned connection to the pool.
    client.release(rollbackFailed || undefined);
  }
}

/**
 * Run `fn` under a SAVEPOINT when inside an ambient withTransaction(), so a
 * caught failure doesn't abort the whole transaction (PostgreSQL poisons a tx
 * on ANY statement error — a catch-and-retry pattern that works on a pool
 * connection would otherwise fail with 25P02 on every statement after the
 * catch). Outside a transaction this is a plain passthrough.
 *
 * `name` must be a static identifier from the caller, never user input.
 *
 */
export async function withSavepointIfInTransaction<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = getAmbientTransactionClient();
  if (!client) return fn();
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    // If fn failed because the connection dropped, ROLLBACK TO SAVEPOINT throws
    // too; log it but rethrow the ORIGINAL error so the root cause isn't lost
    // (mirrors withTransaction's rollback handling above).
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch (rollbackErr) {
      logger.error(`ROLLBACK TO SAVEPOINT ${name} failed`, rollbackErr);
    }
    throw err;
  }
}

/**
 * Check if the database is reachable.
 */
export async function checkConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Get table count in the public schema.
 */
export async function getTableCount(): Promise<number> {
  const result = await pool.query(
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Get pool statistics for monitoring.
 */
export function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    maxConnections: poolMax,
  };
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export default pool;

export { getAmbientTransactionClient as __getAmbientTransactionClient };
