/**
 * DB data-editor service — powers the JetBrains-style table browser/editor in
 * the admin DB Maintenance UI.
 *
 * Safety model (see docs/adr for rationale):
 *   - Table/column identifiers are validated against SQLite's catalog
 *     (pragma_table_list / pragma_table_xinfo) and double-quoted — never
 *     interpolated raw.
 *   - Reads accept only structured, parameterized filters[] (the raw WHERE
 *     escape hatch was removed, ADR-101 2026-07-10 — any `where` param now 400s)
 *     and run on a read-only snapshot connection (PRAGMA query_only), so a
 *     browse cannot mutate the DB.
 *   - Writes run in one transaction (BEGIN IMMEDIATE on the single writer, so
 *     no other writer runs until it ends). Each edited row's version — a hash
 *     of its stored values, returned as `__xmin` — is compared against the
 *     token the client loaded: a mismatch is a 409 conflict, never a silent
 *     overwrite.
 *   - Values are written through the storage functions of their declared type
 *     (vision_numeric, vision_jsonb, vision_ts, ts_date) or coerced the way
 *     PostgreSQL's input functions read them, so every CHECK passes and the
 *     stored text stays canonical. SQLite still enforces every structural
 *     constraint (FK / CHECK / NOT NULL / UNIQUE); violations are mapped to
 *     friendly errors in mapDbError().
 *   - Edits to a materialized-view base table schedule a debounced refresh.
 *
 * This bypasses app-level domain logic by design (it is a raw data editor); the
 * deeper trade-offs are documented in the ADR.
 */

import crypto from "node:crypto";
import { ApiErrorCode } from "@vision/types/errors";
import {
  query,
  withReadSnapshot,
  withTransaction,
} from "../database/connection.ts";
import type { DbClient } from "../database/connection.ts";
import { logger } from "../config/logger.ts";
import { scheduleAggregationRefresh } from "./aggregationRefresh.ts";
import {
  AppError,
  ValidationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../middleware/errorHandler.ts";
import { lockAccountFundingGraph } from "../lib/accountFundingGraphLock.ts";
import { formatDateToYmd, toWireDate } from "../lib/dateFormat.ts";

/**
 * Column metadata for one table column, as introspected from
 * `pragma_table_xinfo`. Genuinely dynamic — this editor works against any user
 * table, so there is no fixed row shape to type against; `ColumnMeta`/
 * `TableMeta` describe the editor's own bookkeeping, not the tables it edits.
 * `dataType`/`udtName` keep PostgreSQL's names for the column's type (the
 * declared SQLite storage type mapped back), so the UI's editors stay the same.
 */
export interface ColumnMeta {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  hasDefault: boolean;
  generated: boolean;
  writable: boolean;
}

export interface TableMeta {
  table: string;
  columns: ColumnMeta[];
  primaryKey: string[];
}

/**
 * A structured filter clause from the browse UI (see the ADR-101 note on
 * `readRows` — the raw-WHERE escape hatch was removed).
 */
export interface Filter {
  column: string;
  /** one of FILTER_OPS; defaults to 'eq'. */
  op?: string | undefined;
  value?: unknown;
}

/**
 * A pending row edit from the DB editor UI. `values`/`set`/`pk` are raw
 * column-name → value maps — genuinely dynamic (any editable table, any
 * column set), typed as `Record<string, unknown>` rather than a fixed shape.
 */
export interface Change {
  op: "insert" | "update" | "delete";
  /** insert only. */
  values?: Record<string, unknown> | undefined;
  /** update only — changed columns. */
  set?: Record<string, unknown> | undefined;
  /** update/delete — primary-key column values identifying the row. */
  pk?: Record<string, unknown> | undefined;
  /** optimistic-concurrency token (the row's `__xmin`) from the row the client loaded. */
  xmin?: unknown;
}

/**
 * How a column's values are stored, from its declared SQLite type
 * (docs/reference/sqlite-sql-dialect.md, "Storage types").
 */
export type StorageKind =
  | "integer"
  | "bigint"
  | "real"
  | "decimal"
  | "text"
  | "boolean"
  | "timestamptz"
  | "date"
  | "jsonb"
  | "json"
  | "array"
  | "uuid"
  | "other";

export interface ColumnStorage {
  kind: StorageKind;
  /** DECIMAL_TEXT(p,s) precision and scale; null for an unconstrained DECIMAL_TEXT. */
  precision: number | null;
  scale: number | null;
  /** The declared type as the catalog spells it. */
  declared: string;
}

/** Per-change context threaded through the mutation builders. */
export interface MutationCtx {
  colMeta: Map<string, ColumnMeta>;
  storage: Map<string, ColumnStorage>;
  primaryKey: string[];
  index: number;
}

/** A row of `pragma_table_xinfo` as `getTableMeta` selects it. */
export type RawColumnRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
};

/** Options accepted by `readRows`. */
export interface ReadRowsOptions {
  limit?: number | undefined;
  cursor?: string | undefined;
  orderBy?: string | undefined;
  dir?: string | undefined;
  filters?: Filter[] | undefined;
  /** accepted only to be rejected (400) — the raw-WHERE escape hatch was removed. */
  where?: string | undefined;
}

/** A decoded pagination cursor, before it is checked against the request. */
type CursorPayload = {
  v?: unknown;
  table?: unknown;
  dir?: unknown;
  filters?: unknown;
  orderColumns?: unknown;
  values?: unknown;
};

/** The fields of a driver error that `mapDbError` reads. */
type DbDriverError = {
  code?: string;
  detail?: string;
  column?: string;
  constraint?: string;
  message?: string;
};

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// Base tables whose rows feed the dashboard materialized views. Editing any of
// these leaves the views stale until refreshed (see materializedViewService).
const MATVIEW_BASE_TABLES = new Set([
  "transactions",
  "recipients",
  "categories",
]);

