/**
 * Persistence for the portfolio broker re-tag operation.
 *
 * Every function runs on the ambient transaction connection (the `db` driver
 * routes through query()). The service wraps the complete compare-and-set
 * mutation in withTransaction(), whose BEGIN IMMEDIATE on the single SQLite
 * writer replaces PostgreSQL's row and table locks (ADR-263): the reads below
 * cannot change before the update commits.
 */

import { sql } from "kysely";
import { __getAmbientTransactionClient } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  historicalRateRowSchema,
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
  RetagDestinationAccountRow,
  RetagLockedTransactionRow,
  RetagTransactionEventDbRow,
} from "../database/rows/portfolio.ts";
import { getUnitEventsForInvestment } from "./portfolioTxRepo.reads.ts";
import type { PortfolioUnitEventRow } from "./portfolioTxRepo.reads.ts";

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

/** A JSON array parameter for `IN (SELECT value FROM json_each(?))`. */
const inIds = <T extends number = number>(ids: readonly T[]) =>
  sql<T>`(SELECT value FROM json_each(${JSON.stringify(ids.map(Number))}))`;

/**
 * Stable portfolio history for the re-tag (ADR-263). PostgreSQL took a SHARE
 * ROW EXCLUSIVE table lock here. SQLite runs every write transaction with
 * BEGIN IMMEDIATE on the single writer connection, so the caller's
 * withTransaction() already excludes every concurrent write to
 * portfolio_transactions, portfolio_asset_transfers and
 * portfolio_asset_adjustments until it ends. Refuses to run outside one,
 * where that guarantee would not hold.
 */
export function lockPortfolioTransactionWrites(): Promise<void> {
  if (!__getAmbientTransactionClient())
    return Promise.reject(
      new Error("lockPortfolioTransactionWrites must run inside withTransaction()"),
    );
  return Promise.resolve();
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
      .where("type", "in", ["brokerage", "crypto_exchange", "wallet"]),
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
      .where("id", "in", inIds(transactionIds))
      .orderBy("id", "asc"),
  );
}

export async function getUnitEventsForInvestments(
  investmentIds: InvestmentId[],
): Promise<Array<RetagTransactionEventRow | RetagCustodyEventRow>> {
  const transactionRows = await checkedRows(
    retagTransactionEventRowSchema,
    sql`SELECT pt.id, pt.investment_id, pt.type,
            to_char(pt.date, 'YYYY-MM-DD') AS date,
            COALESCE(pt.amount, '0') AS amount,
            COALESCE(pt.units, '0') AS units,
            COALESCE(pt.fees, '0') AS fees,
            COALESCE(pt.taxes, '0') AS taxes,
            COALESCE(pt.currency, 'EUR') AS currency,
            pt.fx_rate_to_eur,
            CASE
              WHEN COALESCE(pt.currency, 'EUR') = 'EUR' THEN '1'
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
            COALESCE(i.current_price, '0') AS current_price,
            COALESCE(i.interest_rate, '0') AS interest_rate
       FROM portfolio_transactions pt
       JOIN investments i ON i.id = pt.investment_id
      WHERE pt.investment_id IN ${inIds(investmentIds)}
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
      .where("id", "in", inIds(transactionIds))
      .where(sql<boolean>`account_id IS ${fromAccountId}`)
      .returning("id"),
  );
  return rows.map((row) => row.id);
}

export default {
  lockPortfolioTransactionWrites,
  lockEligibleDestinationAccount,
  lockTransactions,
  getUnitEventsForInvestments,
  getHistoricalRates,
  compareAndSetAccount,
};
