/**
 * The analysis SQL sandbox (ADR-263). analysisExecutor.ts runs this module as
 * a child process for one statement, with the flag `--vision-analysis-sandbox`
 * and an environment that holds only the time zone. The packaged app runs the
 * bundled copy, `tools/analysis-sandbox.js`, through the backend executable
 * as Bun (BUN_BE_BUN=1).
 *
 * The process reads one request as JSON from stdin and writes its messages as
 * JSON lines to stdout. It builds a fresh in-memory SQLite database. An
 * attached in-memory database named `vision_analysis` holds the rows the
 * executor copied from the approved `vision_analysis_*` views, as views with
 * the PostgreSQL names, so `vision_analysis.transactions_v2` resolves as it did
 * before. It then turns `query_only` on and runs the user's statement, which
 * must be one SELECT, WITH or VALUES statement. The process receives rows, not
 * a path: it never opens or attaches a file, and it imports nothing that reads
 * the configuration or the environment.
 *
 * The statement limit is enforced twice. Inside, every copied row passes
 * vision_sandbox_tick() and every Vision SQL function checks the deadline, and
 * either one throws SQLSTATE 57014 once it has passed. Outside, the executor
 * kills the process (SIGKILL) shortly after the deadline, which also stops a
 * statement that loops inside SQLite without reading a copied row or calling
 * a function (a recursive CTE over constants, a cross join of materialized
 * CTEs). Memory has no separate cap beyond the statement limit: the SQLite
 * builds tested (Node 22's and Bun 1.4's, on Linux) ignore
 * `PRAGMA hard_heap_limit`. Under Node the JavaScript heap is capped too.
 */
import { DatabaseSync } from "node:sqlite";
import type {
  AggregateOptions,
  FunctionOptions,
  SQLInputValue,
  StatementSync,
} from "node:sqlite";
import { translateSqliteError } from "../database/sqlite/errors.ts";
import { registerFunctions } from "../database/sqlite/functions.ts";
import type { ConnectionClock } from "../database/sqlite/functions.ts";
import { instantFromDate, isDateText } from "../database/sqlite/timestamps.ts";
import { scanSql } from "../database/sqlite/sqlText.ts";

/** A value copied from a view or bound as a parameter. */
export type SandboxValue = null | number | bigint | string;

/**
 * What a column holds. It decides the result column type and how a value is
 * returned: "bigint" is an integer returned as decimal text (node-postgres's
 * int8), "datetime" an ISO string, "json" and the arrays parsed values.
 */
export type SandboxKind =
  | "boolean"
  | "integer"
  | "bigint"
  | "decimal"
  | "date"
  | "datetime"
  | "json"
  | "string[]"
  | "integer[]"
  | "string";

export interface SandboxColumn {
  name: string;
  /** The declared type of the copy's column (the view column's, or its documented type). */
  declaredType: string;
  /** Null for a column with no known type: the worker infers it from the values. */
  kind: SandboxKind | null;
}

export interface SandboxTable {
  /** The view name inside `vision_analysis`, for example `transactions_v2`. */
  view: string;
  columns: SandboxColumn[];
  rows: SandboxValue[][];
}

export interface SandboxRequest {
  sql: string;
  params: SandboxValue[];
  limit: number;
  offset: number;
  statementTimeoutMs: number;
  /** The request's start; now() and today() read it, as PostgreSQL's now() read the transaction start. */
  startedAt: string;
  tables: SandboxTable[];
}

export interface SandboxResultColumn {
  id: string;
  type: string;
}

export type SandboxMessage =
  | { kind: "ready" }
  | {
      kind: "result";
      columns: SandboxResultColumn[];
      rows: Array<Record<string, unknown>>;
      hasMore: boolean;
      /** Row values JSON cannot carry: [row, column id, "Infinity" | "-Infinity" | "NaN"]. */
      special?: Array<[number, string, string]>;
    }
  | { kind: "error"; message: string; code: string | undefined };