/**
 * Tables PostgreSQL did not list as user tables: the bigint sequences'
 * state (PostgreSQL sequences) is internal to id generation and stays out of
 * the editor.
 */
const INTERNAL_TABLES = new Set(["vision_sequences"]);

/**
 * The former materialized views, now ordinary tables that
 * materializedViewService refills from the ledger. PostgreSQL listed them and
 * refused writes to them; they stay browsable and read-only.
 */
const DERIVED_TABLES = new Set(["mv_monthly_summary", "mv_category_totals"]);

const FILTER_OPS = new Set([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "isnull",
  "notnull",
]);

// ── Identifier safety ───────────────────────────────────────────────────────

function quoteIdent(name: unknown): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Resolve a caller-supplied identifier to the catalog's OWN copy of that name.
 *
 * Every identifier that reaches SQL text goes through here first, so the string
 * that gets interpolated always originates from SQLite's catalog
 * (listUserTables / pragma_table_xinfo) rather than from the request — the
 * request value is only ever used as a lookup key. That is stricter than
 * validate-then-use-the-input: it holds by construction even if a membership
 * check upstream is later loosened, and it is what makes the safety legible to
 * static taint analysis, which cannot see a `Set.has()` test as a sanitizer and
 * therefore reports the read query below as a high-severity injection sink.
 *
 * The match is exact and case-sensitive, as PostgreSQL's quoted identifiers
 * were: "Transactions" is not "transactions" here even though SQLite itself
 * would fold the case.
 *
 * @param allowed catalog-derived names
 * @returns the catalog's string, or null when there is no match
 */
