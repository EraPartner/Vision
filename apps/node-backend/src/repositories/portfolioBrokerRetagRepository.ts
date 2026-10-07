/**
 * Persistence for the audited portfolio broker re-tag operation.
 *
 * Every function uses the ambient transaction connection from query(). The
 * service wraps the complete compare-and-set mutation in withTransaction().
 */

import { query } from "../database/connection.ts";
import { getUnitEventsForInvestment } from "./portfolioTxRepo.reads.ts";
import type { PortfolioUnitEventRow } from "./portfolioTxRepo.reads.ts";

/** BIGINT ids arrive from pg as strings. */
export type PortfolioRetagAuditRow = {
  id: string;
  idempotency_key: string;
  request_fingerprint: string;
  from_account_id: number | null;
  to_account_id: number | null;
  transaction_ids: number[];
  previous_assignments: Array<{
    transaction_id: number;
    account_id: number | null;
  }>;
  selected_count: number;
  changed_count: number;
  created_at: Date;
};

export type PortfolioRetagAuditInsert = Omit<
  PortfolioRetagAuditRow,
  "id" | "created_at"
>;

/** NUMERIC columns arrive from pg as strings. */
export type RetagTransactionEventRow = {
  id: number;
  investment_id: number;
  type: string;
  /** 'YYYY-MM-DD' */
  date: string;
  amount: string;
  units: string;
  fees: string;
  taxes: string;
  currency: string;
  fx_rate_to_eur: string | null;
  fx_multiplier_eur: string | null;
  account_id: number | null;
  asset_class: string;
  current_price: string;
  interest_rate: string;
};

/**
 * A custody event (asset transfer or adjustment) carrying the investment-level
 * columns of one of that investment's transactions, when it has any.
 */
export type RetagCustodyEventRow = Partial<
  Omit<RetagTransactionEventRow, keyof PortfolioUnitEventRow>
> &
  PortfolioUnitEventRow & { investment_id: number };

export async function lockPortfolioTransactionWrites(): Promise<void> {
  await query(
    "LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE",
  );
}

export async function getAuditByIdempotencyKey(
  idempotencyKey: string,
): Promise<PortfolioRetagAuditRow | undefined> {
  const result = await query<PortfolioRetagAuditRow>(
    `SELECT id, idempotency_key, request_fingerprint, from_account_id,
            to_account_id, transaction_ids, previous_assignments,
            selected_count, changed_count, created_at
       FROM portfolio_retag_audit
      WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0];
}

export async function lockEligibleDestinationAccount(
  accountId: number | null,
): Promise<
  | {
      id: number;
      name: string;
      display_name: string | null;
      type: string;
      is_active: boolean;
    }
  | undefined
> {
  if (accountId == null) return undefined;
  const result = await query<{
    id: number;
    name: string;
    display_name: string | null;
    type: string;
    is_active: boolean;
  }>(
    `SELECT id, name, display_name, type, is_active
       FROM accounts
      WHERE id = $1
        AND is_active = true
        AND type = ANY($2::account_type[])
      FOR UPDATE`,
    [accountId, ["brokerage", "crypto_exchange", "wallet"]],
  );
  return result.rows[0];
}

export async function lockTransactions(
  transactionIds: number[],
): Promise<{ id: number; investment_id: number; account_id: number | null }[]> {
  const result = await query<{
    id: number;
    investment_id: number;
    account_id: number | null;
  }>(
    `SELECT id, investment_id, account_id
       FROM portfolio_transactions
      WHERE id = ANY($1::int[])
      ORDER BY id ASC
      FOR UPDATE`,
    [transactionIds],
  );
  return result.rows;
}

export async function getUnitEventsForInvestments(
  investmentIds: number[],
): Promise<Array<RetagTransactionEventRow | RetagCustodyEventRow>> {
  const result = await query<RetagTransactionEventRow>(
    `SELECT pt.id, pt.investment_id, pt.type,
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
      WHERE pt.investment_id = ANY($1::int[])
      ORDER BY pt.investment_id ASC, pt.date ASC, pt.id ASC`,
    [investmentIds],
  );
  const transfers: RetagCustodyEventRow[] = [];
  for (const investmentId of investmentIds) {
    const events = await getUnitEventsForInvestment(investmentId);
    const exemplar = result.rows.find(
      (row) => Number(row.investment_id) === Number(investmentId),
    );
    for (const event of events.filter((row) =>
      ["asset_transfer", "asset_adjustment"].includes(row.type),
    ))
      transfers.push({ ...exemplar, ...event, investment_id: investmentId });
  }
  return [...result.rows, ...transfers];
}

export async function getHistoricalRates(): Promise<
  { currency_code: string; rate_date: string; rate_to_eur: string }[]
> {
  const result = await query<{
    currency_code: string;
    rate_date: string;
    rate_to_eur: string;
  }>(
    `SELECT currency_code,
            to_char(rate_date, 'YYYY-MM-DD') AS rate_date,
            rate_to_eur
       FROM exchange_rates
      ORDER BY currency_code ASC, rate_date ASC`,
  );
  return result.rows;
}

export async function compareAndSetAccount(
  transactionIds: number[],
  fromAccountId: number | null,
  toAccountId: number | null,
): Promise<number[]> {
  const result = await query<{ id: number }>(
    `UPDATE portfolio_transactions
        SET account_id = $3
      WHERE id = ANY($1::int[])
        AND account_id IS NOT DISTINCT FROM $2
      RETURNING id`,
    [transactionIds, fromAccountId, toAccountId],
  );
  return result.rows.map((row) => Number(row.id));
}

export async function insertAudit(
  receipt: PortfolioRetagAuditInsert,
): Promise<PortfolioRetagAuditRow & { occurred_at: string }> {
  const result = await query<PortfolioRetagAuditRow & { occurred_at: string }>(
    `INSERT INTO portfolio_retag_audit
       (idempotency_key, request_fingerprint, from_account_id, to_account_id,
        transaction_ids, previous_assignments, selected_count, changed_count)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     RETURNING id, idempotency_key, request_fingerprint, from_account_id,
               to_account_id, transaction_ids, previous_assignments,
               selected_count, changed_count, created_at,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at`,
    [
      receipt.idempotency_key,
      receipt.request_fingerprint,
      receipt.from_account_id,
      receipt.to_account_id,
      JSON.stringify(receipt.transaction_ids),
      JSON.stringify(receipt.previous_assignments),
      receipt.selected_count,
      receipt.changed_count,
    ],
  );
  return result.rows[0];
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
