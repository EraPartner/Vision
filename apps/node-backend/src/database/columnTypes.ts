/**
 * Column types the generated database types import through
 * `db-codegen.config.json` overrides (ADR-226, ADR-263). Reads return what
 * the SQLite driver returns (the shapes node-postgres returned); writes
 * accept what the column accepts.
 */
import type { ColumnType } from "kysely";
import type { MoneyAmount } from "@vision/types/brands";

/** A NUMERIC money column: read as a branded decimal string. */
export type MoneyColumn = ColumnType<MoneyAmount, number | string, number | string>;