function resolveIdent(name: unknown, allowed: Iterable<string>): string | null {
  if (typeof name !== "string" || name.length === 0) return null;
  for (const candidate of allowed) {
    if (candidate === name) return candidate;
  }
  return null;
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  // String(value): Number.parseInt already ToStrings a non-string argument
  // internally (same algorithm), so this is a no-op for behavior — it only
  // satisfies parseInt's string-typed signature.
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// The catalog IS the injection allowlist, so it must stay correct — but table
// column/PK metadata is static within a running backend (this editor only does
// data DML, never DDL; a schema migration restarts the process). A short TTL
// memo removes the catalog round-trips per browse tick / mutation without
// weakening the allowlist semantics.
const META_TTL_MS = 60_000;

interface TableInfo {
  meta: TableMeta;
  storage: Map<string, ColumnStorage>;
}

let userTablesCache: { value: Set<string> | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};
const tableMetaCache = new Map<
  string,
  { value: TableInfo; expiresAt: number }
>();

export function __clearDbEditorMetadataCacheForTests() {
  userTablesCache = { value: null, expiresAt: 0 };
  tableMetaCache.clear();
}

/**
 * The user tables of the database: ordinary tables of the main schema, without
 * SQLite's own (`sqlite_*`), virtual and shadow tables (pragma_table_list
 * types them apart) and Vision's sequence table. Also the allowlist of the
 * admin maintenance endpoints, which pass `fresh` to read the catalog as it is
 * now instead of the editor's short-lived memo.
 */
export async function listUserTables({ fresh = false }: { fresh?: boolean } = {}): Promise<Set<string>> {
  const now = Date.now();
  if (!fresh && userTablesCache.value && userTablesCache.expiresAt > now)
    return userTablesCache.value;
  const r = await query<{ name: string }>(
    `SELECT name FROM pragma_table_list
      WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
    [],
  );
  const set = new Set(
    r.rows.map((row) => row.name).filter((name) => !INTERNAL_TABLES.has(name)),
  );
  userTablesCache = { value: set, expiresAt: now + META_TTL_MS };
  return set;
}

/**
 * @returns the catalog's own copy of the table name
 */
async function resolveEditableTable(table: unknown): Promise<string> {
  if (typeof table !== "string" || table.length === 0) {
    throw new ValidationError("Table name is required");
  }
  const resolved = resolveIdent(table, await listUserTables());
  if (resolved === null) {
    throw new NotFoundError(`Unknown table: ${table}`);
  }
  return resolved;
}

// ── Introspection ───────────────────────────────────────────────────────────

const DECIMAL_TYPE = /^DECIMAL_TEXT\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/;

/** The storage kind of a declared column type. */
export function storageOf(declared: string): ColumnStorage {
  const t = declared.trim().toUpperCase();
  const decimal = DECIMAL_TYPE.exec(t);
  if (decimal) {
    const precision = decimal[1] === undefined ? null : Number(decimal[1]);
    const scale = precision === null ? null : Number(decimal[2] ?? 0);
    return { kind: "decimal", precision, scale, declared };
  }
  const simple: Record<string, StorageKind> = {
    INTEGER: "integer",
    INT: "integer",
    SMALLINT: "integer",
    BIGINT: "bigint",
    REAL: "real",
    "DOUBLE PRECISION": "real",
    TEXT: "text",
    "": "text",
    BOOLEAN: "boolean",
    TIMESTAMPTZ_TEXT: "timestamptz",
    DATE_TEXT: "date",
    JSONB_TEXT: "jsonb",
    JSON_TEXT: "json",
    TEXT_ARRAY: "array",
    UUID_TEXT: "uuid",
  };
  return { kind: simple[t] ?? "other", precision: null, scale: null, declared };
}

/** PostgreSQL's information_schema `data_type` / `udt_name` for a storage kind. */
const PG_TYPE_NAMES: Record<StorageKind, readonly [string, string] | null> = {
  integer: ["integer", "int4"],
  bigint: ["bigint", "int8"],
  real: ["double precision", "float8"],
  decimal: ["numeric", "numeric"],
  text: ["text", "text"],
  boolean: ["boolean", "bool"],
  timestamptz: ["timestamp with time zone", "timestamptz"],
  date: ["date", "date"],
  jsonb: ["jsonb", "jsonb"],
  json: ["json", "json"],
  array: ["ARRAY", "_text"],
  uuid: ["uuid", "uuid"],
  other: null,
};

async function getTableInfo(table: string): Promise<TableInfo> {
  // `safeTable` is the catalog's string, not the caller's — see resolveIdent.
  // Everything downstream (meta.table, and through it every quoteIdent call in
  // this module) is built from it.
  const safeTable = await resolveEditableTable(table);

  const now = Date.now();
  const cached = tableMetaCache.get(safeTable);
  if (cached && cached.expiresAt > now) return cached.value;

  // hidden: 0 an ordinary column, 2 or 3 a generated (VIRTUAL / STORED) one.
  const colsRes = await query<RawColumnRow>(
    `SELECT cid, name, type, "notnull", dflt_value, pk, hidden
       FROM pragma_table_xinfo($1)
      WHERE hidden <> 1
      ORDER BY cid`,
    [safeTable],
  );

  const pkRows = colsRes.rows.filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk);
  // An INTEGER PRIMARY KEY aliases the rowid: SQLite assigns it on insert, as
  // a serial default did.
  const rowidAlias =
    pkRows.length === 1 && pkRows[0]?.type.trim().toUpperCase() === "INTEGER"
      ? pkRows[0].name
      : null;
  const storage = new Map<string, ColumnStorage>();
  const columns: ColumnMeta[] = colsRes.rows.map((r) => {
    const store = storageOf(r.type);
    storage.set(r.name, store);
    const names = PG_TYPE_NAMES[store.kind] ?? [
      r.type.trim().toLowerCase() || "text",
      r.type.trim().toLowerCase() || "text",
    ];
    const generated = r.hidden === 2 || r.hidden === 3;
    return {
      name: r.name,
      dataType: names[0],
      udtName: names[1],
      // Primary-key columns are NOT NULL, as every PostgreSQL key column was.
      nullable: r.notnull === 0 && r.pk === 0,
      hasDefault: r.dflt_value !== null || r.name === rowidAlias,
      generated,
      // Generated columns cannot be written.
      writable: !generated,
    };
  });

  const info: TableInfo = {
    meta: {
      table: safeTable,
      columns,
      primaryKey: pkRows.map((r) => r.name),
    },
    storage,
  };
  tableMetaCache.set(safeTable, { value: info, expiresAt: now + META_TTL_MS });
  return info;
}

/**
 * Column + primary-key metadata for a user table.
 */
export async function getTableMeta(table: string): Promise<TableMeta> {
  return (await getTableInfo(table)).meta;
}

// ── Value coercion ──────────────────────────────────────────────────────────

/** PostgreSQL's name of a storage kind's type, for input-error messages. */
const PG_INPUT_TYPE: Record<StorageKind, string> = {
  integer: "integer",
  bigint: "bigint",
  real: "double precision",
  decimal: "numeric",
  text: "text",
  boolean: "boolean",
  timestamptz: "timestamp with time zone",
  date: "date",
  jsonb: "json",
  json: "json",
  array: "text[]",
  uuid: "uuid",
  other: "text",
};

/** Text of a value as node-postgres sent it to PostgreSQL's input functions. */
function inputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** The 22P02 PostgreSQL raised for text its input function could not read. */
function invalidInput(kind: StorageKind, value: unknown): ValidationError {
  const prefix = kind === "array" ? "malformed array literal" : `invalid input syntax for type ${PG_INPUT_TYPE[kind]}`;
  return new ValidationError(`Invalid value for column type: ${prefix}: "${inputText(value)}"`);
}

function outOfRange(kind: StorageKind, value: unknown): ValidationError {
  return new ValidationError(
    `Invalid value for column type: value "${inputText(value)}" is out of range for type ${PG_INPUT_TYPE[kind]}`,
  );
}

const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;
const INT4_MIN = -(2n ** 31n);
const INT4_MAX = 2n ** 31n - 1n;
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;
const TRUE_WORDS = new Set(["t", "tr", "tru", "true", "y", "ye", "yes", "on", "1"]);
const FALSE_WORDS = new Set(["f", "fa", "fal", "fals", "false", "n", "no", "of", "off", "0"]);
const DATE_PREFIX = /^\s*(\d{4}-\d{2}-\d{2})(?:[T ]|$)/;

function coerceInteger(value: unknown, kind: "integer" | "bigint"): number | bigint {
  let n: bigint;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && INTEGER_TEXT.test(value)) n = BigInt(value.trim());
  else throw invalidInput(kind, value);
  const [min, max] = kind === "integer" ? [INT4_MIN, INT4_MAX] : [INT8_MIN, INT8_MAX];
  if (n < min || n > max) throw outOfRange(kind, value);
  const asNumber = Number(n);
  return Number.isSafeInteger(asNumber) ? asNumber : n;
}

function coerceBoolean(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === 1 || value === 0) return value;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return 1;
    if (FALSE_WORDS.has(word)) return 0;
  }
  throw invalidInput("boolean", value);
}

function coerceUuid(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  const braced = /^\{(.*)\}$/.exec(text);
  const hex = (braced ? braced[1] ?? "" : text).replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw invalidInput("uuid", value);
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function coerceArray(value: unknown): string {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw invalidInput("array", value);
    }
  }
  if (!Array.isArray(parsed)) throw invalidInput("array", value);
  return JSON.stringify(parsed);
}

/**
 * Convert a value from the request into what the column's storage holds, as
 * PostgreSQL's input function for the column type read node-postgres's text.
 * Types written through a SQL storage function (numeric, jsonb, timestamptz,
 * date) only get their text here; the function validates and canonicalizes.
 */
export function coerceValue(value: unknown, storage: ColumnStorage | undefined): unknown {
  if (value === null || value === undefined) return null;
  const kind = storage?.kind ?? "other";
  switch (kind) {
    case "integer":
    case "bigint":
      return coerceInteger(value, kind);
    case "real": {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
      if (!Number.isFinite(n)) throw invalidInput(kind, value);
      return n;
    }
    case "boolean":
      return coerceBoolean(value);
    case "uuid":
      return coerceUuid(value);
    case "array":
      return coerceArray(value);
    case "date": {
      if (value instanceof Date) return formatDateToYmd(value);
      const text = inputText(value);
      // PostgreSQL's date input reads the calendar day and ignores a time.
      return DATE_PREFIX.exec(text)?.[1] ?? text;
    }
    case "timestamptz":
      return value instanceof Date ? value : inputText(value);
    case "decimal":
    case "jsonb":
    case "json":
    case "text":
    case "other":
      return inputText(value);
  }
}

/**
 * The placeholder for a value of this storage: the storage function that
 * validates and canonicalizes it, so the column's CHECK passes.
 */
function storagePlaceholder(placeholder: string, storage: ColumnStorage | undefined): string {
  switch (storage?.kind) {
    case "decimal":
      return storage.precision === null
        ? `vision_numeric(${placeholder})`
        : `vision_numeric(${placeholder}, ${storage.precision}, ${storage.scale ?? 0})`;
    case "jsonb":
      return `vision_jsonb(${placeholder})`;
    case "timestamptz":
      return `vision_ts(${placeholder})`;
    case "date":
      return `ts_date(${placeholder})`;
    default:
      return placeholder;
  }
}

// ── Reads (browse / filter / sort / paginate) ───────────────────────────────

/**
 * The driver reads DATE_TEXT as a local-midnight Date, which JSON-serializes
 * as the previous day's UTC timestamp east of UTC. The editor shows and
 * round-trips the cell text, so dates go out as calendar days.
 */
function withWireDates(
  row: Record<string, unknown> | undefined,
  columns: ColumnMeta[],
): Record<string, unknown> | undefined {
  if (!row) return row;
  for (const column of columns) {
    const value = row[column.name];
    if (column.udtName === "date" && value instanceof Date) {
      row[column.name] = toWireDate(value);
    }
  }
  return row;
}

/**
 * The row-version expression: every stored value in its exact SQL literal
 * form, so the text changes whenever any value does. quote() renders text in
 * quotes (doubling inner ones), so the joined text is unambiguous.
 */
function rowVersionSql(columns: ColumnMeta[]): string {
  return columns.map((c) => `quote(${quoteIdent(c.name)})`).join(" || ',' || ");
}

/** The `__xmin` token of a row: a digest of its row-version text. */
function rowVersionToken(text: unknown): string {
  return crypto
    .createHash("sha256")
    .update(typeof text === "string" ? text : String(text))
    .digest("hex")
    .slice(0, 32);
}

/** Text of a filter value for LIKE patterns. */
function filterText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** The column as text, the way PostgreSQL's `col::text` matched it. */
function columnText(col: string, storage: ColumnStorage | undefined): string {
  if (storage?.kind === "boolean") {
    return `(CASE ${col} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END)`;
  }
  return `CAST(${col} AS TEXT)`;
}

const DECIMAL_COMPARISON: Record<string, string> = {
  eq: "dec_eq",
  ne: "dec_ne",
  lt: "dec_lt",
  lte: "dec_le",
  gt: "dec_gt",
  gte: "dec_ge",
};

const SQL_COMPARISON: Record<string, string> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

function buildFilterFragment(
  filter: Filter,
  params: unknown[],
  columnNames: Set<string>,
  storage: Map<string, ColumnStorage>,
): string {
  const column = resolveIdent(filter.column, columnNames);
  if (column === null) {
    throw new ValidationError(`Unknown filter column: ${filter.column}`);
  }
  const op = filter.op ?? "eq";
  if (!FILTER_OPS.has(op)) {
    throw new ValidationError(`Unknown filter operator: ${op}`);
  }
  const col = quoteIdent(column);
  const store = storage.get(column);
  switch (op) {
    case "isnull":
      return `${col} IS NULL`;
    case "notnull":
      return `${col} IS NOT NULL`;
    case "contains":
      params.push(`%${filterText(filter.value)}%`);
      return `ilike(${columnText(col, store)}, $${params.length})`;
    case "startsWith":
      params.push(`${filterText(filter.value)}%`);
      return `ilike(${columnText(col, store)}, $${params.length})`;
    default: {
      params.push(coerceValue(filter.value, store));
      const placeholder = `$${params.length}`;
      if (store?.kind === "decimal") {
        return `${DECIMAL_COMPARISON[op] ?? "dec_eq"}(${col}, ${placeholder})`;
      }
      return `${col} ${SQL_COMPARISON[op] ?? "="} ${storagePlaceholder(placeholder, store)}`;
    }
  }
}

interface CursorColumn {
  /** The SQL the rows are ordered by. */
  expression: string;
  /** The SQL the cursor's value is projected from. */
  value: string;
  /** Wraps a bound cursor value so it compares like `expression`. */
  bound: (placeholder: string) => string;
  contextKey: string;
  rowid: boolean;
  valueKey: string;
}

function cursorColumnFor(column: string, storage: ColumnStorage | undefined): CursorColumn {
  const col = quoteIdent(column);
  // DECIMAL_TEXT orders by value, not by its text.
  const decimal = storage?.kind === "decimal";
  return {
    expression: decimal ? `dec_key(${col})` : col,
    value: col,
    bound: decimal ? (p) => `dec_key(${p})` : (p) => p,
    contextKey: column,
    rowid: false,
    valueKey: "",
  };
}

/**
 * Read a page of rows, on a read-only snapshot connection.
 *
 * Only the structured, parameterized `filters[]` path exists — the ADR-101
 * raw-WHERE escape hatch was removed (2026-07-10): concatenating a caller
 * string into the SQL was a blind-SQLi timing oracle (pg_sleep in the WHERE
 * survives CORS on this CSRF-exempt GET), and a bare `--` silently truncated
 * the rest of the statement past the `;` guard.
 * @param opts `where` is accepted only to be rejected (400) — the raw-WHERE
 *          escape hatch was removed.
 */
export async function readRows(table: string, opts: ReadRowsOptions = {}) {
  const { meta, storage } = await getTableInfo(table);
  const { table: safeTable, columns, primaryKey } = meta;
  const columnNames = new Set(columns.map((c) => c.name));

  const limit = clampInt(opts.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const params: unknown[] = [];
  const whereParts: string[] = [];

  for (const filter of opts.filters ?? []) {
    whereParts.push(buildFilterFragment(filter, params, columnNames, storage));
  }

  if (opts.where !== undefined && opts.where.trim() !== "") {
    throw new ValidationError(
      // sql-dialect-ok: an API error message naming the filters[] parameter, not SQL
      "The raw WHERE parameter has been removed. Use the structured filters[] parameter instead.",
    );
  }

  const dir = String(opts.dir).toLowerCase() === "desc" ? "DESC" : "ASC";
  const orderColumns: string[] = [];
  if (opts.orderBy !== undefined && opts.orderBy !== "") {
    const orderCol = resolveIdent(opts.orderBy, columnNames);
    if (orderCol === null) {
      throw new ValidationError(`Unknown sort column: ${opts.orderBy}`);
    }
    orderColumns.push(orderCol);
  }
  for (const pk of primaryKey) {
    if (!orderColumns.includes(pk)) orderColumns.push(pk);
  }
  const cursorColumns = orderColumns.map((column) => cursorColumnFor(column, storage.get(column)));
  if (primaryKey.length === 0) {
    // A table without a primary key still has its rowid, a unique tiebreak.
    cursorColumns.push({
      expression: "rowid",
      value: "rowid",
      bound: (p) => `CAST(${p} AS INTEGER)`,
      contextKey: "__system_rowid",
      rowid: true,
      valueKey: "",
    });
  }
  const reservedAliases = new Set(columnNames);
  for (const [index, cursorColumn] of cursorColumns.entries()) {
    const base = `__vision_cursor_value_${index + 1}`;
    let alias = base;
    let suffix = 2;
    while (reservedAliases.has(alias)) {
      alias = `${base}_${suffix}`;
      suffix += 1;
    }
    cursorColumn.valueKey = alias;
    reservedAliases.add(alias);
  }
  const orderSql = `ORDER BY ${cursorColumns
    .map((column) => `${column.expression} ${dir} NULLS LAST`)
    .join(", ")}`;

  const cursorContext = {
    v: 2,
    table: safeTable,
    orderColumns: cursorColumns.map((column) => column.contextKey),
    dir,
    filters: crypto
      .createHash("sha256")
      .update(JSON.stringify(opts.filters ?? []))
      .digest("hex"),
  };
  if (opts.cursor) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        Buffer.from(opts.cursor, "base64url").toString("utf8"),
      );
    } catch {
      throw new ValidationError("Invalid pagination cursor");
    }
    // A non-object payload (e.g. `null`) is mismatched like any other bad cursor.
    const decoded: CursorPayload =
      typeof parsed === "object" && parsed !== null
        ? parsed
        : {};
    const cursorRawValues = decoded.values;
    if (
      decoded.v !== cursorContext.v ||
      decoded.table !== cursorContext.table ||
      decoded.dir !== cursorContext.dir ||
      decoded.filters !== cursorContext.filters ||
      JSON.stringify(decoded.orderColumns) !==
        JSON.stringify(cursorContext.orderColumns) ||
      !Array.isArray(cursorRawValues) ||
      cursorRawValues.length !== cursorColumns.length
    ) {
      throw new ValidationError(
        "Pagination cursor does not match the current table, sort, or filters",
      );
    }
    const cursorValues = cursorRawValues as unknown[];
    if (
      !cursorValues.every(
        (value): value is string | null =>
          value === null || typeof value === "string",
      )
    ) {
      throw new ValidationError("Invalid pagination cursor");
    }
    const branches: string[] = [];
    for (const [index, column] of cursorColumns.entries()) {
      const prefix: string[] = [];
      for (const [prior, priorColumn] of cursorColumns
        .slice(0, index)
        .entries()) {
        params.push(cursorValues[prior]);
        const bound = priorColumn.bound(`$${params.length}`);
        prefix.push(
          priorColumn.rowid
            ? `${priorColumn.expression} = ${bound}`
            : `${priorColumn.expression} IS NOT DISTINCT FROM ${bound}`,
        );
      }
      const value = cursorValues[index];
      if (value === null || value === undefined) continue;
      params.push(value);
      const bound = column.bound(`$${params.length}`);
      const comparison = column.rowid
        ? `${column.expression} ${dir === "ASC" ? ">" : "<"} ${bound}`
        : `(${column.expression} ${dir === "ASC" ? ">" : "<"} ${bound} OR ${column.value} IS NULL)`;
      branches.push(`(${[...prefix, comparison].join(" AND ")})`);
    }
    if (branches.length === 0) {
      whereParts.push("FALSE");
    } else {
      whereParts.push(`(${branches.join(" OR ")})`);
    }
  }

  const cursorWhereSql = whereParts.length > 0
    ? `WHERE ${whereParts.join(" AND ")}`
    : "";

  const tbl = quoteIdent(safeTable);
  // The row version rides along as a hidden optimistic-concurrency token.
  // Cursor boundaries are the stored text (`::text`), not the decoded values,
  // which keeps timestamp microseconds and exact decimals and bigints.
  const cursorSelect = cursorColumns
    .map(
      (column) =>
        `, ${column.value} AS ${quoteIdent(`${column.valueKey}::text`)}`,
    )
    .join("");
  const dataSql = `SELECT *, ${rowVersionSql(columns)} AS __xmin${cursorSelect} FROM ${tbl} ${cursorWhereSql} ${orderSql} LIMIT ${limit + 1}`;

  try {
    const dataRes = await withReadSnapshot((client) =>
      // A user-chosen table: its columns are dynamic, so rows stay unchecked.
      client.query(dataSql, params),
    );
    const hasMore = dataRes.rows.length > limit;
    const rows = dataRes.rows.slice(0, limit);
    const last = rows.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              ...cursorContext,
              values: cursorColumns.map((column) => last[column.valueKey] ?? null),
            }),
          ).toString("base64url")
        : null;
    for (const row of rows) {
      for (const column of cursorColumns)
        Reflect.deleteProperty(row, column.valueKey);
      row.__xmin = rowVersionToken(row.__xmin);
      withWireDates(row, columns);
    }
    return {
      table: safeTable,
      columns,
      primaryKey,
      rows,
      total: !opts.cursor && !hasMore ? rows.length : undefined,
      limit,
      hasMore,
      nextCursor,
    };
  } catch (err) {
    throw mapDbError(err);
  }
}

// ── Mutation building ───────────────────────────────────────────────────────

function literalForDisplay(value: unknown): string {
  if (value === undefined || value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object")
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  // JSON bodies only carry strings and bigints past this point.
  if (typeof value !== "string" && typeof value !== "bigint") return "NULL";
  const text = typeof value === "string" ? value : value.toString();
  return `'${text.replace(/'/g, "''")}'`;
}

