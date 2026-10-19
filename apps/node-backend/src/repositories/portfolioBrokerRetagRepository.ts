/**
 * Persistence for the audited portfolio broker re-tag operation.
 *
 * Every function runs on the ambient transaction connection (the `db` driver
 * routes through query()). The service wraps the complete compare-and-set
 * mutation in withTransaction().
 */

import { sql } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  historicalRateRowSchema,
  portfolioRetagAuditInsertedRowSchema,
  portfolioRetagAuditRowSchema,
  retagDestinationAccountRowSchema,
  retagLockedTransactionRowSchema,
  portfolioTransactionKeyRowSchema,
  retagTransactionEventRowSchema,
} from "../database/rows/portfolio.ts";
import type {
  AccountId,
  InvestmentId,
  PortfolioTransactionId,
} from "@vision/types/brands";
import type {
  HistoricalRateDbRow,
  PortfolioRetagAuditDbRow,
  RetagDestinationAccountRow,
  RetagLockedTransactionRow,
  RetagTransactionEventDbRow,
} from "../database/rows/portfolio.ts";
import { getUnitEventsForInvestment } from "./portfolioTxRepo.reads.ts";
import type { PortfolioUnitEventRow } from "./portfolioTxRepo.reads.ts";

/** BIGINT ids arrive from pg as strings. Derived from the checked row schema. */
export type PortfolioRetagAuditRow = PortfolioRetagAuditDbRow;

export type PortfolioRetagAuditInsert = Omit<
  PortfolioRetagAuditRow,
  "id" | "created_at"
>;

/** NUMERIC columns arrive from pg as strings. Derived from the checked row schema. */
export type RetagTransactionEventRow = RetagTransactionEventDbRow;

/**
 * A custody event (asset transfer or adjustment) carrying the investment-level
 * columns of one of that investment's transactions, when it has any.
 */
export type RetagCustodyEventRow = Partial<
  Omit<RetagTransactionEventRow, keyof PortfolioUnitEventRow>
> &
  PortfolioUnitEventRow & { investment_id: InvestmentId };

export async function lockPortfolioTransactionWrites(): Promise<void> {
  await sql`LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE`.execute(
    db,
  );
}

export async function getAuditByIdempotencyKey(
  idempotencyKey: string,
): Promise<PortfolioRetagAuditRow | undefined> {
  return checkedRow(
    portfolioRetagAuditRowSchema,
    db
      .selectFrom("portfolio_retag_audit")
      .select([
        "id",
        "idempotency_key",
        "request_fingerprint",
        "from_account_id",
        "to_account_id",
        "transaction_ids",
        "previous_assignments",
        "selected_count",
        "changed_count",
        "created_at",
      ])
      .where("idempotency_key", "=", idempotencyKey),
  );
}

export async function lockEligibleDestinationAccount(
  accountId: AccountId | null,
): Promise<RetagDestinationAccountRow | undefined> {
  if (accountId == null) return undefined;
  return checkedRow(
    retagDestinationAccountRowSchema,
    db
      .selectFrom("accounts")
      .select(["id", "name", "display_name", "type", "is_active"])
      .where("id", "=", accountId)
      .where("is_active", "=", true)
      .where("type", "in", ["brokerage", "crypto_exchange", "wallet"])
      .forUpdate(),
  );
}

export async function lockTransactions(
  transactionIds: PortfolioTransactionId[],
): Promise<RetagLockedTransactionRow[]> {
  return checkedRows(
    retagLockedTransactionRowSchema,
    db
      .selectFrom("portfolio_transactions")
      .select(["id", "investment_id", "account_id"])
      .where(sql<boolean>`id = ANY(${transactionIds}::int[])`)
      .orderBy("id", "asc")
      .forUpdate(),
  );
}