const READ_STATEMENTS = new Set(["SELECT", "WITH", "VALUES"]);
const SQLITE_NOMEM = 7;
const SQLITE_READONLY = 8;
/** The command-line flag that makes this module serve one request. */
export const SANDBOX_FLAG = "--vision-analysis-sandbox";
const CANONICAL_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;
const HINT = /::(bool|json|timestamptz|date|bigint|text)$/;
const HINT_KIND: Record<string, SandboxKind> = {
  bool: "boolean",
  json: "json",
  timestamptz: "datetime",
  date: "date",
  bigint: "bigint",
  text: "string",
};

class SandboxError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The table that holds a view's copied rows; the view reads it. */
function rowsTable(view: string): string {
  return `vision_rows_${view}`;
}

/**
 * A DatabaseSync stand-in for registerFunctions(): it registers on `db`, but
 * every function and aggregate callback checks the deadline first.
 */
function guardedRegistrar(db: DatabaseSync, check: () => void): DatabaseSync {
  const guard = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const guarded = (...args: A): R => {
      check();
      return fn(...args);
    };
    // node:sqlite takes a function's SQL arity from its length.
    Object.defineProperty(guarded, "length", { value: fn.length });
    return guarded;
  };
  const registrar = {
    function(
      name: string,
      optionsOrFn: FunctionOptions | ((...args: SQLInputValue[]) => SQLInputValue),
      maybeFn?: (...args: SQLInputValue[]) => SQLInputValue,
    ) {
      if (typeof optionsOrFn === "function") {
        db.function(name, guard(optionsOrFn));
      } else if (maybeFn) {
        db.function(name, optionsOrFn, guard(maybeFn));
      }
    },
    aggregate(name: string, options: AggregateOptions) {
      // node:sqlite's typings narrow the callbacks; the guard keeps their signatures.
      const wrapped = { ...options } as unknown as Record<string, unknown>;
      for (const key of ["step", "inverse", "result"]) {
        const callback = wrapped[key];
        if (typeof callback === "function")
          wrapped[key] = guard(callback as (...args: unknown[]) => unknown);
      }
      db.aggregate(name, wrapped as unknown as AggregateOptions);
    },
    prepare(text: string): StatementSync {
      return db.prepare(text);
    },
  };
  // registerFunctions() uses only function(), aggregate() and prepare().
  return registrar as unknown as DatabaseSync;
}

function createCopies(db: DatabaseSync, tables: SandboxTable[]): void {
  db.exec("ATTACH DATABASE ':memory:' AS vision_analysis");
  for (const table of tables) {
    const target = `vision_analysis.${quoteIdent(rowsTable(table.view))}`;
    const columns = table.columns.map((column) => quoteIdent(column.name));
    db.exec(
      `CREATE TABLE ${target} (${table.columns
        .map((column) => `${quoteIdent(column.name)} ${column.declaredType}`)
        .join(", ")})`,
    );
    const insert = db.prepare(
      `INSERT INTO ${target} VALUES (${columns.map((_, i) => `?${i + 1}`).join(", ")})`,
    );
    db.exec("BEGIN");
    for (const row of table.rows) insert.run(...row);
    db.exec("COMMIT");
    // rowid makes the tick a per-row term, so a scan of the copy checks the deadline.
    db.exec(
      // sql-dialect-ok: vision_sandbox_tick() is registered by this worker on its own in-memory sandbox database (the statement deadline check), not on Vision connections
      `CREATE VIEW vision_analysis.${quoteIdent(table.view)} AS SELECT ${columns.join(", ")} FROM ${quoteIdent(rowsTable(table.view))} WHERE vision_sandbox_tick(rowid)`,
    );
  }
}

/** True when `rest` holds only whitespace and comments. */
function isBlank(rest: string): boolean {
  return rest.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, "").trim() === "";
}

function prepareStatement(db: DatabaseSync, sql: string): StatementSync {
  const scanned = scanSql(sql);
  if (!READ_STATEMENTS.has(scanned.firstKeyword))
    throw new SandboxError("Only SELECT queries are allowed", "42501");
  if (scanned.multipleStatements)
    throw new SandboxError("Exactly one SQL statement is allowed", "42601");
  const statement = db.prepare(scanned.text);
  // prepare() compiles the first statement and ignores the rest of the text.
  const consumed = statement.sourceSQL;
  if (
    !scanned.text.startsWith(consumed) ||
    !isBlank(scanned.text.slice(consumed.length))
  )
    throw new SandboxError("Exactly one SQL statement is allowed", "42601");
  return statement;
}

