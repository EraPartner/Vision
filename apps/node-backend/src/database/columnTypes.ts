/**
 * Column types the generated database types import through
 * `.kysely-codegenrc.json` overrides (ADR-226). Reads return what
 * node-postgres returns; writes accept what the column accepts.
 */
import type { ColumnType } from "kysely";
import type { MoneyAmount } from "@vision/types/brands";

/** A NUMERIC money column: read as a branded decimal string. */
export type MoneyColumn = ColumnType<MoneyAmount, number | string, number | string>;