function renderPreview(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_: string, n: string) =>
    literalForDisplay(params[Number(n) - 1]),
  );
}

function normalizeWrite(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** Column metadata for a name already filtered against the catalog. */
function requireColumn(ctx: MutationCtx, name: string): ColumnMeta {
  const meta = ctx.colMeta.get(name);
  if (!meta) throw new ValidationError(`Unknown column "${name}"`);
  return meta;
}

/** A mutation statement and, per parameter, the storage it is written to. */
interface MutationSql {
  sql: string;
  params: unknown[];
  storages: Array<ColumnStorage | undefined>;
}

/** `"k1" = $n AND …` over the primary key, binding its values into `out`. */
function primaryKeyWhere(
  pk: Record<string, unknown>,
  ctx: MutationCtx,
  out: Pick<MutationSql, "params" | "storages">,
): string {
  return ctx.primaryKey
    .map((k) => {
      out.params.push(pk[k]);
      out.storages.push(ctx.storage.get(k));
      return `${quoteIdent(k)} = ${storagePlaceholder(`$${out.params.length}`, ctx.storage.get(k))}`;
    })
    .join(" AND ");
}

/**
 * Build the primary mutation statement (INSERT/UPDATE/DELETE) for a change.
 * Used both for dry-run previews and for execution, so the SQL shown to the
 * user is exactly what runs.
 *
 * @param table must already be catalog-resolved (resolveEditableTable)
 */
function buildMutationSql(
  table: string,
  change: Change,
  ctx: MutationCtx,
): MutationSql {
  const tbl = quoteIdent(table);

  // Domain guard: getIncludeTransfers reads user_settings with a strict
  // `=== true`, so a jsonb number 1/0 (or any non-boolean) written for the
  // includeTransfers key would silently be interpreted as false. The API PUT
  // layer already rejects this; close the same gap on the admin editor path.
  if (table === "user_settings") {
    const key = change.op === "insert" ? change.values?.key : change.pk?.key;
    const value =
      change.op === "insert" ? change.values?.value : change.set?.value;
    if (
      key === "includeTransfers" &&
      value !== undefined &&
      typeof value !== "boolean"
    ) {
      throw new ValidationError(
        "user_settings.includeTransfers must be a JSON boolean",
      );
    }
  }

  // validateChange has already required every primary-key column in `pk` for
  // update/delete, so `pk` is only empty here when there is no key to read.
  const pk = change.pk ?? {};
  const out: MutationSql = { sql: "", params: [], storages: [] };

  if (change.op === "insert") {
    const values = change.values ?? {};
    // Only columns present in the catalog survive this filter, so every
    // colMeta lookup below hits.
    const cols = Object.keys(values).filter((c) => ctx.colMeta.has(c));
    if (cols.length === 0)
      throw new ValidationError(`Insert #${ctx.index} has no values`);
    for (const c of cols) {
      if (!requireColumn(ctx, c).writable) {
        throw new ValidationError(
          `Column "${c}" is generated and cannot be written`,
        );
      }
    }
    const placeholders = cols.map((c) => {
      out.params.push(normalizeWrite(values[c]));
      out.storages.push(ctx.storage.get(c));
      return storagePlaceholder(`$${out.params.length}`, ctx.storage.get(c));
    });
    out.sql = `INSERT INTO ${tbl} (${cols.map((c) => quoteIdent(requireColumn(ctx, c).name)).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`;
    return out;
  }

  if (change.op === "update") {
    const set = change.set ?? {};
    const cols = Object.keys(set).filter((c) => ctx.colMeta.has(c));
    if (cols.length === 0)
      throw new ValidationError(`Update #${ctx.index} has no changed columns`);
    for (const c of cols) {
      if (ctx.primaryKey.includes(c)) {
        throw new ValidationError(`Primary-key column "${c}" cannot be edited`);
      }
      if (!requireColumn(ctx, c).writable) {
        throw new ValidationError(
          `Column "${c}" is generated and cannot be written`,
        );
      }
    }
    const assigns = cols.map((c) => {
      out.params.push(normalizeWrite(set[c]));
      out.storages.push(ctx.storage.get(c));
      return `${quoteIdent(requireColumn(ctx, c).name)} = ${storagePlaceholder(`$${out.params.length}`, ctx.storage.get(c))}`;
    });
    const where = primaryKeyWhere(pk, ctx, out);
    out.sql = `UPDATE ${tbl} SET ${assigns.join(", ")} WHERE ${where} RETURNING *`;
    return out;
  }

  // Widened: the route validates `op`, but this stays a runtime guard for any
  // other caller.
  const op: string = change.op;
  if (op === "delete") {
    const where = primaryKeyWhere(pk, ctx, out);
    out.sql = `DELETE FROM ${tbl} WHERE ${where}`;
    return out;
  }

  throw new ValidationError(`Unknown op: ${op}`);
}

function validateChange(change: Change | null | undefined, ctx: MutationCtx): void {
  if (change == null || typeof change !== "object") {
    throw new ValidationError(`Change #${ctx.index} is malformed`);
  }
  const op: string = change.op;
  if (op === "update" || op === "delete") {
    const pk = change.pk ?? {};
    for (const k of ctx.primaryKey) {
      if (!(k in pk)) {
        throw new ValidationError(
          `Change #${ctx.index} is missing primary-key column "${k}"`,
        );
      }
    }
  } else if (op !== "insert") {
    throw new ValidationError(`Unknown op: ${op}`);
  }
}

// ── Mutation execution ──────────────────────────────────────────────────────

/** The token arrives as the text readRows returned; anything else is stringified defensively. */
function xminText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return value.toString();
  return JSON.stringify(value);
}

