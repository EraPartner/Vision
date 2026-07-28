/**
 * Info sub-repository: bank account balances and daily balance history.
 */

import { query } from '../database/connection.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { toYmd } from '../utils/portfolioMath.js';
import { COMPUTED_BALANCE_LATERAL } from './accountBalanceSql.js';
import {
  roundToCents,
  batchConvertGroupsWithHistoricalRateFallback,
} from './infoRepositoryHelpers.js';

export const banksRepository = {
  /**
   * Get current balance per account and daily historical balances over
   * the last 12 months.
   *
   * The current balance is sourced from the shared anchor+delta lateral
   * (`COMPUTED_BALANCE_LATERAL`, ADR-094) — the *same* single source the
   * accounts hub (`accountRepository.getAll`) consumes — so the dashboard
   * widget no longer diverges from the hub. The naive "latest stamped balance" it replaced froze
   * at the last imported statement figure, dropping manual/trade/brokerage
   * activity that leaves `transactions.balance` NULL. Grouped by account_id
   * (ADR-088); the label is sourced from `accounts.name` so the response
   * contract is unchanged while the bank_account string is being retired.
   *
   * Each account row additionally carries (WP-A1, additive — existing fields
   * are untouched):
   *   - `display_name`      — friendly label (falls back to `name`).
   *   - `drift`             — statement_balance − computed balance in the
   *                           account's native currency (same figure as the
   *                           hub's drift badge); absent when no statement
   *                           balance is stored.
   *   - `anchor_date` / `post_anchor_count` — balance provenance from the
   *     shared lateral ("as of {date} statement + {n} entries since" vs
   *     "sum of {n} entries" when anchor_date is absent).
   */
  async getBankBalances(targetCurrency = 'EUR') {
    const accounts = [];
    let totalNetPosition = 0;

    // Both queries are independent — run in parallel, then batch-convert
    // with one historical-rate lookup instead of two.
    const [latestBalanceResult, historyResult] = await Promise.all([
      query(`
        SELECT a.name AS bank_account,
               COALESCE(a.display_name, a.name) AS display_name,
               tx.currency,
               COALESCE(lb.balance, 0) AS balance,
               CASE WHEN a.statement_balance IS NOT NULL
                    THEN a.statement_balance - COALESCE(lb.balance, 0)
                    ELSE NULL END AS drift,
               lb.anchor_date,
               lb.post_anchor_count,
               tx.last_transaction AS date,
               tx.transaction_count,
               tx.first_transaction,
               tx.last_transaction
        FROM accounts a
        ${COMPUTED_BALANCE_LATERAL}
        JOIN LATERAL (
          -- Per-account activity metadata over active rows. The currency is the
          -- most recent active row's (multi-currency partitioning is D2); the
          -- date anchors the FX conversion below to the latest activity.
          SELECT COUNT(*) AS transaction_count,
                 MIN(t.date) AS first_transaction,
                 MAX(t.date) AS last_transaction,
                 (ARRAY_AGG(COALESCE(t.currency, 'EUR') ORDER BY t.date DESC, t.id DESC))[1] AS currency
          FROM transactions t
          WHERE t.account_id = a.id AND t.is_active = true
        ) tx ON true
        WHERE a.type <> 'liability'
          -- §1 F3: in_net_worth governs aggregates (is_active governs UI
          -- listing) — closing an account sets in_net_worth=false, so it
          -- leaves this widget the moment it is closed, matching net worth.
          AND a.in_net_worth = true
          AND tx.transaction_count > 0
        ORDER BY a.name
      `),
      query(`
        WITH days AS (
          SELECT generate_series(
            CURRENT_DATE - interval '12 months',
            CURRENT_DATE,
            interval '1 day'
          )::date AS day
        ),
        account_list AS (
          SELECT a.id AS account_id, a.name AS bank_account
          FROM accounts a
          -- Same population rule as the current-balance query above (§1 F3):
          -- aggregates include only in_net_worth accounts.
          WHERE a.type <> 'liability'
            AND a.in_net_worth = true
            AND a.id IN (
              SELECT t.account_id FROM transactions t
               WHERE t.is_active = true AND t.account_id IS NOT NULL
            )
        )
        -- One index-backed LATERAL probe per (account, day) for the latest
        -- balance ≤ day, instead of a ROW_NUMBER over a series×transactions
        -- CROSS JOIN that materialized many copies of the table. Mirrors the
        -- "latest balance ≤ day" pattern in infoRepositoryNetWorth.js; same
        -- tie-break (date DESC, id DESC). Uses idx_transactions_account_date_active.
        -- Daily (not month-end) points: the dashboard Balance History chart's
        -- time-scale auto-ticks outnumbered monthly datapoints, duplicating
        -- month labels; ~365 probes per account stay cheap index scans.
        -- to_char keeps the day a plain string (pg DATE → local-midnight JS Date
        -- otherwise — the recurring day-shift hazard).
        SELECT
          a.bank_account,
          to_char(d.day, 'YYYY-MM-DD') AS day,
          COALESCE(lb.currency, 'EUR') AS currency,
          lb.balance,
          lb.date
        FROM days d
        CROSS JOIN account_list a
        LEFT JOIN LATERAL (
          SELECT t.currency, t.balance, t.date
          FROM transactions t
          WHERE t.is_active = true
            AND t.account_id = a.account_id
            AND t.balance IS NOT NULL
            AND t.date <= d.day
          ORDER BY t.date DESC, t.id DESC
          LIMIT 1
        ) lb ON true
        WHERE lb.balance IS NOT NULL
        ORDER BY a.account_id, d.day
      `),
    ]);

    const [currentBalancesConverted, historyConverted] =
      await batchConvertGroupsWithHistoricalRateFallback(
        [
          latestBalanceResult.rows.map((/** @type {{
            bank_account: string, display_name: string, currency: string|null,
            balance: string, drift: string|null,
            anchor_date: string|null, post_anchor_count: string|null,
            date: Date|null, transaction_count: string,
            first_transaction: Date|null, last_transaction: Date|null,
          }} */ r) => ({
            ...r,
            amount: toNumber(toDecimal(r.balance)),
            currency: r.currency || 'EUR',
          })),
          historyResult.rows
            .filter((/** @type {{
              bank_account: string, day: string, currency: string,
              balance: string, date: Date,
            }} */ r) => r.bank_account)
            .map((/** @type {{
              bank_account: string, day: string, currency: string,
              balance: string, date: Date,
            }} */ r) => ({
              ...r,
              amount: toNumber(toDecimal(r.balance)),
              currency: r.currency || 'EUR',
            })),
        ],
        targetCurrency,
        'date'
      );

    for (const row of currentBalancesConverted) {
      const balance = roundToCents(row.amount_eur);
      accounts.push({
        bank_account: row.bank_account,
        display_name: row.display_name || row.bank_account,
        balance,
        // Native-currency drift, matching the hub's badge (accountRepository).
        // SQL NULL (no statement balance) → undefined, never null (convention).
        drift: row.drift == null ? undefined : roundToCents(toNumber(toDecimal(row.drift))),
        // Provenance (WP-A1): anchor_date is already a YYYY-MM-DD string via
        // to_char in the lateral; NULL (no stamp) → undefined.
        anchor_date: row.anchor_date == null ? undefined : row.anchor_date,
        post_anchor_count: row.post_anchor_count == null
          ? undefined
          : parseInt(row.post_anchor_count, 10),
        transaction_count: parseInt(row.transaction_count, 10),
        first_transaction: row.first_transaction,
        last_transaction: row.last_transaction,
      });
      totalNetPosition += balance;
    }

    /** @type {Record<string, Array<{ date: string, balance: number }>>} */
    const historyMap = {};
    for (const row of historyConverted) {
      const key = row.bank_account;
      if (!historyMap[key]) historyMap[key] = [];

      // toYmd uses local getters for the defensive Date branch (the SQL emits
      // day via to_char, so this normally passes the string straight through).
      historyMap[key].push({ date: toYmd(row.day), balance: roundToCents(row.amount_eur) });
    }

    for (const key of Object.keys(historyMap)) {
      historyMap[key].sort((a, b) => a.date.localeCompare(b.date));
    }

    const totalsByDate = new Map();
    for (const entries of Object.values(historyMap)) {
      for (const { date, balance } of entries) {
        totalsByDate.set(date, toNumber(toDecimal(totalsByDate.get(date) ?? 0).plus(toDecimal(balance))));
      }
    }
    const totalHistory = [...totalsByDate.keys()]
      .sort()
      .map((date) => ({ date, balance: roundToCents(totalsByDate.get(date)) }));

    return {
      accounts,
      total_net_position: roundToCents(totalNetPosition),
      history: historyMap,
      total_history: totalHistory,
    };
  },
};
