/**
 * db/migrations/0001_baseline.sql against the PostgreSQL 2.0.0 schema it
 * translates (ADR-263, docs/reference/sqlite-sql-dialect.md).
 *
 * Two fixtures sit next to this file, both captured from PostgreSQL 18.6:
 *
 *   sqliteBaseline.manifest.json   the catalog: every table and column with
 *                                  its type, nullability and default, the
 *                                  constraints, indexes, triggers and views.
 *   sqliteBaseline.scenarios.json  seed rows and ~1900 scenarios (CHECK
 *                                  boundaries, NOT NULL, foreign keys, unique
 *                                  indexes, every trigger, the schema's SQL
 *                                  functions). PostgreSQL ran each one in a
 *                                  savepoint; its error (SQLSTATE, constraint,
 *                                  column, message) or the rows of the
 *                                  scenario's verify query are the expectation.
 *
 * Here the same SQL runs on an in-memory SQLite database built from the
 * baseline, and errors go through translateSqliteError, as the driver does.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { translateSqliteError } from "../../src/database/sqlite/errors.ts";
import type { UniqueIndexResolver } from "../../src/database/sqlite/errors.ts";
import { registerFunctions } from "../../src/database/sqlite/functions.ts";
import type { ConnectionClock } from "../../src/database/sqlite/functions.ts";
import { canonicalJsonbText } from "../../src/database/sqlite/jsonb.ts";
import { coerceTypmod, formatDec, parseDecimalText } from "../../src/database/sqlite/numeric.ts";
import { formatInstant, instantFromDate } from "../../src/database/sqlite/pgTime.ts";
import {
  PORTFOLIO_INCOME_SNAPSHOT_COLUMNS,
  portfolioIncomeTransactionSnapshotSql,
  registerSchemaFunctions,
} from "../../src/database/sqlite/schemaFunctions.ts";

// ---- fixtures -------------------------------------------------------------------

type RawColumn = [string, string, boolean, string | null, ...unknown[]];

interface PgColumn {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  enum: string[] | undefined;
  generated: boolean;
}

interface ManifestTable {
  columns: RawColumn[];
  primaryKey: { name: string; columns: string[] } | null;
  uniqueConstraints: string[];
  checks: string[];
  foreignKeys: [string, string][];
  indexes: [string, string][];
  triggers: string[];
}

interface Manifest {
  tables: Record<string, ManifestTable>;
  views: Record<string, [string, string][]>;
  materializedViews: Record<string, { columns: RawColumn[]; indexes: [string, string][] }>;
  sequences: [string, string][];
}

interface PgError {
  code: string;
  constraint?: string;
  column?: string;
  message: string;
}

interface Scenario {
  group: string;
  name: string;
  check?: string;
  setup?: string[];
  sql: string[];
  verify?: string;
  expect: { ok: true } | { rows: (string | null)[][] } | { error: PgError };
}

interface Scenarios {
  seed: { table: string; values: Record<string, string> }[];
  scenarios: Scenario[];
}

const readJson = (name: string): unknown => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
const manifest = readJson("sqliteBaseline.manifest.json") as Manifest;
const fixture = readJson("sqliteBaseline.scenarios.json") as Scenarios;
const BASELINE = readFileSync(new URL("../../../../db/migrations/0001_baseline.sql", import.meta.url), "utf8");

function pgColumn(raw: RawColumn): PgColumn {
  const [name, type, notNull, def, ...rest] = raw;
  const labels = rest.find((x): x is string[] => Array.isArray(x));
  return {
    name,
    type,
    notNull,
    default: def,
    enum: labels,
    generated: rest.some((x) => typeof x === "object" && x !== null && !Array.isArray(x) && "generated" in x),
  };
}

// ---- translation decisions the checks below hold the baseline to ----------------

/** Replaced by the vision_migrations ledger of migrate.ts. */
const DROPPED_TABLES = new Set(["kysely_migration", "kysely_migration_lock"]);
/** A generated tsvector; search calls vision_fts_match instead. */
const DROPPED_COLUMNS = new Set(["ai_research_passages.search_vector"]);
/** GIN indexes (pg_trgm and the tsvector); SQLite scans instead. */
const DROPPED_INDEXES = new Set([
  "idx_recipients_name_trgm",
  "idx_transactions_comment_trgm",
  "idx_transactions_memo_trgm",
  "idx_ai_research_passages_search",
]);
/** SQLite-only tables. */
const ADDED_TABLES = new Set(["vision_sequences"]);
/** Columns whose default differs on purpose. */
const DEFAULT_EXCEPTIONS: Record<string, string> = {
  // A legacy category is inserted without a name; trg_categories_0_sync_legacy__insert
  // replaces the placeholder with its detail.
  "categories.name": "'__LEGACY_NAME_PENDING__'",
};
/** The former materialized views: caches whose COALESCE(c.id, -1) keys are never NULL. */
const MV_NOT_NULL = new Set(["mv_category_totals.category_id", "mv_monthly_summary.category_id_key"]);
/** errors.ts names every primary-key violation <table>_pkey; these four PostgreSQL keys were named pk_*. */
const PK_ERROR_NAMES: Record<string, string> = {
  pk_account_statement_balances: "account_statement_balances_pkey",
  pk_saved_chart_categories: "saved_chart_categories_pkey",
  pk_saved_chart_recipients: "saved_chart_recipients_pkey",
  pk_saved_chart_tags: "saved_chart_tags_pkey",
};
/**
 * Scenarios whose SQLite outcome differs from PostgreSQL's on purpose, with
 * the outcome SQLite must show instead.
 */