function pickPk(
  row: Record<string, unknown> | null | undefined,
  primaryKey: string[],
): Record<string, unknown> {
  const pk: Record<string, unknown> = {};
  for (const k of primaryKey) pk[k] = row?.[k];
  return pk;
}

/** The statement's parameters converted to their columns' storage. */
function boundParams(statement: MutationSql): unknown[] {
  return statement.params.map((value, i) => coerceValue(value, statement.storages[i]));
}

/**
 * The row as stored after the statement: AFTER triggers (updated_at, synced
 * columns) change it after RETURNING has already been produced.
 */
async function readBack(
  client: DbClient,
  table: string,
  row: Record<string, unknown> | undefined,
  ctx: MutationCtx,
): Promise<Record<string, unknown> | undefined> {
  if (!row) return row;
  const out: Pick<MutationSql, "params" | "storages"> = { params: [], storages: [] };
  const where = primaryKeyWhere(pickPk(row, ctx.primaryKey), ctx, out);
  const res = await client.query(
    `SELECT * FROM ${quoteIdent(table)} WHERE ${where}`,
    boundParams({ sql: "", ...out }),
  );
  return res.rows[0] ?? row;
}

/**
 * @param table must already be catalog-resolved (resolveEditableTable)
 */
async function applyOne(
  client: DbClient,
  table: string,
  change: Change,
  ctx: MutationCtx,
): Promise<{
  op: string;
  pk: Record<string, unknown> | undefined;
  after?: Record<string, unknown> | undefined;
}> {
  const columns = [...ctx.colMeta.values()];
  // INSERT: no row to check; structural constraints enforced by SQLite.
  if (change.op === "insert") {
    const statement = buildMutationSql(table, change, ctx);
    const res = await client.query(statement.sql, boundParams(statement));
    const after = withWireDates(await readBack(client, table, res.rows[0], ctx), columns);
    return { op: "insert", pk: pickPk(after, ctx.primaryKey), after };
  }

  // UPDATE / DELETE: verify the row's version, then mutate. The transaction
  // holds the write lock, so nothing changes the row in between.
  const tbl = quoteIdent(table);
  // validateChange required every primary-key column in `pk`.
  const lock: Pick<MutationSql, "params" | "storages"> = { params: [], storages: [] };
  const pkWhere = primaryKeyWhere(change.pk ?? {}, ctx, lock);

  const cur = await client.query<{ __xmin: unknown }>(
    `SELECT ${rowVersionSql(columns)} AS __xmin FROM ${tbl} WHERE ${pkWhere}`,
    boundParams({ sql: "", ...lock }),
  );
  const current = cur.rows[0];
  if (!current) {
    throw new ConflictError(
      "Row no longer exists — it was deleted since you loaded it",
      {
        details: { table, pk: change.pk, index: ctx.index },
      },
    );
  }
  if (
    change.xmin !== undefined &&
    xminText(change.xmin) !== rowVersionToken(current.__xmin)
  ) {
    throw new ConflictError(
      "Row changed since it was loaded — refresh and retry",
      {
        details: { table, pk: change.pk, index: ctx.index },
      },
    );
  }

  const statement = buildMutationSql(table, change, ctx);
  const res = await client.query(statement.sql, boundParams(statement));

  if (change.op === "delete") {
    return { op: "delete", pk: change.pk };
  }
  const after = withWireDates(await readBack(client, table, res.rows[0], ctx), columns);
  return { op: "update", pk: change.pk, after };
}

