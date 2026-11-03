/**
 * Database connection module: one SQLite file opened in-process (ADR-263).
 *
 * Two connections:
 *   - the writer runs every transaction and every statement that may change
 *     data, one at a time behind an async write lock;
 *   - the reader (PRAGMA query_only) runs plain reads outside transactions,
 *     so a long import never blocks the screens that only read. In WAL mode
 *     it sees the last committed state, as another pool connection did.
 *
 * `withTransaction()` keeps its PostgreSQL-era contract: the callback runs in
 * an AsyncLocalStorage context, so module-level `query()` (and every Kysely
 * query through db.ts) joins the transaction; a nested call becomes a
 * SAVEPOINT; a leaked continuation after the transaction ended falls back to
 * autocommit instead of writing into a finished transaction. `BEGIN
 * IMMEDIATE` plus the single writer replace PostgreSQL's row locks and
 * advisory locks.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import settings from "../config/config.ts";
import { logger } from "../config/logger.ts";
import { errorMessage } from "../lib/errors.ts";
import { registerFunctions } from "./sqlite/functions.ts";
import { registerSchemaFunctions } from "./sqlite/schemaFunctions.ts";
import type { ConnectionClock } from "./sqlite/functions.ts";
import { instantFromDate } from "./sqlite/pgTime.ts";
import { scanSql } from "./sqlite/sqlText.ts";
import { planColumn, readsBigint, toSqlParams, withBigIntInput } from "./sqlite/values.ts";
import type { ColumnPlan } from "./sqlite/values.ts";
import { translateSqliteError } from "./sqlite/errors.ts";

/** The oldest SQLite Vision's SQL is written for (macOS 13 ships 3.39.5). */
export const MINIMUM_SQLITE_VERSION = "3.39.0";

/**
 * What a query returns: rows and the number of rows a write touched (or
 * returned). Same shape as node-postgres's result for the fields Vision used.
 */
export interface PgQueryResult<R = unknown> {
  rows: R[];
  rowCount: number | null;
}

/** A handle that runs statements on one connection (a transaction's, usually). */
export interface PgPoolClient {
  /** `R` types the rows, as node-postgres's `query<R>()` did; nothing checks it at run time. */
  query: <R = Record<string, unknown>>(
    text: string | { name: string; text: string; values?: readonly unknown[] | undefined },
    params?: readonly unknown[],
  ) => Promise<PgQueryResult<R>>;
  release: (err?: Error | boolean) => void;
}

export interface QueryOptions {
  /** Kept for call compatibility; SQLite has no transient connection errors to retry. */
  retries?: number;
}

interface PreparedStatement {
  stmt: StatementSync;
  /** Column plans for statements that return rows; null for plain writes. */
  plan: ColumnPlan[] | null;
}

interface Connection {
  db: DatabaseSync;
  clock: ConnectionClock;
  statements: Map<string, PreparedStatement>;
  /** `inspect`: a read-only file handle for verification (backups, restores, scripts). */
  role: "writer" | "reader" | "snapshot" | "inspect";
}

interface TransactionStore {
  conn: Connection | null;
  savepointCounter: { value: number };
  activeNested: Promise<unknown> | null;
}

const txStorage = new AsyncLocalStorage<TransactionStore>();

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/** Pragmas every Vision connection runs with. */
function applyPragmas(db: DatabaseSync, role: Connection["role"]): void {
  if (role === "writer") db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    [
      "PRAGMA foreign_keys = ON",
      "PRAGMA synchronous = FULL",
      "PRAGMA fullfsync = ON",
      "PRAGMA checkpoint_fullfsync = ON",
      "PRAGMA busy_timeout = 10000",
      "PRAGMA recursive_triggers = OFF",
      // Vision's own schema calls its own functions from CHECK constraints
      // and triggers; a build that defaults trusted_schema to OFF would
      // refuse them.
      "PRAGMA trusted_schema = ON",
    ].join(";\n"),
  );
  if (role !== "writer") db.exec("PRAGMA query_only = ON");
}

/**
 * Open a Vision database file with the pragmas and SQL functions every
 * connection needs. Exported for the migrator, backups and scripts; the
 * backend itself uses the shared connections below.
 */
