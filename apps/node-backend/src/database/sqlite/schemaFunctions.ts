/**
 * SQL functions that belong to Vision's own tables (ADR-263).
 *
 * functions.ts holds the PostgreSQL built-ins the SQLite dialect needs. This
 * module holds the functions the PostgreSQL schema defined for its own
 * tables, ported as pure JavaScript, plus the error helper the baseline's
 * triggers use:
 *
 *   vision_raise(sqlstate, constraint, message)
 *       Throws a DatabaseError with that SQLSTATE. RAISE(ABORT, ...) takes
 *       only a string literal on SQLite 3.39, so a trigger whose PostgreSQL
 *       message held row values calls this instead.
 *   portfolio_cash_receipt(raw_data)
 *       The portfolioCashReceipt envelope of a source row's raw data, or NULL.
 *   normalize_portfolio_income_snapshot(snapshot)
 *       Drops income_recognition_role when it is 'standard' or absent.
 *   portfolio_income_transaction_snapshot(<22 columns>)
 *       PostgreSQL took a portfolio_transactions row. SQLite functions take
 *       scalars, so callers pass the columns of
 *       PORTFOLIO_INCOME_SNAPSHOT_COLUMNS in order;
 *       portfolioIncomeTransactionSnapshotSql(alias) writes that call.
 *
 * The jsonb results are canonical jsonb text (jsonb.ts), equal to
 * PostgreSQL's output for the same input. See
 * docs/reference/sqlite-sql-dialect.md.
 */
import type { DatabaseSync } from "node:sqlite";
import type { DatabaseError } from "./errors.ts";
import { JsonbError, compareJsonbKeys, formatJsonb, parseJsonb } from "./jsonb.ts";
import type { JsonbValue } from "./jsonb.ts";
import { formatDec, parseDecimalText } from "./numeric.ts";

const SQLSTATE = /^[0-9A-Z]{5}$/;

function databaseError(code: string, message: string, constraint?: string): DatabaseError {
  const err = new Error(message) as DatabaseError;
  err.name = "DatabaseError";
  err.code = code;
  if (constraint !== undefined && constraint !== "") err.constraint = constraint;
  return err;
}

function sqlText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  // SQLite hands a function only NULL, numbers, text and blobs.
  return Object.prototype.toString.call(value);
}

/** `RAISE EXCEPTION ... USING ERRCODE = sqlstate, CONSTRAINT = constraint`. */
export function visionRaise(sqlstate: unknown, constraint: unknown, message: unknown): never {
  const code = typeof sqlstate === "string" && SQLSTATE.test(sqlstate) ? sqlstate : "P0001";
  throw databaseError(code, sqlText(message) ?? "", sqlText(constraint) ?? undefined);
}

// ---- jsonb operators ---------------------------------------------------------

/** `value -> key` on an object; undefined for any other value or a missing key. */
function member(value: JsonbValue | undefined, key: string): JsonbValue | undefined {
  if (value?.type !== "object") return undefined;
  return value.entries.find(([k]) => k === key)?.[1];
}

/** `->>`: the text of a jsonb value; JSON null and a missing value are NULL. */
function asText(value: JsonbValue | undefined): string | null {
  if (value === undefined) return null;
  switch (value.type) {
    case "null":
      return null;
    case "string":
      return value.value;
    case "number":
      return formatDec(value.value);
    case "bool":
      return value.value ? "true" : "false";
    default:
      return formatJsonb(value);
  }
}

/** `value - key`: removes an object key, or the array elements equal to the string. */
function deleteKey(value: JsonbValue, key: string): JsonbValue {
  if (value.type === "object") return { type: "object", entries: value.entries.filter(([k]) => k !== key) };
  if (value.type === "array") {
    return { type: "array", items: value.items.filter((item) => !(item.type === "string" && item.value === key)) };
  }
  throw databaseError("22023", "cannot delete from scalar");
}

function jsonbArg(value: unknown, fn: string): JsonbValue | null {
  const text = sqlText(value);
  if (text === null) return null;
  try {
    return parseJsonb(text);
  } catch (err) {
    if (err instanceof JsonbError) throw databaseError(err.code, err.message);
    throw new Error(`${fn}: ${String(err)}`, { cause: err });
  }
}

// ---- portfolio_cash_receipt ---------------------------------------------------

/**
 * PostgreSQL's portfolio_cash_receipt(text): text that is not JSON gives NULL
 * (the function caught invalid_text_representation); a \u0000 escape or a
 * number out of numeric range still fails, as there.
 */
export function portfolioCashReceipt(data: unknown): string | null {
  const text = sqlText(data);
  if (text === null) return null;
  let envelope: JsonbValue;
  try {
    envelope = parseJsonb(text);
  } catch (err) {
    if (err instanceof JsonbError) {
      if (err.code === "22P02") return null;
      throw databaseError(err.code, err.message);
    }
    throw err;
  }
  const receipt = member(envelope, "portfolioCashReceipt");
  if (receipt === undefined) return null;
  if (asText(member(receipt, "version")) !== "1") return null;
  if (asText(member(member(receipt, "proof"), "kind")) !== "closed_kinesis_cash") return null;
  if (member(receipt, "after")?.type !== "object") return null;
  return formatJsonb(receipt);
}