/**
 * Apply a batch of changes. With dryRun, returns the statements that *would*
 * run without touching the DB. Otherwise executes the whole batch in one
 * transaction (all-or-nothing) and logs each committed change.
 */
export async function applyMutations(
  table: string,
  changes: Change[],
  { dryRun = false }: { dryRun?: boolean } = {},
) {
  const { meta, storage } = await getTableInfo(table);
  const { table: safeTable, columns, primaryKey } = meta;
  if (primaryKey.length === 0) {
    throw new ValidationError(
      `Table "${table}" has no primary key and cannot be edited`,
    );
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new ValidationError("No changes provided");
  }

  const colMeta = new Map<string, ColumnMeta>(columns.map((c) => [c.name, c]));

  const statements = changes.map((change, index) => {
    const ctx = { colMeta, storage, primaryKey, index };
    validateChange(change, ctx);
    const { sql, params } = buildMutationSql(safeTable, change, ctx);
    return { op: change.op, sql, params, preview: renderPreview(sql, params) };
  });

  if (dryRun) {
    return {
      dryRun: true,
      count: statements.length,
      statements: statements.map(({ op, preview }) => ({ op, preview })),
    };
  }

  // PostgreSQL refused writes to a materialized view; their tables are refilled
  // from the ledger and stay read-only here.
  if (DERIVED_TABLES.has(safeTable)) {
    throw new ValidationError(
      `Table "${safeTable}" is derived from the ledger and cannot be edited`,
    );
  }

  const committed: Array<{ op: string; pk: Record<string, unknown> | undefined }> =
    [];
  try {
    const results = await withTransaction(async (client) => {
      // The editor deliberately bypasses account-domain validation, but it
      // still joins the graph-wide lock protocol before touching account rows.
      if (safeTable === "accounts") {
        await lockAccountFundingGraph((sql, params) =>
          client.query(sql, params),
        );
      }

      const applied: Array<{
        op: string;
        after: Record<string, unknown> | undefined;
      }> = [];
      for (const [index, change] of changes.entries()) {
        const ctx = { colMeta, storage, primaryKey, index };
        const result = await applyOne(client, safeTable, change, ctx);
        applied.push({ op: result.op, after: result.after });
        committed.push({ op: result.op, pk: result.pk });
      }
      return applied;
    });

    for (const change of committed) {
      logger.info("db-editor mutation committed", {
        table: safeTable,
        op: change.op,
        pk: change.pk,
      });
    }

    const refreshed = MATVIEW_BASE_TABLES.has(safeTable);
    if (refreshed) scheduleAggregationRefresh();

    return {
      dryRun: false,
      applied: results.length,
      results,
      refreshScheduled: refreshed,
    };
  } catch (err) {
    throw mapDbError(err, safeTable);
  }
}