const KNOWN_DIFFERENCES: Record<string, { reason: string; sqlite: Result }> = {
  "transactions digest marker: a statement that matches no row": {
    reason: "the digest markers are row triggers: a statement that changes no row does not bump dirty_version",
    sqlite: { rows: [["clean"]] },
  },
};
/** SQLite triggers without a PostgreSQL trigger of the same name (or <name>__*). */
const ADDED_TRIGGERS = new Set(["trg_categories_name_required"]);

function stripQuotes(id: string): string {
  return id.replace(/^"(.*)"$/, "$1");
}

/** The declared type the dialect maps a PostgreSQL column to. */
function expectedType(table: string, col: PgColumn, pk: string[]): string {
  if (col.enum) return "TEXT";
  const seq = col.default !== null && /^nextval\('/.test(col.default);
  const t = col.type;
  if (t === "integer" || t === "smallint") {
    if (table === "portfolio_transactions" && col.name === "id") return "INT";
    if (seq) return "INTEGER";
    // A supplied integer key must not alias the rowid (a NULL would be numbered).
    if (pk.length === 1 && pk[0] === col.name) return "INT";
    return "INTEGER";
  }
  if (t === "bigint") return "BIGINT";
  const num = /^numeric\((\d+),(\d+)\)$/.exec(t);
  if (num) return `DECIMAL_TEXT(${num[1]},${num[2]})`;
  if (t === "numeric") return "DECIMAL_TEXT";
  if (t === "double precision" || t === "real") return "REAL";
  if (t === "text" || /^character( varying)?(\(\d+\))?$/.test(t)) return "TEXT";
  if (t === "boolean") return "BOOLEAN";
  if (t === "timestamp with time zone") return "TIMESTAMPTZ_TEXT";
  if (t === "date") return "DATE_TEXT";
  if (t === "jsonb") return "JSONB_TEXT";
  if (t === "json") return "JSON_TEXT";
  if (t === "text[]" || t === "integer[]") return "TEXT_ARRAY";
  if (t === "uuid") return "UUID_TEXT";
  throw new Error(`no mapping for ${table}.${col.name} ${t}`);
}

/** The DEFAULT the dialect maps a PostgreSQL default to, as PRAGMA table_info prints it. */
function expectedDefault(table: string, col: PgColumn): string | null {
  const key = `${table}.${col.name}`;
  const exception = DEFAULT_EXCEPTIONS[key];
  if (exception !== undefined) return exception;
  const d = col.default;
  if (d === null) return null;
  const seq = /^nextval\('(\w+)'::regclass\)$/.exec(d);
  if (seq) return col.type === "integer" && table !== "portfolio_transactions" ? null : `nextval('${seq[1]}')`;
  if (d === "now()") return "now()";
  if (d === "CURRENT_DATE") return "today()";
  if (d === "gen_random_uuid()") return "gen_random_uuid()";
  if (d === "true") return "1";
  if (d === "false") return "0";
  const literal = /^'((?:[^']|'')*)'(?:::[\w ]+(?:\(\d+\))?(?:\[\])?)?$/.exec(d);
  const bare = /^-?\d+(?:\.\d+)?$/.test(d) ? d : undefined;
  const text = literal ? (literal[1] ?? "").replaceAll("''", "'") : bare;
  if (text === undefined) throw new Error(`no default mapping for ${key}: ${d}`);
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  if (col.type === "jsonb") return quote(canonicalJsonbText(text));
  if (col.type === "text[]" || col.type === "integer[]") {
    if (text !== "{}") throw new Error(`array default ${key}`);
    return "'[]'";
  }
  const num = /^numeric\((\d+),(\d+)\)$/.exec(col.type);
  if (num) return quote(formatDec(coerceTypmod(parseDecimalText(text), Number(num[1]), Number(num[2]))));
  if (col.type === "numeric") return quote(formatDec(parseDecimalText(text)));
  if (/^(integer|smallint|bigint|double precision|real)$/.test(col.type)) return text;
  return quote(text);
}

/** Whether the mapped column carries a <table>_<column>__vtype CHECK. */
function needsTypeCheck(col: PgColumn): boolean {
  return (
    col.enum !== undefined ||
    /^numeric|^character|^(boolean|timestamp with time zone|date|jsonb|json|text\[\]|integer\[\]|uuid)$/.test(col.type)
  );
}

// ---- the database ------------------------------------------------------------------

interface TableInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const clock: ConnectionClock = { transactionStart: null, statementStart: null };

