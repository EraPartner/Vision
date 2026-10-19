/** Parameterized SQL writes for portfolio transactions. */

import { sql } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { PortfolioTxnType } from "../database/schema.generated.ts";
import {
  portfolioTransactionDbRowSchema,
  portfolioTransactionKeyRowSchema,
} from "../database/rows/portfolio.ts";
import { mapPortfolioTxRow } from "./portfolioTxRepo.reads.ts";
import { hasPortfolioTransactionImportBatchIdColumn } from "./portfolioTxRepo.common.ts";

import type { PortfolioTransactionRow } from "../types/rows.ts";
import type {
  AccountId,
  CurrencyCode,
  InvestmentId,
  PortfolioTransactionId,
} from "@vision/types/brands";

export type { PortfolioTransactionRow };

/**
 * The insertable fields of a portfolio transaction (structurally the
 * `PortfolioTransactionInput` typedef of services/portfolio/portfolioTransactionRules.js).
 */
export interface PortfolioTransactionInput {
  investment_id: InvestmentId;
  type: string;
  /** 'YYYY-MM-DD' */
  date: string;
  amount?: number | string | undefined;
  units?: number | string | null | undefined;
  price_per_unit?: number | string | null | undefined;
  fees?: number | string | null | undefined;
  taxes?: number | string | null | undefined;
  dividend_amount_convention?: "gross" | "net" | "unknown" | undefined;
  currency?: CurrencyCode | undefined;
  note?: string | null | undefined;
  is_recurring?: boolean | undefined;
  recurrence_interval?: string | null | undefined;
  recurrence_end_date?: string | null | undefined;
  fx_rate_to_eur?: number | string | null | undefined;
  account_id?: AccountId | null | undefined;
  /** Set only by the import commit path; NULL for manual entry. */
  import_batch_id?: number | string | null | undefined;
  source_record_hash?: string | null | undefined;
  dedup_fingerprint?: string | null | undefined;
  dedup_fingerprint_version?: number | null | undefined;
}

export async function insert(
  payload: PortfolioTransactionInput,
): Promise<PortfolioTransactionRow | null> {
  const withImportBatch =
    payload.import_batch_id != null &&
    (await hasPortfolioTransactionImportBatchIdColumn());
  const row = await checkedRow(
    portfolioTransactionDbRowSchema,
    db
      .insertInto("portfolio_transactions")
      .values({
        investment_id: payload.investment_id,
        // The enum column rejects an unknown type; NOT NULL rejects a missing
        // amount or currency (an explicit NULL skips the currency default).
        type: sql<PortfolioTxnType>`${payload.type}`,
        date: payload.date,
        amount: sql<string>`${payload.amount ?? null}`,
        units: payload.units ?? null,
        price_per_unit: payload.price_per_unit ?? null,
        fees: payload.fees ?? 0,
        taxes: payload.taxes ?? 0,
        dividend_amount_convention:
          payload.dividend_amount_convention ?? "unknown",
        currency: sql<CurrencyCode>`${payload.currency ?? null}`,
        note: payload.note || null,
        is_recurring: payload.is_recurring || false,
        recurrence_interval: payload.recurrence_interval || null,
        recurrence_end_date: payload.recurrence_end_date || null,
        fx_rate_to_eur: payload.fx_rate_to_eur ?? null,
        account_id: payload.account_id ?? null,
        ...(withImportBatch && { import_batch_id: payload.import_batch_id }),
        ...(payload.dedup_fingerprint && {
          source_record_hash: payload.source_record_hash ?? null,
          dedup_fingerprint: payload.dedup_fingerprint,
          dedup_fingerprint_version: payload.dedup_fingerprint_version ?? null,
        }),
      })
      .onConflict((oc) => oc.doNothing())
      .returningAll(),
  );
  return row ? mapPortfolioTxRow(row) : null;
}

export async function updateFields(
  id: PortfolioTransactionId,
  fields: Record<string, unknown>,
  unchanged: PortfolioTransactionRow | null = null,
): Promise<PortfolioTransactionRow | null> {
  const allowed = [
    "date",
    "amount",
    "units",
    "price_per_unit",
    "fees",
    "taxes",
    "dividend_amount_convention",
    "currency",
    "note",
    "is_recurring",
    "recurrence_interval",
    "recurrence_end_date",
    "fx_rate_to_eur",
    "account_id",
  ];
  // undefined fields are skipped; `allowed` whitelists the column names.
  const clauses = Object.entries(fields)
    .filter(([key, value]) => value !== undefined && allowed.includes(key))
    .map(([key, value]) => sql`${sql.ref(key)} = ${value}`);
  if (clauses.length === 0) return unchanged;
  const row = await checkedRow(
    portfolioTransactionDbRowSchema,
    sql`UPDATE portfolio_transactions SET ${sql.join(clauses)} WHERE id = ${id} RETURNING *`,
  );
  return row ? mapPortfolioTxRow(row) : null;
}

export async function hardDelete(
  id: PortfolioTransactionId,
): Promise<boolean> {
  const result = await db
    .deleteFrom("portfolio_transactions")
    .where("id", "=", id)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}

export async function hardDeleteByImportBatch(
  batchId: number | string,
): Promise<PortfolioTransactionId[]> {
  if (!(await hasPortfolioTransactionImportBatchIdColumn())) return [];
  const rows = await checkedRows(
    portfolioTransactionKeyRowSchema,
    db
      .deleteFrom("portfolio_transactions")
      .where("import_batch_id", "=", String(batchId))
      .returning("id"),
  );
  return rows.map((row) => row.id);
}

export async function repointAccount(
  targetId: AccountId,
  sourceIds: AccountId[],
): Promise<number> {
  const result = await db
    .updateTable("portfolio_transactions")
    .set({ account_id: targetId })
    .where("account_id", "=", sql<AccountId>`ANY(${sourceIds}::int[])`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