function columnKinds(
  statement: StatementSync,
  tables: SandboxTable[],
): Array<{ id: string; kind: SandboxKind | null }> {
  const byOrigin = new Map<string, SandboxKind>();
  for (const table of tables)
    for (const column of table.columns)
      if (column.kind)
        byOrigin.set(`${rowsTable(table.view)}\0${column.name}`, column.kind);
  return statement.columns().map((column) => {
    const hint = HINT.exec(column.name);
    if (hint)
      return {
        id: column.name.slice(0, column.name.length - hint[0].length),
        kind: HINT_KIND[hint[1] ?? "text"] ?? "string",
      };
    const origin =
      column.table !== null && column.column !== null
        ? byOrigin.get(`${column.table}\0${column.column}`)
        : undefined;
    return { id: column.name, kind: origin ?? null };
  });
}

/** An integer as a number when it is exact, otherwise as decimal text. */
function integerValue(value: bigint): number | string {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
}

/** The kind of an expression column, from the values on this page. */
function inferKind(values: unknown[]): SandboxKind {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return "string";
  if (present.every((value) => typeof value === "bigint")) return "integer";
  if (present.every((value) => typeof value === "bigint" || typeof value === "number"))
    return "decimal";
  const strings = present.filter((value) => typeof value === "string");
  if (strings.length !== present.length) return "string";
  if (strings.every((value) => isDateText(value))) return "date";
  if (strings.every((value) => CANONICAL_TIMESTAMP.test(value))) return "datetime";
  if (strings.every((value) => DECIMAL_TEXT.test(value)))
    return strings.some((value) => value.includes(".")) ? "decimal" : "integer";
  return "string";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** One value as the API returns it for a column of `kind`. */
function outputValue(value: unknown, kind: SandboxKind): unknown {
  if (value === null || value === undefined) return null;
  // Blobs are not returned, as before.
  if (value instanceof Uint8Array) return undefined;
  switch (kind) {
    case "boolean":
      if (value === 1n || value === 1) return true;
      if (value === 0n || value === 0) return false;
      break;
    case "bigint":
      if (typeof value === "bigint" || typeof value === "number") return String(value);
      break;
    case "datetime":
      if (typeof value === "string") {
        const match = CANONICAL_TIMESTAMP.exec(value);
        if (match) return `${match[1]}Z`;
        const ms = Date.parse(value);
        if (!Number.isNaN(ms)) return new Date(ms).toISOString();
      }
      break;
    case "json":
    case "string[]":
    case "integer[]":
      if (typeof value === "string") return parseJson(value);
      break;
    default:
      break;
  }
  return typeof value === "bigint" ? integerValue(value) : value;
}

function bindValue(value: SandboxValue): SandboxValue {
  // node:sqlite binds every JavaScript number as a REAL; a whole number binds as an INTEGER, as PostgreSQL typed it.
  return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
}

function runStatement(
  db: DatabaseSync,
  request: SandboxRequest,
): Extract<SandboxMessage, { kind: "result" }> {
  const statement = prepareStatement(db, request.sql);
  const planned = columnKinds(statement, request.tables);
  statement.setReturnArrays(true);
  statement.setReadBigInts(true);
  const raw: unknown[][] = [];
  let seen = 0;
  for (const row of statement.iterate(...request.params.map(bindValue))) {
    seen += 1;
    if (seen <= request.offset) continue;
    raw.push(row as unknown as unknown[]);
    if (raw.length > request.limit) break;
  }
  const hasMore = raw.length > request.limit;
  const page = raw.slice(0, request.limit);
  const kinds = planned.map(
    (column, index) => column.kind ?? inferKind(page.map((row) => row[index])),
  );
  const rows = page.map((values) => {
    const row: Record<string, unknown> = {};
    // A repeated column name keeps its last value, as node-postgres did.
    for (const [index, column] of planned.entries())
      row[column.id] = outputValue(values[index], kinds[index] ?? "string");
    return row;
  });
  return {
    kind: "result",
    columns: planned.map((column, index) => ({
      id: column.id,
      type: kinds[index] === "bigint" ? "integer" : (kinds[index] ?? "string"),
    })),
    rows,
    hasMore,
  };
}

/** The message for a failed statement: a SQLSTATE where one applies. */
function failure(caught: unknown): Extract<SandboxMessage, { kind: "error" }> {
  if (caught instanceof SandboxError)
    return { kind: "error", message: caught.message, code: caught.code };
  const errcode =
    typeof caught === "object" && caught !== null && "errcode" in caught
      ? caught.errcode
      : undefined;
  const translated = translateSqliteError(caught);
  const message = translated instanceof Error ? translated.message : String(translated);
  const code =
    typeof translated === "object" && translated !== null && "code" in translated
      ? translated.code
      : undefined;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
    return { kind: "error", message, code };
  // PostgreSQL's errors for a write in a read-only transaction and for unfinished SQL.
  if (errcode === SQLITE_READONLY) return { kind: "error", message, code: "25006" };
  if (errcode === SQLITE_NOMEM) return { kind: "error", message: "out of memory", code: "53200" };
  if (/incomplete input/.test(message)) return { kind: "error", message, code: "42601" };
  return { kind: "error", message, code: undefined };
}

function main(request: SandboxRequest, post: (message: SandboxMessage) => void): void {
  const db = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: false });
  const clock: ConnectionClock = {
    transactionStart: instantFromDate(new Date(request.startedAt)),
    statementStart: null,
  };
  let deadline = Number.POSITIVE_INFINITY;
  const check = () => {
    if (performance.now() > deadline)
      throw new SandboxError("canceling statement due to statement timeout", "57014");
  };
  try {
    registerFunctions(guardedRegistrar(db, check), clock);
    db.function("vision_sandbox_tick", (rowid: SQLInputValue) => {
      check();
      return rowid === null ? 0 : 1;
    });
    // The copies' views call vision_sandbox_tick().
    db.exec("PRAGMA trusted_schema = ON");
    createCopies(db, request.tables);
    db.exec("PRAGMA query_only = ON");
  } catch (caught) {
    db.close();
    post({
      kind: "error",
      message: `The analysis sandbox could not be prepared: ${caught instanceof Error ? caught.message : String(caught)}`,
      code: "XX000",
    });
    return;
  }
  post({ kind: "ready" });
  deadline = performance.now() + request.statementTimeoutMs;
  try {
    post(runStatement(db, request));
  } catch (caught) {
    post(failure(caught));
  } finally {
    db.close();
  }
}