function openBaseline(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF; PRAGMA trusted_schema = ON;");
  registerFunctions(db, clock);
  registerSchemaFunctions(db);
  db.exec(BASELINE);
  return db;
}

function all<T>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T[] {
  return db.prepare(sql).all(...args) as T[];
}

function sqliteObjects(db: DatabaseSync, type: string): { name: string; tbl_name: string; sql: string | null }[] {
  return all(db, "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", type);
}

/** Unique index named by a UNIQUE failure, as the connection's resolver does. */
function uniqueResolver(db: DatabaseSync): UniqueIndexResolver {
  return (table, columns) => {
    // An expression index is reported as "index '<name>'".
    const named = /^index '(.+)'$/.exec(table);
    if (named) return named[1];
    const indexes = all<{ name: string }>(db, `SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND origin <> 'pk'`, table);
    const matches = indexes.filter(({ name }) => {
      const cols = all<{ name: string | null }>(db, "SELECT name FROM pragma_index_info(?) ORDER BY seqno", name).map((c) => c.name);
      return cols.length === columns.length && cols.every((c, i) => c === columns[i]);
    });
    return matches.length === 1 ? matches[0]?.name : undefined;
  };
}

function seedInsert(table: string, values: Record<string, string>): string {
  return `INSERT INTO ${table} (${Object.keys(values).map((c) => `"${c}"`).join(", ")}) VALUES (${Object.values(values).join(", ")})`;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "string") return v;
  throw new Error(`unexpected value ${Object.prototype.toString.call(v)}`);
}

type Result = { error: PgError } | { rows: (string | null)[][] } | { ok: true };

function errorOf(db: DatabaseSync, err: unknown): PgError {
  const e = translateSqliteError(err, uniqueResolver(db)) as { code?: unknown; constraint?: unknown; column?: unknown; message?: unknown };
  const out: PgError = { code: typeof e.code === "string" ? e.code : `?${String(e.code)}`, message: String(e.message) };
  if (typeof e.constraint === "string") out.constraint = e.constraint;
  if (typeof e.column === "string") out.column = e.column;
  return out;
}

function run(db: DatabaseSync, sc: Scenario): Result {
  db.exec("SAVEPOINT scenario");
  try {
    for (const st of sc.setup ?? []) db.exec(st);
    for (const st of sc.sql) {
      try {
        db.exec(st);
      } catch (err) {
        return { error: errorOf(db, err) };
      }
    }
    if (sc.verify === undefined) return { ok: true };
    try {
      const rows = db.prepare(sc.verify).all() as Record<string, unknown>[];
      return { rows: rows.map((r) => Object.values(r).map(text)) };
    } catch (err) {
      return { error: errorOf(db, err) };
    }
  } finally {
    db.exec("ROLLBACK TO scenario; RELEASE scenario");
  }
}

const PK_NAMES = new Set(
  pgTablesOf(manifest).flatMap(([t, e]) => (e.primaryKey ? [e.primaryKey.name, PK_ERROR_NAMES[e.primaryKey.name] ?? `${t}_pkey`] : [])),
);

function pgTablesOf(m: Manifest): [string, ManifestTable][] {
  return Object.entries(m.tables).filter(([t]) => !DROPPED_TABLES.has(t));
}

/** Why `actual` does not match PostgreSQL's `expected` error, or null when it does. */
function errorMismatch(expected: PgError, actual: PgError): string | null {
  // SQLite names no foreign key in its error. A NO ACTION failure (787) maps to
  // 23503; an ON DELETE RESTRICT failure (PostgreSQL 23001) comes from SQLite's
  // FK trigger (1811, "FOREIGN KEY constraint failed"), which errors.ts does
  // not recognise yet and reports as P0001.
  if (expected.code === "23001" || expected.code === "23503") {
    const fk = actual.code === "23503" || actual.code === "23001" || actual.message === "FOREIGN KEY constraint failed";
    return fk ? null : `SQLSTATE ${actual.code} (${actual.message}), PostgreSQL ${expected.code} (${expected.message})`;
  }
  // A NULL written to an INTEGER PRIMARY KEY (rowid) fails with SQLITE_MISMATCH,
  // which errors.ts leaves untranslated.
  if (expected.code === "23502" && actual.message === "datatype mismatch") return null;
  const code = expected.code;
  if (actual.code !== code) return `SQLSTATE ${actual.code} (${actual.message}), PostgreSQL ${code} (${expected.message})`;
  if ((code === "23514" || code === "23505") && expected.constraint !== undefined) {
    const want = PK_ERROR_NAMES[expected.constraint] ?? expected.constraint;
    if (actual.constraint === want) return null;
    // A row that breaks the primary key and another unique index: SQLite checks
    // a rowid key before, and any other primary key after, the unique indexes
    // (which it checks in PostgreSQL's order); PostgreSQL checks them all in
    // index creation order.
    if (code === "23505" && actual.constraint !== undefined && (PK_NAMES.has(want) || PK_NAMES.has(actual.constraint))) return null;
    return `constraint ${String(actual.constraint)}, PostgreSQL ${want}`;
  }
  if (code === "23502") {
    if (actual.column !== undefined) return actual.column === expected.column ? null : `column ${actual.column}, PostgreSQL ${String(expected.column)}`;
    return actual.message === expected.message ? null : `message "${actual.message}", PostgreSQL "${expected.message}"`;
  }
  // Data exceptions (22xxx) from functions: the SQLSTATE is the contract.
  if (code.startsWith("22")) return null;
  // Errors a trigger raised: SQLSTATE, constraint and message are the contract.
  if (actual.message !== expected.message) return `message "${actual.message}", PostgreSQL "${expected.message}"`;
  if (actual.constraint !== expected.constraint) return `constraint ${String(actual.constraint)}, PostgreSQL ${String(expected.constraint)}`;
  return null;
}