export async function getUnitEventsForInvestments(
  investmentIds: InvestmentId[],
): Promise<Array<RetagTransactionEventRow | RetagCustodyEventRow>> {
  const transactionRows = await checkedRows(
    retagTransactionEventRowSchema,
    sql`SELECT pt.id, pt.investment_id, pt.type,
            to_char(pt.date, 'YYYY-MM-DD') AS date,
            COALESCE(pt.amount, 0) AS amount,
            COALESCE(pt.units, 0) AS units,
            COALESCE(pt.fees, 0) AS fees,
            COALESCE(pt.taxes, 0) AS taxes,
            COALESCE(pt.currency, 'EUR') AS currency,
            pt.fx_rate_to_eur,
            CASE
              WHEN COALESCE(pt.currency, 'EUR') = 'EUR' THEN 1
              ELSE COALESCE(
                pt.fx_rate_to_eur,
                (SELECT er.rate_to_eur
                   FROM exchange_rates er
                  WHERE er.currency_code = pt.currency
                    AND er.rate_date <= pt.date
                  ORDER BY er.rate_date DESC
                  LIMIT 1)
              )
            END AS fx_multiplier_eur,
            pt.account_id,
            i.asset_class,
            COALESCE(i.current_price, 0) AS current_price,
            COALESCE(i.interest_rate, 0) AS interest_rate
       FROM portfolio_transactions pt
       JOIN investments i ON i.id = pt.investment_id
      WHERE pt.investment_id = ANY(${investmentIds}::int[])
      ORDER BY pt.investment_id ASC, pt.date ASC, pt.id ASC`,
  );
  const transfers: RetagCustodyEventRow[] = [];
  for (const investmentId of investmentIds) {
    const events = await getUnitEventsForInvestment(investmentId);
    const exemplar = transactionRows.find(
      (row) => Number(row.investment_id) === Number(investmentId),
    );
    for (const event of events.filter((row) =>
      ["asset_transfer", "asset_adjustment"].includes(row.type),
    ))
      transfers.push({ ...exemplar, ...event, investment_id: investmentId });
  }
  return [...transactionRows, ...transfers];
}

export async function getHistoricalRates(): Promise<HistoricalRateDbRow[]> {
  return checkedRows(
    historicalRateRowSchema,
    db
      .selectFrom("exchange_rates")
      .select([
        "currency_code",
        sql<string>`to_char(rate_date, 'YYYY-MM-DD')`.as("rate_date"),
        "rate_to_eur",
      ])
      .orderBy("currency_code", "asc")
      .orderBy("rate_date", "asc"),
  );
}

export async function compareAndSetAccount(
  transactionIds: PortfolioTransactionId[],
  fromAccountId: AccountId | null,
  toAccountId: AccountId | null,
): Promise<PortfolioTransactionId[]> {
  const rows = await checkedRows(
    portfolioTransactionKeyRowSchema,
    db
      .updateTable("portfolio_transactions")
      .set({ account_id: toAccountId })
      .where(sql<boolean>`id = ANY(${transactionIds}::int[])`)
      .where(sql<boolean>`account_id IS NOT DISTINCT FROM ${fromAccountId}`)
      .returning("id"),
  );
  return rows.map((row) => row.id);
}

export async function insertAudit(
  receipt: PortfolioRetagAuditInsert,
): Promise<PortfolioRetagAuditRow & { occurred_at: string }> {
  const row = await checkedRow(
    portfolioRetagAuditInsertedRowSchema,
    sql`INSERT INTO portfolio_retag_audit
       (idempotency_key, request_fingerprint, from_account_id, to_account_id,
        transaction_ids, previous_assignments, selected_count, changed_count)
     VALUES (${receipt.idempotency_key}, ${receipt.request_fingerprint},
             ${receipt.from_account_id}, ${receipt.to_account_id},
             ${JSON.stringify(receipt.transaction_ids)}::jsonb,
             ${JSON.stringify(receipt.previous_assignments)}::jsonb,
             ${receipt.selected_count}, ${receipt.changed_count})
     RETURNING id, idempotency_key, request_fingerprint, from_account_id,
               to_account_id, transaction_ids, previous_assignments,
               selected_count, changed_count, created_at,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at`,
  );
  // An INSERT ... RETURNING without ON CONFLICT returns its row or throws.
  if (!row) throw new Error("Re-tag audit insert returned no row");
  return row;
}

export default {
  lockPortfolioTransactionWrites,
  getAuditByIdempotencyKey,
  lockEligibleDestinationAccount,
  lockTransactions,
  getUnitEventsForInvestments,
  getHistoricalRates,
  compareAndSetAccount,
  insertAudit,
};
