/**
 * Database connection and pool management module.
 *
 * Uses node-postgres (pg) with a connection pool.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import settings from "../config/config.js";
import { logger } from "../config/logger.js";

/// <reference path="../types/thirdPartyModules.d.ts" />

/**
 * Structural stand-in for `pg`'s `PoolClient`, scoped to what this module
 * calls on it. `pg` ships no type declarations and `@types/pg` is not a
 * workspace dependency; unlike the type-only `pg` references elsewhere (see
 * `QueryRunner` in types/rows.js), this file imports `pg` as a VALUE
 * (`new pg.Pool(...)`), so the ambient `declare module 'pg'` in
 * thirdPartyModules.d.ts (multer precedent) is also needed to silence TS7016
 * on the import itself — which makes the `pg` namespace `any`, so these local
 * typedefs are what keep client/result shapes precise at the JSDoc call sites
 * below.
 * @typedef {object} PgPoolClient
 * @property {(text: string | { name: string, text: string, values?: any[] }, params?: any[]) => Promise<PgQueryResult>} query
 * @property {(err?: any) => void} release
 */

/**
 * `rows` is deliberately `any` rather than `any[]`: a declared array type
 * makes `.map()`/`.forEach()` at call sites apply real generic inference to
 * the callback, which surfaces latent shape mismatches in already-ratcheted
 * consumer files this slice is not scoped to touch. `any` preserves the
 * pre-annotation behavior (an unresolved `pg.QueryResult` reference was
 * already implicitly `any` end-to-end) while still being an explicit, not
 * implicit, `any` for noImplicitAny purposes.
 * @typedef {object} PgQueryResult
 * @property {any} rows
 * @property {number|null} rowCount
 */

// Ambient transaction context: withTransaction() runs its callback inside this
// store so module-level query() joins the transaction instead of grabbing a
// separate pool connection. Without it, a repo call inside withTransaction
// silently runs OUTSIDE the transaction — it can't see uncommitted rows and
// survives a rollback, which is exactly the partial-write bug transactions
// exist to prevent. The store is invalidated (client nulled) when the
// transaction ends so a leaked continuation can't write on a released client.
const txStorage = new AsyncLocalStorage();

/**
 * The pg client of the withTransaction() this code is running inside, or null.
 * Exposed for callers that must adapt to ambient-transaction mode (e.g. wrap a
 * catch-and-retry INSERT in a SAVEPOINT — see withSavepointIfInTransaction).
 * @returns {PgPoolClient|null}
 */
export function getAmbientTransactionClient() {
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

pool.on("error", (/** @type {unknown} */ err) => {
  logger.error("Unexpected error on idle database client", err);
});

/**
 * A statement is safe to transparently retry only if it cannot have applied a
 * write before the connection dropped. A transient error (e.g. ECONNRESET) can
 * fire *after* the server committed an INSERT/UPDATE/DELETE — retrying that
 * would double-apply the write. Restrict retries to plain read statements.
 *
 * @param {string} sql
 * @returns {boolean}
 */
function isRetryableStatement(sql) {
  return /^\s*(?:SELECT|SHOW|EXPLAIN)\b/i.test(sql);
}

/**
 * Execute a query against the database with optional retry on transient errors.
 * Retries apply to read-only statements only — see {@link isRetryableStatement}.
 * @param {string} text - SQL query
 * @param {any[]} [params] - Query parameters
 * @param {{ retries?: number }} [opts]
 * @returns {Promise<PgQueryResult>}
 */
export async function query(text, params, opts = {}) {
  // Inside withTransaction(): run on the transaction's client, and never
  // retry — after a connection error the transaction is dead, so a retried
  // statement would run outside it (or on a poisoned client).
  const ambient = getAmbientTransactionClient();
  if (ambient) {
    return ambient.query(text, params);
  }

  const maxRetries =
    (opts.retries ?? 0) > 0 && isRetryableStatement(text) ? opts.retries : 0;
  let attempt = 0;

  while (true) {
    const start = Date.now();
    try {
      const result = await pool.query(text, params);
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
    } catch (err) {
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
        // Global setTimeout, not node:timers/promises: connection.test.js
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
 * @param {string} name      - Unique statement name (stable across calls)
 * @param {string} text      - SQL text
 * @param {any[]}  [values]  - Bound parameters
 * @returns {Promise<PgQueryResult>}
 */
export async function queryPrepared(name, text, values) {
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
 * @returns {Promise<PgPoolClient>}
 */
export async function getClient() {
  return pool.connect();
}

/**
 * Run `fn` inside a database transaction.
 *
 * The outermost call acquires a pooled client, issues BEGIN, invokes
 * `fn(client)`, then COMMITs on success or ROLLBACKs on throw. A nested call
 * reuses the ambient client behind a unique savepoint, so it never opens an
 * independent transaction. The outermost call always releases the client.
 *
 * @template T
 * @param {(client: PgPoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const ambientClient = getAmbientTransactionClient();
  if (ambientClient) {
    const parentStore = txStorage.getStore();
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
      const childStore = {
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
  const store = {
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
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSavepointIfInTransaction(name, fn) {
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
 * @returns {Promise<boolean>}
 */
export async function checkConnection() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Get table count in the public schema.
 * @returns {Promise<number>}
 */
export async function getTableCount() {
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

export async function closePool() {
  await pool.end();
}

export default pool;