// ── Error mapping ───────────────────────────────────────────────────────────

/**
 * Translate database error codes (the driver reports SQLite's errors as
 * PostgreSQL SQLSTATEs) into friendly, typed API errors so the UI can show
 * "Column X cannot be null" instead of an opaque code.
 *
 * @param error raw driver error — shape (code/detail/column/constraint) is upstream-defined.
 * @param table the edited table, when the error comes from a mutation
 * @returns the mapped AppError, or the original error when its code is unmapped
 */
function mapDbError(error: unknown, table?: string): unknown {
  if (error instanceof AppError) return error;

  const err = error as DbDriverError | null | undefined;
  const detail = err?.detail ? { dbDetail: err.detail } : undefined;
  switch (err?.code) {
    case "23502": // not_null_violation
      return new ValidationError(`Column "${err.column}" cannot be empty`, {
        details: detail,
      });
    case "23001": // restrict_violation (ON DELETE RESTRICT)
    case "23503": // foreign_key_violation
      return new ValidationError(
        "References a row that does not exist (foreign key)",
        {
          details: { constraint: err.constraint, ...detail },
        },
      );
    case "23505": // unique_violation
      return new ConflictError(
        "Duplicate value violates a uniqueness constraint",
        {
          details: { constraint: err.constraint, ...detail },
        },
      );
    case "23514": // check_violation
      return new ValidationError("Value violates a check constraint", {
        details: { constraint: err.constraint, ...detail },
      });
    case "22P02": // invalid_text_representation
    case "22003": // numeric_value_out_of_range
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow
      return new ValidationError(
        `Invalid value for column type: ${err.message}`,
      );
    case "42601": // syntax_error
    case "42703": // undefined_column
    case "42883": // undefined_function / operator
    case "42P01": // undefined_table
      // Never echo raw driver text back to the client: with identifiers
      // allowlisted these are unreachable in normal use, and leaking the
      // message hands schema/column names to a prober (data-protection policy,
      // docs/security/data-protection.md). Full detail still goes to the logs
      // via the caught error.
      return new ValidationError("Invalid query");
    case "42501": // insufficient_privilege
      return new ForbiddenError(
        "Insufficient database privileges for this operation",
      );
    case "25006": // read_only_sql_transaction
      return new ForbiddenError("Write attempted inside a read-only query");
    case "55P03": // lock_not_available: the wait for the write lock timed out
      // BEGIN IMMEDIATE is where every writer queues, including the funding-graph
      // writers of accounts; PostgreSQL answered a cancelled funding-graph lock
      // wait with this retryable 503 (src/lib/accountFundingGraphLock.ts).
      return new AppError(
        table === "accounts"
          ? "Account funding graph is busy; retry the request"
          : "Database is busy; retry the request",
        { status: 503, code: ApiErrorCode.SERVICE_UNAVAILABLE, cause: err },
      );
    case "57014": // query_canceled (statement timeout)
      return new AppError("Query timed out", {
        status: 504,
        code: "QUERY_TIMEOUT",
      });
    default:
      return err;
  }
}