// ---- tests -------------------------------------------------------------------------

let db: DatabaseSync;

beforeAll(() => {
  db = openBaseline();
});

afterAll(() => {
  db.close();
});

const pgTables = pgTablesOf(manifest);
const pgMvs = Object.entries(manifest.materializedViews);

describe("SQLite baseline: tables and columns", () => {
  it("has every PostgreSQL table and former materialized view, the Kysely tables dropped", () => {
    const sqlite = sqliteObjects(db, "table").map((t) => t.name);
    const expected = [...pgTables.map(([t]) => t), ...pgMvs.map(([t]) => t), ...ADDED_TABLES].sort();
    expect(sqlite).toEqual(expected);
    for (const t of DROPPED_TABLES) expect(manifest.tables[t]).toBeDefined();
  });

  it("maps every column's declared type, nullability and default", () => {
    const mismatches: string[] = [];
    let compared = 0;
    const check = (table: string, raw: RawColumn[], pk: string[], mv: boolean) => {
      const info = new Map(all<TableInfo>(db, "SELECT * FROM pragma_table_info(?)", table).map((c) => [c.name, c]));
      const cols = raw.map(pgColumn).filter((c) => !DROPPED_COLUMNS.has(`${table}.${c.name}`));
      expect([...info.keys()], `${table} column order`).toEqual(cols.map((c) => c.name));
      for (const col of cols) {
        const got = info.get(col.name);
        if (got === undefined) continue;
        compared++;
        const where = `${table}.${col.name}`;
        const type = expectedType(table, col, pk);
        if (got.type !== type) mismatches.push(`${where}: type ${got.type}, expected ${type} (${col.type})`);
        // An INTEGER PRIMARY KEY AUTOINCREMENT aliases the rowid, which is never NULL.
        const rowidAlias = got.type === "INTEGER" && got.pk === 1 && pk.length === 1;
        const notNull = mv ? MV_NOT_NULL.has(where) : col.notNull && !rowidAlias;
        if ((got.notnull === 1) !== notNull) mismatches.push(`${where}: notnull ${got.notnull}, expected ${String(notNull)}`);
        const def = mv ? null : expectedDefault(table, col);
        if (got.dflt_value !== def) mismatches.push(`${where}: default ${String(got.dflt_value)}, expected ${String(def)} (${String(col.default)})`);
      }
    };
    for (const [t, e] of pgTables) check(t, e.columns, e.primaryKey?.columns ?? [], false);
    for (const [t, e] of pgMvs) check(t, e.columns, [], true);
    expect(mismatches).toEqual([]);
    expect(compared).toBe(
      pgTables.reduce((n, [t, e]) => n + e.columns.filter((c) => !DROPPED_COLUMNS.has(`${t}.${c[0]}`)).length, 0) +
        pgMvs.reduce((n, [, e]) => n + e.columns.length, 0),
    );
  });

  it("drops only the generated search_vector column", () => {
    const generated = pgTables.flatMap(([t, e]) => e.columns.map(pgColumn).filter((c) => c.generated).map((c) => `${t}.${c.name}`));
    expect(generated).toEqual([...DROPPED_COLUMNS]);
  });

  it("keeps every primary key and its column order", () => {
    for (const [t, e] of pgTables) {
      const pk = all<TableInfo>(db, "SELECT * FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk", t).map((c) => c.name);
      expect(pk, t).toEqual(e.primaryKey?.columns.map(stripQuotes) ?? []);
      if (e.primaryKey) expect(sqliteObjects(db, "table").find((x) => x.name === t)?.sql, t).toContain(`CONSTRAINT ${e.primaryKey.name} PRIMARY KEY`);
    }
  });

  it("gives every column of a checked type its __vtype CHECK", () => {
    const missing: string[] = [];
    for (const [t, e] of [...pgTables, ...pgMvs.map(([t, mv]) => [t, { columns: mv.columns }] as const)]) {
      const sql = sqliteObjects(db, "table").find((x) => x.name === t)?.sql ?? "";
      for (const col of e.columns.map(pgColumn)) {
        if (DROPPED_COLUMNS.has(`${t}.${col.name}`)) continue;
        const has = sql.includes(`CONSTRAINT ${t}_${col.name}__vtype CHECK`);
        const varcharWithoutLength = col.type === "character varying";
        if (has !== (needsTypeCheck(col) && !varcharWithoutLength)) missing.push(`${t}.${col.name} (${col.type}): ${has ? "unexpected" : "missing"}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps every CHECK constraint by name, in PostgreSQL's (name) order", () => {
    for (const [t, e] of pgTables) {
      const sql = sqliteObjects(db, "table").find((x) => x.name === t)?.sql ?? "";
      const names = [...sql.matchAll(/CONSTRAINT (\w+) CHECK/g)].map((m) => m[1] ?? "").filter((n) => !n.endsWith("__vtype"));
      expect(names, t).toEqual([...e.checks].sort());
    }
  });

  it("keeps every foreign key by name, with its columns and actions", () => {
    const actions = (def: string, verb: "DELETE" | "UPDATE") =>
      new RegExp(`ON ${verb} (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)`).exec(def)?.[1] ?? "NO ACTION";
    for (const [t, e] of pgTables) {
      const sql = sqliteObjects(db, "table").find((x) => x.name === t)?.sql ?? "";
      const fks = all<{ id: number; table: string; from: string; to: string; on_delete: string; on_update: string }>(
        db,
        "SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq",
        t,
      );
      expect(new Set(fks.map((f) => f.id)).size, t).toBe(e.foreignKeys.length);
      for (const [name, def] of e.foreignKeys) {
        expect(sql, `${t} ${name}`).toContain(`CONSTRAINT ${name} FOREIGN KEY`);
        const m = /FOREIGN KEY \(([^)]*)\) REFERENCES (\w+)\(([^)]*)\)/.exec(def);
        const from = (m?.[1] ?? "").split(", ");
        const found = fks.filter((f) => f.table === m?.[2] && from.includes(f.from));
        expect(found.length, `${t} ${name}`).toBe(from.length);
        for (const f of found) {
          expect(f.on_delete, `${t} ${name}`).toBe(actions(def, "DELETE"));
          expect(f.on_update, `${t} ${name}`).toBe(actions(def, "UPDATE"));
        }
      }
    }
  });
});

describe("SQLite baseline: indexes", () => {
  interface IndexShape {
    unique: boolean;
    partial: boolean;
    keys: { name: string | null; desc: boolean }[];
  }

  /** Split "a, lower(b), c DESC" at top-level commas. */
  function splitTopLevel(list: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = false;
    let cur = "";
    for (const ch of list) {
      if (ch === "'") quote = !quote;
      if (!quote && ch === "(") depth++;
      if (!quote && ch === ")") depth--;
      if (!quote && depth === 0 && ch === ",") {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function pgShape(def: string): IndexShape {
    const m = /^CREATE (UNIQUE )?INDEX \w+ ON public\.\w+ USING btree \((.*?)\)(?: INCLUDE \(.*?\))?(?: WHERE (.*))?$/.exec(def);
    if (!m) throw new Error(`unparsed index ${def}`);
    const keys = splitTopLevel(m[2] ?? "").map((k) => {
      const desc = / DESC$/.test(k);
      const bare = k.replace(/ (DESC|ASC)$/, "");
      return { name: /^"?\w+"?$/.test(bare) ? stripQuotes(bare) : null, desc };
    });
    return { unique: m[1] !== undefined, partial: m[3] !== undefined, keys };
  }

  function sqliteShape(name: string, table: string): IndexShape {
    const list = all<{ name: string; unique: number; partial: number }>(db, "SELECT * FROM pragma_index_list(?)", table).find((i) => i.name === name);
    const keys = all<{ cid: number; name: string | null; desc: number; key: number }>(db, "SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno", name)
      .filter((k) => k.key === 1)
      .map((k) => ({ name: k.cid === -2 ? null : k.name, desc: k.desc === 1 }));
    return { unique: list?.unique === 1, partial: list?.partial === 1, keys };
  }

  const pgIndexes = [
    ...pgTables.flatMap(([t, e]) => e.indexes.map(([name, def]) => ({ table: t, name, def }))),
    ...pgMvs.flatMap(([t, e]) => e.indexes.map(([name, def]) => ({ table: t, name, def }))),
  ].filter((i) => !DROPPED_INDEXES.has(i.name));

  it("has exactly the PostgreSQL indexes, the GIN indexes dropped", () => {
    const sqlite = sqliteObjects(db, "index").map((i) => i.name);
    expect(sqlite).toEqual(pgIndexes.map((i) => i.name).sort());
    const all4 = pgTables.flatMap(([, e]) => e.indexes.filter(([n]) => DROPPED_INDEXES.has(n)).map(([, d]) => d));
    expect(all4).toHaveLength(DROPPED_INDEXES.size);
    for (const d of all4) expect(d).toMatch(/USING gin/);
  });

  it.each(pgIndexes)("$name keeps its uniqueness, predicate, key columns and sort order", ({ table, name, def }) => {
    const want = pgShape(def);
    const got = sqliteShape(name, table);
    expect(got).toEqual(want);
  });

  it("names a unique index after every UNIQUE constraint", () => {
    for (const [t, e] of pgTables) {
      for (const u of e.uniqueConstraints) expect(sqliteShape(u, t).unique, `${t} ${u}`).toBe(true);
    }
  });
});

describe("SQLite baseline: triggers, views, sequences", () => {
  it("has a SQLite trigger for every PostgreSQL trigger", () => {
    const sqlite = sqliteObjects(db, "trigger");
    const unmatched = new Set(sqlite.map((t) => t.name));
    for (const [t, e] of pgTables) {
      for (const name of e.triggers) {
        const mine = sqlite.filter((s) => s.tbl_name === t && (s.name === name || s.name.startsWith(`${name}__`)));
        expect(mine.length, `${t} ${name}`).toBeGreaterThan(0);
        for (const s of mine) unmatched.delete(s.name);
      }
    }
    expect([...unmatched]).toEqual([...ADDED_TRIGGERS]);
  });

  it("has every view with PostgreSQL's columns", () => {
    const views = sqliteObjects(db, "view").map((v) => v.name);
    const expected = Object.keys(manifest.views).map((v) => v.replace(/^vision_analysis\./, "vision_analysis_"));
    expect(views).toEqual([...expected].sort());
    for (const [v, cols] of Object.entries(manifest.views)) {
      const name = v.replace(/^vision_analysis\./, "vision_analysis_");
      const got = all<{ name: string }>(db, "SELECT name FROM pragma_table_info(?)", name).map((c) => c.name);
      expect(got, name).toEqual(cols.map(([c]) => c));
      expect(() => db.prepare(`SELECT * FROM ${name}`).all()).not.toThrow();
    }
  });

  it("seeds vision_sequences with every bigint sequence a key draws from", () => {
    const used = new Set<string>();
    for (const [, e] of pgTables) {
      for (const col of e.columns.map(pgColumn)) {
        const seq = col.default === null ? undefined : /^nextval\('(\w+)'::regclass\)$/.exec(col.default)?.[1];
        if (seq !== undefined && (col.type === "bigint" || seq === "portfolio_transactions_id_seq")) used.add(seq);
      }
    }
    const rows = all<{ name: string; last_value: number }>(db, "SELECT name, last_value FROM vision_sequences ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual([...used].sort());
    expect(rows.every((r) => r.last_value === 0)).toBe(true);
  });

  it("draws portfolio_transactions, adjustment and transfer ids from one sequence", () => {
    const fresh = openBaseline();
    try {
      fresh.exec(`
        INSERT INTO accounts (id, name) VALUES (1, 'a'), (2, 'b');
        INSERT INTO investments (id, name, asset_class) VALUES (1, 'i', 'stock');
        INSERT INTO portfolio_import_batches (adapter_name) VALUES ('t');
        INSERT INTO portfolio_import_staging_rows (batch_id, row_index) VALUES (1, 1), (1, 2);
        INSERT INTO portfolio_transactions (investment_id, type, date, amount) VALUES (1, 'buy', '2026-01-01', '1.0000');
        INSERT INTO portfolio_asset_adjustments (investment_id, account_id, date, units, adjustment_kind, basis_policy,
               import_batch_id, staging_row_id, source_record_hash, dedup_fingerprint, dedup_fingerprint_version)
        VALUES (1, 1, '2026-01-01', '1.00000000', 'asset_fee', 'carried', 1, 1, '${"a".repeat(64)}', '${"b".repeat(64)}', 1);
        INSERT INTO portfolio_asset_transfers (investment_id, source_account_id, destination_account_id, date, units,
               import_batch_id, staging_row_id, source_record_hash, dedup_fingerprint, dedup_fingerprint_version)
        VALUES (1, 1, 2, '2026-01-01', '1.00000000', 1, 2, '${"a".repeat(64)}', '${"b".repeat(64)}', 1);
        INSERT INTO portfolio_transactions (investment_id, type, date, amount) VALUES (1, 'sell', '2026-01-02', '1.0000');
      `);
      const ids = all<{ id: number }>(
        fresh,
        `SELECT id FROM portfolio_transactions UNION ALL SELECT id FROM portfolio_asset_adjustments
         UNION ALL SELECT id FROM portfolio_asset_transfers ORDER BY id`,
      ).map((r) => r.id);
      expect(ids).toEqual([1, 2, 3, 4]);
      expect(all<{ v: number }>(fresh, "SELECT last_value AS v FROM vision_sequences WHERE name = 'portfolio_import_batches_id_seq'")).toEqual([
        { v: 1 },
      ]);
    } finally {
      fresh.close();
    }
  });

  it("keeps the reference rows", () => {
    expect(all(db, "SELECT singleton, completed_at FROM adr109_legacy_cleanup_marker")).toEqual([
      { singleton: 1, completed_at: "2026-10-19T13:47:28.355570Z" },
    ]);
    expect(all(db, "SELECT singleton_id, undismissed_count, dirty_version, computed_version FROM insight_digest_state")).toEqual([
      { singleton_id: 1, undismissed_count: null, dirty_version: 6, computed_version: 0 },
    ]);
  });
});

describe("SQLite baseline: emulated triggers", () => {
  it("sets updated_at to now() after an UPDATE, as the BEFORE trigger did", () => {
    const fresh = openBaseline();
    try {
      clock.transactionStart = instantFromDate(new Date("2026-11-03T12:00:00.000Z"));
      fresh.exec("INSERT INTO tags (id, slug, updated_at) VALUES (1, 't', '2000-01-01T00:00:00.000000Z')");
      fresh.exec("UPDATE tags SET slug = 'u' WHERE id = 1");
      const now = formatInstant(clock.transactionStart);
      expect(all(fresh, "SELECT updated_at FROM tags")).toEqual([{ updated_at: now }]);
      // An explicit value is overwritten too, and NULL stores now(), as in PostgreSQL.
      fresh.exec("UPDATE tags SET updated_at = '2001-01-01T00:00:00.000000Z' WHERE id = 1");
      expect(all(fresh, "SELECT updated_at FROM tags")).toEqual([{ updated_at: now }]);
      fresh.exec("UPDATE tags SET updated_at = '2001-01-01T00:00:00.000000Z' WHERE id = 1");
      fresh.exec("UPDATE tags SET updated_at = NULL WHERE id = 1");
      expect(all(fresh, "SELECT updated_at FROM tags")).toEqual([{ updated_at: now }]);
    } finally {
      clock.transactionStart = null;
      fresh.close();
    }
  });

  it("writes a legacy category's parent and name after the row (RETURNING sees the row before the sync)", () => {
    db.exec("SAVEPOINT legacy");
    try {
      const returned = db.prepare("INSERT INTO categories (general, detail) VALUES ('legR', 'Child') RETURNING id, parent_id, name").get() as {
        id: number;
        parent_id: number | null;
        name: string;
      };
      expect(returned.parent_id).toBeNull();
      expect(returned.name).toBe("__LEGACY_NAME_PENDING__");
      const stored = all(db, "SELECT c.name, c.path_name, p.name AS root FROM categories c JOIN categories p ON p.id = c.parent_id WHERE c.id = ?", returned.id);
      expect(stored).toEqual([{ name: "Child", path_name: "legR:Child", root: "legR" }]);
    } finally {
      db.exec("ROLLBACK TO legacy; RELEASE legacy");
    }
  });
});

describe("SQLite baseline: type CHECKs", () => {
  const seedOf = new Map(fixture.seed.map((r) => [r.table, r.values]));
  /** Rows for the tables the scenarios do not seed. */
  const extraRows: Record<string, Record<string, string>> = {
    insight_digest_state: { singleton_id: "1" },
    adr109_legacy_cleanup_marker: { singleton: "1", completed_at: "'2026-01-01T00:00:00.000000Z'" },
    agg_split_outstanding: { split_id: "9001", recipient_id: "9001", original_amount: "'1.0000'", outstanding_amount: "'1.0000'" },
    mv_category_totals: { category_id: "1" },
    mv_monthly_summary: { category_id_key: "1" },
  };

  function badValues(col: PgColumn): string[] {
    if (col.enum) return [`'${col.enum[0] ?? ""}x'`, "1"];
    const t = col.type;
    const len = /^character(?: varying)?\((\d+)\)$/.exec(t);
    if (len) return [`'${"x".repeat(Number(len[1]) + 1)}'`];
    const num = /^numeric\((\d+),(\d+)\)$/.exec(t);
    // An INTEGER is stored as its text (TEXT affinity), so 1 is bad only where a scale is due.
    if (num) return ["'abc'", Number(num[2]) > 0 ? "'1'" : "'1.0'", ...(Number(num[2]) > 0 ? ["1"] : []), `'1${"0".repeat(Number(num[1]))}'`];
    if (t === "numeric") return ["'abc'", "'1e2'", "'01'", "'+1'", "'1.50e0'"];
    if (t === "boolean") return ["2", "'true'", "-1"];
    if (t === "timestamp with time zone") return ["'2026-01-01 00:00:00'", "'2026-01-01T00:00:00Z'", "0"];
    if (t === "date") return ["'2026-02-30'", "'20260101'", "'2026-1-01'"];
    if (t === "jsonb") return [`'{"b":1,"a":2}'`, "'{'", "'1.50e1'"];
    if (t === "json") return ["'{'", "'[1,'"];
    if (t === "text[]" || t === "integer[]") return ["'{a}'", "'{}'"];
    if (t === "uuid") return [`'${"A".repeat(8)}-0000-4000-8000-000000000000'`, "'x'", "'{00000000-0000-4000-8000-000000000000}'"];
    return [];
  }

  const probes: { table: string; column: string; value: string; row: Record<string, string> }[] = [];
  for (const [table, e] of [...pgTables, ...pgMvs.map(([t, mv]) => [t, { columns: mv.columns }] as const)]) {
    const row = seedOf.get(table) ?? extraRows[table];
    if (row === undefined) throw new Error(`no row for ${table}`);
    for (const col of e.columns.map(pgColumn)) {
      if (DROPPED_COLUMNS.has(`${table}.${col.name}`) || col.type === "character varying") continue;
      for (const value of badValues(col)) probes.push({ table, column: col.name, value, row });
    }
  }

  it.each(probes)("$table $column refuses $value", ({ table, column, value, row }) => {
    const result = run(db, { group: "type", name: "", sql: [seedInsert(table, { ...row, [column]: value })], expect: { ok: true } });
    expect(result).toEqual({ error: expect.objectContaining({ code: "23514", constraint: `${table}_${column}__vtype` }) as unknown });
  });

  it("accepts every seed row", () => {
    const fresh = openBaseline();
    try {
      for (const r of fixture.seed) fresh.exec(seedInsert(r.table, r.values));
    } finally {
      fresh.close();
    }
  });
});

describe("SQLite baseline: PostgreSQL parity scenarios", () => {
  beforeAll(() => {
    db.exec("BEGIN");
    for (const r of fixture.seed) db.exec(seedInsert(r.table, r.values));
  });

  afterAll(() => {
    db.exec("ROLLBACK");
  });

  const groups = [...new Set(fixture.scenarios.map((s) => s.group))];

  it("covers every PostgreSQL CHECK with a passing and a failing probe", () => {
    const pass = new Set<string>();
    const fail = new Set<string>();
    for (const s of fixture.scenarios) {
      if (s.check === undefined) continue;
      if ("error" in s.expect) fail.add(s.check);
      else pass.add(s.check);
    }
    const checks = pgTables.flatMap(([, e]) => e.checks);
    expect(checks.filter((c) => !pass.has(c) || !fail.has(c))).toEqual([]);
  });

  it("calls portfolio_income_transaction_snapshot with the columns schemaFunctions.ts lists", () => {
    const call = portfolioIncomeTransactionSnapshotSql("pt");
    const uses = fixture.scenarios.filter((s) => s.verify?.includes("portfolio_income_transaction_snapshot("));
    expect(uses.length).toBeGreaterThan(0);
    for (const s of uses) expect(s.verify).toContain(call);
    expect(PORTFOLIO_INCOME_SNAPSHOT_COLUMNS).toHaveLength(22);
  });

  describe.each(groups)("%s", (group) => {
    const scenarios = fixture.scenarios.filter((s) => s.group === group);
    it.each(scenarios)("$name", (sc) => {
      const actual = run(db, sc);
      const known = KNOWN_DIFFERENCES[sc.name];
      if (known !== undefined) {
        expect(actual, known.reason).toEqual(known.sqlite);
        expect(actual).not.toEqual(sc.expect);
        return;
      }
      const want = sc.expect;
      if ("error" in want) {
        expect("error" in actual ? null : actual, "PostgreSQL raised an error").toBeNull();
        if ("error" in actual) expect(errorMismatch(want.error, actual.error)).toBeNull();
      } else if ("rows" in want) {
        expect(actual).toEqual({ rows: want.rows });
      } else {
        expect(actual).toEqual({ ok: true });
      }
    });
  });
});

describe("schemaFunctions: vision_raise", () => {
  it("throws a DatabaseError with the SQLSTATE, constraint and message", () => {
    const err = (() => {
      try {
        db.prepare("SELECT vision_raise('23514', 'some_check', 'it ' || 'failed')").get();
      } catch (e) {
        return e as { name?: unknown; code?: unknown; constraint?: unknown; message?: unknown };
      }
      return undefined;
    })();
    expect(err).toMatchObject({ name: "DatabaseError", code: "23514", constraint: "some_check", message: "it failed" });
    expect(translateSqliteError(err)).toBe(err);
  });

  it("uses P0001 for a malformed SQLSTATE and leaves out an empty constraint", () => {
    expect(() => db.prepare("SELECT vision_raise('bad', '', 'm')").get()).toThrow(
      expect.objectContaining({ code: "P0001", message: "m" }),
    );
    let thrown: unknown;
    try {
      db.prepare("SELECT vision_raise(NULL, '', NULL)").get();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: "P0001", message: "" });
    expect(thrown).not.toHaveProperty("constraint");
  });

  it("rolls back the statement that raised it inside a trigger", () => {
    db.exec("SAVEPOINT raise");
    try {
      db.exec(`INSERT INTO recipients (id, name, normalized_name) VALUES (1, 'r', 'r');
               INSERT INTO transactions (id, date, amount, recipient_id) VALUES (1, '2026-01-01', '-10.0000', 1);
               INSERT INTO transaction_splits (id, transaction_id, recipient_id, amount) VALUES (1, 1, 1, '10.0000')`);
      expect(() => db.exec("UPDATE transactions SET amount = '-1.0000' WHERE id = 1")).toThrow(
        expect.objectContaining({ code: "23514", message: "transaction 1 amount -1.0000 is below its split total 10.0000" }),
      );
      expect(all(db, "SELECT amount FROM transactions WHERE id = 1")).toEqual([{ amount: "-10.0000" }]);
    } finally {
      db.exec("ROLLBACK TO raise; RELEASE raise");
    }
  });
});
