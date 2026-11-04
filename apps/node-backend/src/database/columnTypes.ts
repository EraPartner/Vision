/**
 * Column types the generated database types import through
 * `db-codegen.config.json` overrides (ADR-226, ADR-263). Reads return what
 * the SQLite driver returns (the shapes node-postgres returned); writes
 * accept what the column accepts.
 */
import type { ColumnType } from "kysely";
import type { MoneyAmount } from "@vision/types/brands";

/**
 * A NUMERIC money column: read as a branded decimal string, written as
 * decimal text. A JavaScript number is not accepted directly, so a binary
 * float never reaches a money column unnoticed; convert it with
 * {@link decimalText} where a number is genuinely the source.
 */
export type MoneyColumn = ColumnType<MoneyAmount, string, string>;

/**
 * Decimal text for a value written to a money column: a number becomes its
 * shortest round-trip text (String(n), what the write plugin parsed before),
 * which the plugin then rounds to the column's scale. Text passes through.
 */
export function decimalText(value: number | string): string {
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) throw new RangeError(`not a finite amount: ${String(value)}`);
  return String(value);
}