// ---- income snapshots ---------------------------------------------------------

const ROLE = "income_recognition_role";

function normalizeSnapshot(value: JsonbValue): JsonbValue {
  return (asText(member(value, ROLE)) ?? "standard") === "standard" ? deleteKey(value, ROLE) : value;
}

/** PostgreSQL's normalize_portfolio_income_snapshot(jsonb). */
export function normalizePortfolioIncomeSnapshot(data: unknown): string | null {
  const value = jsonbArg(data, "normalize_portfolio_income_snapshot");
  return value === null ? null : formatJsonb(normalizeSnapshot(value));
}

/** The portfolio_transactions columns portfolio_income_transaction_snapshot takes, in order. */
export const PORTFOLIO_INCOME_SNAPSHOT_COLUMNS = [
  "id",
  "investment_id",
  "type",
  "date",
  "amount",
  "units",
  "price_per_unit",
  "fees",
  "taxes",
  "currency",
  "fx_rate_to_eur",
  "account_id",
  "note",
  "dividend_amount_convention",
  "is_recurring",
  "recurrence_interval",
  "recurrence_end_date",
  "import_batch_id",
  "source_record_hash",
  "dedup_fingerprint",
  "dedup_fingerprint_version",
  "income_recognition_role",
] as const;

export type PortfolioIncomeSnapshotColumn = (typeof PORTFOLIO_INCOME_SNAPSHOT_COLUMNS)[number];

/**
 * How each column enters the snapshot: integers as JSON numbers, numerics
 * and import_batch_id as their text, dates as YYYY-MM-DD, booleans as JSON
 * booleans, text as strings.
 */
const SNAPSHOT_KINDS: Readonly<Record<PortfolioIncomeSnapshotColumn, "int" | "text" | "date" | "bool">> = {
  id: "int",
  investment_id: "int",
  type: "text",
  date: "date",
  amount: "text",
  units: "text",
  price_per_unit: "text",
  fees: "text",
  taxes: "text",
  currency: "text",
  fx_rate_to_eur: "text",
  account_id: "int",
  note: "text",
  dividend_amount_convention: "text",
  is_recurring: "bool",
  recurrence_interval: "text",
  recurrence_end_date: "date",
  import_batch_id: "text",
  source_record_hash: "text",
  dedup_fingerprint: "text",
  dedup_fingerprint_version: "int",
  income_recognition_role: "text",
};

/** `portfolio_income_transaction_snapshot(alias.id, alias.investment_id, ...)`. */
export function portfolioIncomeTransactionSnapshotSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`invalid table alias: ${alias}`);
  return `portfolio_income_transaction_snapshot(${PORTFOLIO_INCOME_SNAPSHOT_COLUMNS.map((c) => `${alias}.${c}`).join(", ")})`;
}

const NULL: JsonbValue = { type: "null" };

function snapshotValue(kind: "int" | "text" | "date" | "bool", value: unknown): JsonbValue {
  if (value === null || value === undefined) return NULL;
  switch (kind) {
    case "int":
      return { type: "number", value: parseDecimalText(sqlText(value) ?? "") };
    case "bool":
      return { type: "bool", value: value === 1 || value === 1n || value === true };
    case "date":
      // to_char(date, 'YYYY-MM-DD') prints a BC year without its suffix.
      return { type: "string", value: (sqlText(value) ?? "").replace(/ BC$/, "") };
    case "text":
      return { type: "string", value: sqlText(value) ?? "" };
  }
}

/** PostgreSQL's portfolio_income_transaction_snapshot(portfolio_transactions). */
export function portfolioIncomeTransactionSnapshot(...values: readonly unknown[]): string {
  if (values.length !== PORTFOLIO_INCOME_SNAPSHOT_COLUMNS.length) {
    throw databaseError(
      "42883",
      `portfolio_income_transaction_snapshot takes ${PORTFOLIO_INCOME_SNAPSHOT_COLUMNS.length} arguments, got ${values.length}`,
    );
  }
  const entries = PORTFOLIO_INCOME_SNAPSHOT_COLUMNS.map(
    (column, i) => [column, snapshotValue(SNAPSHOT_KINDS[column], values[i])] as const,
  ).sort((a, b) => compareJsonbKeys(a[0], b[0]));
  return formatJsonb(normalizeSnapshot({ type: "object", entries }));
}

// ---- registration ---------------------------------------------------------------

/**
 * Register the schema's functions on a connection, after registerFunctions()
 * and before the connection runs a migration or a statement.
 */
export function registerSchemaFunctions(db: DatabaseSync): void {
  const det = { deterministic: true } as const;
  // Not deterministic, so SQLite never evaluates it ahead of its WHERE clause.
  db.function("vision_raise", {}, (sqlstate: unknown, constraint: unknown, message: unknown) =>
    visionRaise(sqlstate, constraint, message),
  );
  db.function("portfolio_cash_receipt", det, (data: unknown) => portfolioCashReceipt(data));
  db.function("normalize_portfolio_income_snapshot", det, (data: unknown) => normalizePortfolioIncomeSnapshot(data));
  db.function("portfolio_income_transaction_snapshot", { deterministic: true, varargs: true }, (...values: unknown[]) =>
    portfolioIncomeTransactionSnapshot(...values),
  );
}
