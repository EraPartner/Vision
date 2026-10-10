/** Parameterized SQL writes for portfolio transactions. */

import { query } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
import {
  portfolioIntIdRowSchema,
  portfolioTransactionDbRowSchema,
} from "../database/rows/portfolio.ts";
import { buildSetClauses } from "../lib/sqlClauses.ts";
import { mapPortfolioTxRow } from "./portfolioTxRepo.reads.ts";
import { hasPortfolioTransactionImportBatchIdColumn } from "./portfolioTxRepo.common.ts";

import type { PortfolioTransactionRow } from "../types/rows.ts";

export type { PortfolioTransactionRow };

/**
 * The insertable fields of a portfolio transaction (structurally the
 * `PortfolioTransactionInput` typedef of services/portfolio/portfolioTransactionRules.js).
 */
export interface PortfolioTransactionInput {
  investment_id: number;
  type: string;
  /** 'YYYY-MM-DD' */
  date: string;
  amount?: number | string;
  units?: number | string | null;
  price_per_unit?: number | string | null;
  fees?: number | string | null;
  taxes?: number | string | null;
  dividend_amount_convention?: "gross" | "net" | "unknown";
  currency?: string;
  note?: string | null;
  is_recurring?: boolean;
  recurrence_interval?: string | null;
  recurrence_end_date?: string | null;
  fx_rate_to_eur?: number | string | null;
  account_id?: number | null;
  /** Set only by the import commit path; NULL for manual entry. */
  import_batch_id?: number | string | null;
  source_record_hash?: string | null;
  dedup_fingerprint?: string | null;
  dedup_fingerprint_version?: number | null;
}

export async function insert(
  payload: PortfolioTransactionInput,
): Promise<PortfolioTransactionRow | null> {
  const columns = [
    "investment_id",
    "type",
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
  const values: unknown[] = [
    payload.investment_id,
    payload.type,
    payload.date,
    payload.amount,
    payload.units ?? null,
    payload.price_per_unit ?? null,
    payload.fees ?? 0,
    payload.taxes ?? 0,
    payload.dividend_amount_convention ?? "unknown",
    payload.currency,
    payload.note || null,
    payload.is_recurring || false,
    payload.recurrence_interval || null,
    payload.recurrence_end_date || null,
    payload.fx_rate_to_eur ?? null,
    payload.account_id ?? null,
  ];
  if (
    payload.import_batch_id != null &&
    (await hasPortfolioTransactionImportBatchIdColumn())
  ) {
    columns.push("import_batch_id");
    values.push(payload.import_batch_id);
  }
  if (payload.dedup_fingerprint) {
    columns.push(
      "source_record_hash",
      "dedup_fingerprint",
      "dedup_fingerprint_version",
    );
    values.push(
      payload.source_record_hash ?? null,
      payload.dedup_fingerprint,
      payload.dedup_fingerprint_version,
    );
  }
  const row = await queryOne(
    portfolioTransactionDbRowSchema,
    `INSERT INTO portfolio_transactions
       (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
       ON CONFLICT DO NOTHING
       RETURNING *`,
    values,
  );
  return row ? mapPortfolioTxRow(row) : null;
}

export async function updateFields(
  id: number,
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
  const { clauses, params, nextIdx } = buildSetClauses(fields, { allowed });
  if (clauses.length === 0) return unchanged;
  params.push(id);
  const row = await queryOne(
    portfolioTransactionDbRowSchema,
    `UPDATE portfolio_transactions SET ${clauses.join(", ")} WHERE id = $${nextIdx} RETURNING *`,
    params,
  );
  return row ? mapPortfolioTxRow(row) : null;
}

export async function hardDelete(id: number): Promise<boolean> {
  const result = await query(
    "DELETE FROM portfolio_transactions WHERE id = $1",
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function hardDeleteByImportBatch(
  batchId: number | string,
): Promise<Array<number | string>> {
  if (!(await hasPortfolioTransactionImportBatchIdColumn())) return [];
  const rows = await queryRows(
    portfolioIntIdRowSchema,
    "DELETE FROM portfolio_transactions WHERE import_batch_id = $1 RETURNING id",
    [batchId],
  );
  return rows.map((row) => row.id);
}

export async function repointAccount(
  targetId: number,
  sourceIds: number[],
): Promise<number> {
  const result = await query(
    "UPDATE portfolio_transactions SET account_id = $1 WHERE account_id = ANY($2::int[])",
    [targetId, sourceIds],
  );
  return result.rowCount ?? 0;
}