/** Non-finite numbers in a result, which JSON would turn into null. */
function withSpecialNumbers(message: SandboxMessage): SandboxMessage {
  if (message.kind !== "result") return message;
  const special: Array<[number, string, string]> = [];
  message.rows.forEach((row, index) => {
    for (const [key, value] of Object.entries(row))
      if (typeof value === "number" && !Number.isFinite(value))
        special.push([index, key, String(value)]);
  });
  return special.length > 0 ? { ...message, special } : message;
}

/** A request value: bigints travel as {"$bigint": "..."}, non-finite numbers as {"$number": "..."}. */
export function encodeRequest(request: SandboxRequest): string {
  return JSON.stringify(request, (_key, value: unknown) => {
    if (typeof value === "bigint") return { $bigint: value.toString() };
    if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
    return value;
  });
}

function decodeRequest(text: string): SandboxRequest {
  // Request values are scalars, so an object with one of these keys is always a tag.
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const tagged = value as { $bigint?: unknown; $number?: unknown };
      if (typeof tagged.$bigint === "string") return BigInt(tagged.$bigint);
      if (typeof tagged.$number === "string") return Number(tagged.$number);
    }
    return value;
  }) as SandboxRequest;
}

async function serve(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const request = decodeRequest(Buffer.concat(chunks).toString("utf8"));
  main(request, (message) => {
    process.stdout.write(`${JSON.stringify(withSpecialNumbers(message))}\n`);
  });
}

if (process.argv.includes(SANDBOX_FLAG)) void serve();