export function openDatabase(
  file: string,
  role: Connection["role"] = "writer",
  clock: ConnectionClock = { transactionStart: null, statementStart: null },
): DatabaseSync {
  if (role === "writer" && file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    readOnly: role === "inspect",
    timeout: 10_000,
  });
  try {
    const row = db.prepare("SELECT sqlite_version() AS v").get() as { v?: unknown } | undefined;
    const version = typeof row?.v === "string" ? row.v : "0";
    if (compareVersions(version, MINIMUM_SQLITE_VERSION) < 0) {
      throw new Error(
        `SQLite ${version} is too old: Vision needs ${MINIMUM_SQLITE_VERSION} or newer (macOS 13 or later).`,
      );
    }
    applyPragmas(db, role);
    registerFunctions(db, clock);
    registerSchemaFunctions(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function databaseFile(): string {
  const file = settings.database.path;
  if (!file) throw new Error("VISION_DATABASE_PATH is not set");
  return file;
}

let writer: Connection | null = null;
let reader: Connection | null = null;

function makeConnection(file: string, role: Connection["role"]): Connection {
  const clock: ConnectionClock = { transactionStart: null, statementStart: null };
  const db = openDatabase(file, role, clock);
  return { db, clock, statements: new Map(), role };
}

function getWriter(): Connection {
  writer ??= makeConnection(databaseFile(), "writer");
  return writer;
}

function getReader(): Connection {
  if (!reader) {
    getWriter(); // creates the file and switches it to WAL first
    reader = makeConnection(databaseFile(), "reader");
  }
  return reader;
}

// ---------------------------------------------------------------------------
// Unique-index names for error translation
// ---------------------------------------------------------------------------

let uniqueIndexes: Map<string, string> | null = null;

function resolveUniqueIndex(table: string, columns: readonly string[]): string | undefined {
  if (!uniqueIndexes) {
    uniqueIndexes = new Map();
    try {
      const db = getWriter().db;
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const indexes = db.prepare(`PRAGMA index_list("${name.replaceAll('"', '""')}")`).all() as Array<{
          name: string;
          unique: number;
          origin: string;
        }>;
        const tableSql =
          (db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as
            | { sql: string | null }
            | undefined)?.sql ?? "";
        const pkName = /CONSTRAINT\s+"?(\w+)"?\s+PRIMARY\s+KEY/i.exec(tableSql)?.[1] ?? `${name}_pkey`;
        for (const index of indexes) {
          if (index.unique === 0) continue;
          const cols = (
            db.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all() as Array<{ name: string | null }>
          ).map((c) => c.name ?? "<expr>");
          const key = `${name}(${cols.join(",")})`;
          // sqlite_autoindex_* names stand for a table-level UNIQUE/PRIMARY KEY.
          const auto = index.name.startsWith("sqlite_autoindex_");
          if (!uniqueIndexes.has(key) || !auto) {
            uniqueIndexes.set(key, !auto ? index.name : index.origin === "pk" ? pkName : `${name}_${cols.join("_")}_key`);
          }
        }
      }
    } catch (err) {
      logger.warn(`Could not read unique indexes: ${errorMessage(err)}`);
    }
  }
  return uniqueIndexes.get(`${table}(${columns.join(",")})`);
}

/** Forget cached schema facts after migrations or a restore. */
export function resetSchemaCaches(): void {
  uniqueIndexes = null;
  for (const conn of [writer, reader]) conn?.statements.clear();
}

// ---------------------------------------------------------------------------
// Statement execution
// ---------------------------------------------------------------------------

const STATEMENT_CACHE_LIMIT = 400;

function prepare(conn: Connection, text: string): PreparedStatement {
  let prepared = conn.statements.get(text);
  if (prepared) {
    // Refresh LRU position.
    conn.statements.delete(text);
    conn.statements.set(text, prepared);
    return prepared;
  }
  const stmt = conn.db.prepare(text);
  const columns = stmt.columns();
  stmt.setReturnArrays(true);
  let plan = columns.length > 0 ? columns.map((c) => planColumn(c.name, c.type)) : null;
  if (plan?.some((c) => readsBigint(c.read))) {
    stmt.setReadBigInts(true);
    plan = plan.map((c) => ({ ...c, read: withBigIntInput(c.read) }));
  }
  prepared = { stmt, plan };
  conn.statements.set(text, prepared);
  if (conn.statements.size > STATEMENT_CACHE_LIMIT) {
    const oldest = conn.statements.keys().next().value;
    if (oldest !== undefined) conn.statements.delete(oldest);
  }
  return prepared;
}

function rowsFromArrays(plan: ColumnPlan[], raw: unknown[]): Record<string, unknown>[] {
  const rows = new Array<Record<string, unknown>>(raw.length);
  for (let r = 0; r < raw.length; r++) {
    const values = raw[r] as unknown[];
    const row: Record<string, unknown> = {};
    for (const [c, column] of plan.entries()) {
      row[column.key] = column.read(values[c]);
    }
    rows[r] = row;
  }
  return rows;
}

// Per-statement timing, replacing pg_stat_statements for the admin page.
interface StatementStats {
  calls: number;
  totalMs: number;
  maxMs: number;
  rows: number;
}
const statementStats = new Map<string, StatementStats>();
const STATS_LIMIT = 1000;

function recordTiming(text: string, ms: number, rows: number): void {
  const key = text.replace(/\s+/g, " ").trim().slice(0, 500);
  let stats = statementStats.get(key);
  if (!stats) {
    if (statementStats.size >= STATS_LIMIT) {
      let victim: string | undefined;
      let fewest = Infinity;
      for (const [k, v] of statementStats) {
        if (v.calls < fewest) {
          fewest = v.calls;
          victim = k;
        }
      }
      if (victim !== undefined) statementStats.delete(victim);
    }
    stats = { calls: 0, totalMs: 0, maxMs: 0, rows: 0 };
    statementStats.set(key, stats);
  }
  stats.calls += 1;
  stats.totalMs += ms;
  stats.maxMs = Math.max(stats.maxMs, ms);
  stats.rows += rows;
}

/** Statement timings since the backend started, slowest total first. */
export function getStatementStats(limit = 50): Array<{ query: string } & StatementStats> {
  return [...statementStats.entries()]
    .map(([query, s]) => ({ query, ...s }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit);
}

export function resetStatementStats(): void {
  statementStats.clear();
}

/** Run one statement on a connection, synchronously. */
function execute<R>(conn: Connection, sqlText: string, params: readonly unknown[] | undefined): PgQueryResult<R> {
  const scanned = scanSql(sqlText);
  const bound = toSqlParams(params);
  const started = performance.now();
  const inTransaction = conn.clock.transactionStart !== null;
  if (!inTransaction) conn.clock.statementStart = instantFromDate(new Date());
  try {
    if (scanned.multipleStatements) {
      if (bound.length > 0) throw new Error("Parameters cannot be bound to multi-statement SQL");
      conn.db.exec(scanned.text);
      return { rows: [], rowCount: null };
    }
    const prepared = prepare(conn, scanned.text);
    if (prepared.plan) {
      const raw = prepared.stmt.all(...bound) as unknown[];
      const rows = rowsFromArrays(prepared.plan, raw) as R[];
      return { rows, rowCount: rows.length };
    }
    const info = prepared.stmt.run(...bound);
    return { rows: [], rowCount: Number(info.changes) };
  } catch (err) {
    const translated = translateSqliteError(err, resolveUniqueIndex);
    logger.error(`Query failed: ${scanned.text.slice(0, 200)}`, { error: errorMessage(translated) });
    throw translated;
  } finally {
    if (!inTransaction) conn.clock.statementStart = null;
    const ms = performance.now() - started;
    recordTiming(scanned.text, ms, 0);
    if (ms > 1000) {
      logger.warn(`Slow query (${Math.round(ms)}ms): ${scanned.text.slice(0, 100)}`);
    } else if (settings.database.echo) {
      logger.debug(`Query executed in ${ms.toFixed(1)}ms: ${scanned.text.slice(0, 100)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Write lock
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = settings.database.lockTimeoutMs;
const LONG_TRANSACTION_MS = 60_000;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

class WriteLock {
  private held = false;
  private heldSince = 0;
  private readonly queue: Waiter[] = [];

  async acquire(): Promise<() => void> {
    if (!this.held) {
      this.held = true;
      this.heldSince = Date.now();
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null };
      if (LOCK_TIMEOUT_MS > 0) {
        waiter.timer = setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          const heldFor = Date.now() - this.heldSince;
          const err = new Error(
            `Timed out after ${LOCK_TIMEOUT_MS} ms waiting for the database write lock (held for ${heldFor} ms). ` +
              "A transaction may be waiting on work that itself needs the database outside the transaction.",
          ) as Error & { code: string };
          err.code = "55P03";
          reject(err);
        }, LOCK_TIMEOUT_MS);
        waiter.timer.unref();
      }
      this.queue.push(waiter);
    });
    this.heldSince = Date.now();
    return () => this.release();
  }

  private release(): void {
    const heldFor = Date.now() - this.heldSince;
    if (heldFor > LONG_TRANSACTION_MS) {
      logger.warn(`Database write lock was held for ${heldFor} ms`);
    }
    const next = this.queue.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
    } else {
      this.held = false;
    }
  }

  stats() {
    return { held: this.held, waiting: this.queue.length };
  }
}

const writeLock = new WriteLock();

function ambientStore(): TransactionStore | undefined {
  const store = txStorage.getStore();
  return store?.conn ? store : undefined;
}

/**
 * The top-level transaction (or snapshot) each client belongs to. A nested
 * withTransaction() shares its parent's savepoint counter, so that object
 * names the outermost transaction.
 */
const clientTransactions = new WeakMap<PgPoolClient, object>();

/**
 * Whether two clients run in the same top-level transaction: a SAVEPOINT
 * scope's client and its parent's client do, two separate transactions or
 * snapshots do not (PostgreSQL code compared pooled clients by identity).
 */
export function sameTransaction(a: PgPoolClient, b: PgPoolClient): boolean {
  if (a === b) return true;
  const transaction = clientTransactions.get(a);
  return transaction !== undefined && transaction === clientTransactions.get(b);
}

/** A client bound to one connection; used for transactions and snapshots. */
function clientFor(store: TransactionStore): PgPoolClient {
  const client: PgPoolClient = {
    query<R>(
      text: string | { name: string; text: string; values?: readonly unknown[] | undefined },
      params?: readonly unknown[],
    ) {
      const conn = store.conn;
      if (!conn) return Promise.reject(new Error("This transaction has already ended"));
      const sqlText = typeof text === "string" ? text : text.text;
      const values = typeof text === "string" ? params : (text.values ?? params);
      try {
        return Promise.resolve(execute<R>(conn, sqlText, values));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
    release() {},
  };
  clientTransactions.set(client, store.savepointCounter);
  return client;
}

/**
 * The transaction client of the withTransaction() this code runs inside,
 * or null. Exported for callers that adapt to ambient-transaction mode.
 */
function getAmbientTransactionClient(): PgPoolClient | null {
  const store = ambientStore();
  return store ? clientFor(store) : null;
}

/**
 * Execute a statement. Inside withTransaction() it joins the transaction;
 * otherwise reads use the reader and writes take the write lock.
 */
export async function query<R = unknown>(
  text: string,
  params?: readonly unknown[],
  _opts: QueryOptions = {},
): Promise<PgQueryResult<R>> {
  const store = ambientStore();
  if (store?.conn) return execute<R>(store.conn, text, params);
  const scanned = scanSql(text);
  if (scanned.readOnly) return execute<R>(getReader(), text, params);
  const release = await writeLock.acquire();
  try {
    return execute<R>(getWriter(), text, params);
  } finally {
    release();
  }
}

/** Kept for call compatibility: SQLite statements are cached by text already. */
export async function queryPrepared(
  _name: string,
  text: string,
  params?: readonly unknown[],
): Promise<PgQueryResult> {
  return query(text, params);
}

/**
 * Run `fn` inside a transaction. The outermost call takes the write lock and
 * runs BEGIN IMMEDIATE; a nested call runs under a SAVEPOINT on the same
 * connection. COMMIT on success, ROLLBACK on throw.
 */
export async function withTransaction<T>(fn: (client: PgPoolClient) => Promise<T>): Promise<T> {
  const parentStore = ambientStore();
  if (parentStore?.conn) {
    if (parentStore.activeNested) {
      try {
        await parentStore.activeNested;
      } catch {
        // The active scope reports its own error to its caller.
      }
      throw new Error(
        "Concurrent sibling withTransaction calls are not supported; await nested transactions sequentially",
      );
    }
    const conn = parentStore.conn;
    const runNested = async () => {
      parentStore.savepointCounter.value += 1;
      const name = `vision_nested_tx_${parentStore.savepointCounter.value}`;
      const childStore: TransactionStore = {
        conn,
        savepointCounter: parentStore.savepointCounter,
        activeNested: null,
      };
      try {
        return await withSavepointIfInTransaction(name, () =>
          txStorage.run(childStore, () => fn(clientFor(childStore))),
        );
      } finally {
        childStore.conn = null;
      }
    };
    const operation = runNested();
    parentStore.activeNested = operation;
    try {
      return await operation;
    } finally {
      if (parentStore.activeNested === operation) parentStore.activeNested = null;
    }
  }

  const release = await writeLock.acquire();
  const conn = getWriter();
  const store: TransactionStore = { conn, savepointCounter: { value: 0 }, activeNested: null };
  try {
    conn.db.exec("BEGIN IMMEDIATE");
    conn.clock.transactionStart = instantFromDate(new Date());
    try {
      const result = await txStorage.run(store, () => fn(clientFor(store)));
      conn.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        if (conn.db.isTransaction) conn.db.exec("ROLLBACK");
      } catch (rollbackErr) {
        logger.error("Transaction rollback failed", rollbackErr);
      }
      throw err;
    }
  } finally {
    conn.clock.transactionStart = null;
    // A continuation leaked out of the callback must not write into a
    // finished transaction.
    store.conn = null;
    release();
  }
}

/**
 * Run `fn` under a SAVEPOINT when inside withTransaction(), so a caught
 * failure rolls back only its own statements. Outside a transaction this is
 * a plain passthrough. `name` must be a static identifier.
 */
export async function withSavepointIfInTransaction<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const store = ambientStore();
  if (!store?.conn) return fn();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe savepoint name: ${name}`);
  const conn = store.conn;
  conn.db.exec(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    conn.db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    try {
      conn.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      conn.db.exec(`RELEASE SAVEPOINT ${name}`);
    } catch (rollbackErr) {
      logger.error(`ROLLBACK TO SAVEPOINT ${name} failed`, rollbackErr);
    }
    throw err;
  }
}

/**
 * Run `fn` against one consistent snapshot of committed data: a separate
 * read-only connection holds a read transaction for the duration, so every
 * query inside sees the same state (PostgreSQL's REPEATABLE READ READ ONLY).
 */
export async function withReadSnapshot<T>(fn: (client: PgPoolClient) => Promise<T>): Promise<T> {
  getWriter();
  const conn = makeConnection(databaseFile(), "snapshot");
  const store: TransactionStore = { conn, savepointCounter: { value: 0 }, activeNested: null };
  try {
    conn.db.exec("BEGIN");
    // A read transaction starts at its first read; take it now.
    conn.db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
    conn.clock.transactionStart = instantFromDate(new Date());
    return await txStorage.run(store, () => fn(clientFor(store)));
  } finally {
    store.conn = null;
    try {
      if (conn.db.isTransaction) conn.db.exec("COMMIT");
    } finally {
      conn.db.close();
    }
  }
}

/** A client for code that runs a sequence of statements; prefer withTransaction(). */
export function getClient(): Promise<PgPoolClient> {
  return Promise.resolve({
    query: (text, params) =>
      typeof text === "string" ? query(text, params) : query(text.text, text.values ?? params),
    release() {},
  });
}

export function checkConnection(): Promise<boolean> {
  try {
    execute(getReader(), "SELECT 1", []);
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

/** Number of application tables. */
export function getTableCount(): Promise<number> {
  try {
    const result = execute<{ count: number }>(
      getReader(),
      "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      [],
    );
    return Promise.resolve(result.rows[0]?.count ?? 0);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Lock statistics in the shape the health endpoint reported for the pool. */
export function getPoolStats() {
  const lock = writeLock.stats();
  return {
    totalCount: (writer ? 1 : 0) + (reader ? 1 : 0),
    idleCount: lock.held ? 0 : 1,
    waitingCount: lock.waiting,
    maxConnections: 2,
  };
}

/** Checkpoint the WAL and close both connections. */
export async function closePool(): Promise<void> {
  const release = await writeLock.acquire();
  try {
    if (reader) {
      reader.db.close();
      reader = null;
    }
    if (writer) {
      try {
        writer.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (err) {
        logger.warn(`WAL checkpoint at close failed: ${errorMessage(err)}`);
      }
      writer.db.close();
      writer = null;
    }
    resetSchemaCaches();
  } finally {
    release();
  }
}

/**
 * Run `fn` with exclusive use of the writer outside any transaction (for
 * VACUUM, checkpoints and file swaps). Waits for running transactions.
 */
export async function withExclusiveWriter<T>(fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  const release = await writeLock.acquire();
  try {
    return await fn(getWriter().db);
  } finally {
    release();
  }
}

const pool = { query, connect: getClient, end: closePool };
export default pool;

export { getAmbientTransactionClient as __getAmbientTransactionClient };
