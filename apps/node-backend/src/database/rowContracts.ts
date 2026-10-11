/**
 * Runtime contracts for rows coming back from PostgreSQL (ADR-193).
 *
 * `query<R>()` trusts its generic; these helpers check each row against a zod
 * schema that describes what node-postgres ACTUALLY returns with its default
 * type parsers (NUMERIC/BIGINT/COUNT(*) as strings, DATE/TIMESTAMPTZ as
 * `Date`, see src/types/rows.ts). No global type parsers are installed and
 * rows are never rewritten: a schema only checks, and the caller receives the
 * exact objects pg produced (extra columns included).
 *
 * A mismatch is a bug in Vision, not bad input, so it is never a 400. Tests
 * and development throw; other environments follow the shared ADR-193
 * switch (see `dataContractMode` in lib/dataContract.ts).
 * Messages carry column paths and type names only, never row values, which
 * are personal financial data.
 */
import { z } from "zod";
import { logger } from "../config/logger.ts";
import { dataContractMode } from "../lib/dataContract.ts";
import type { DataContractMode } from "../lib/dataContract.ts";
import { query } from "./connection.ts";
import type { QueryRunner } from "../types/rows.ts";

/** `throw` rejects the rows; `log` warns and passes them through unchanged. */
export type RowContractMode = DataContractMode;

/** Thrown in `throw` mode. A plain 500 through the error handler. */
export class RowContractError extends Error {
  /** `path: problem` strings; never contain row values. */
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "RowContractError";
    this.issues = issues;
  }
}

/**
 * A schema whose output is its input: rows are checked, never transformed, so
 * the static type stays true for the pass-through objects. Coercions and
 * transforms are rejected at compile time.
 */
export type RowSchema<T> = z.ZodType<T, T>;

/** Type name of a value, for messages that must not echo the value itself. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Formats one issue as `path: problem`, from schema facts and type names only. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length ? issue.path.join(".") : "(row)";
  switch (issue.code) {
    case "invalid_type":
      return `${path}: expected ${issue.expected}, received ${describeType(issue.input)}`;
    case "invalid_value":
      return `${path}: expected one of ${issue.values.map(String).join("|")}`;
    case "unrecognized_keys":
      return `${path}: unrecognized keys ${issue.keys.join(", ")}`;
    default:
      return `${path}: ${issue.code}`;
  }
}

/** Short label for a query: the schema's description, else its SQL head. */
function labelFor(schema: z.ZodType, text?: string): string {
  if (schema.description) return schema.description;
  if (!text) return "row";
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * Check `rows` against `schema` and return them unchanged. Stops at the first
 * failing row so a systematic mismatch costs one error, not one per row.
 *
 * @param label names the query in messages (defaults to the schema description)
 * @param mode defaults to `dataContractMode()`
 */
export function checkRows<T>(
  schema: RowSchema<T>,
  rows: readonly unknown[],
  {
    label,
    mode = dataContractMode(),
  }: { label?: string; mode?: RowContractMode } = {},
): T[] {
  for (let i = 0; i < rows.length; i++) {
    if (schema.safeParse(rows[i]).success) continue;
    // Re-parse only on failure: `reportInput` lets describeIssue name the
    // received type without paying for it on every valid row.
    const failed = schema.safeParse(rows[i], { reportInput: true });
    const issues = failed.success ? [] : failed.error.issues.map(describeIssue);
    const message =
      `Row contract violated (${label ?? labelFor(schema)}) at row ${i + 1} of ${rows.length}: ` +
      issues.join("; ");
    if (mode === "throw") throw new RowContractError(message, issues);
    logger.warn(message);
    break;
  }
  return rows as T[];
}

/**
 * Run a query (on `client` when given, else the ambient-aware pool `query`)
 * and check every row against `schema`.
 */
export async function queryRows<T>(
  schema: RowSchema<T>,
  text: string,
  params?: readonly unknown[],
  client?: QueryRunner,
): Promise<T[]> {
  const result = client
    ? await client.query(text, params as unknown[] | undefined)
    : await query(text, params);
  return checkRows(schema, result.rows, { label: labelFor(schema, text) });
}

/** {@link queryRows} for at most one row: the first row, or `undefined`. */
export async function queryOne<T>(
  schema: RowSchema<T>,
  text: string,
  params?: readonly unknown[],
  client?: QueryRunner,
): Promise<T | undefined> {
  const rows = await queryRows(schema, text, params, client);
  return rows[0];
}

/**
 * The single row an INSERT ... RETURNING (or another always-one-row query)
 * produced. A missing row is an internal fault, not a "not found".
 */
export function requireRow<T>(row: T | undefined, label: string): T {
  if (row === undefined) throw new Error(`Expected a row from ${label}`);
  return row;
}
