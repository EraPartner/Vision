/**
 * Info sub-repository: bank account balances and daily balance history.
 */

import { query } from '../database/connection.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { toYmd } from '../utils/portfolioMath.js';
import {
  roundToCents,
  batchConvertGroupsWithHistoricalRateFallback,
} from './infoRepositoryHelpers.js';

export const banksRepository = {
  /**
   * Get current balance per bank account and daily historical balances over
   * the last 12 months. Uses the balance field from the single most recent
   * transaction (by date) per bank account, matching the old Python backend
   * behaviour.
   */
  async getBankBalances(targetCurrency = 'EUR') {
    const accounts = [];
    let totalNetPosition = 0;

    // Both queries are independent — run in parallel, then batch-convert
    // with one historical-rate lookup instead of two.
    const [latestBalanceResult, historyResult] = await Promise.all([
      query(`
        SELECT DISTINCT ON (bank_account)
               bank_account,
               COALESCE(currency, 'EUR') AS currency,
               balance,
               date,
               COUNT(*) OVER (PARTITION BY bank_account) AS transaction_count,
               MIN(date) OVER (PARTITION BY bank_account) AS first_transaction,
               MAX(date) OVER (PARTITION BY bank_account) AS last_transaction
        FROM transactions
        WHERE is_active = true
          AND bank_account IS NOT NULL
          AND balance IS NOT NULL
        ORDER BY bank_account, date DESC, id DESC
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
          SELECT DISTINCT bank_account
          FROM transactions
          WHERE is_active = true AND bank_account IS NOT NULL
        )
        -- One index-backed LATERAL probe per (account, day) for the latest
        -- balance ≤ day, instead of a ROW_NUMBER over a series×transactions
        -- CROSS JOIN that materialized many copies of the table. Mirrors the
        -- "latest balance ≤ day" pattern in infoRepositoryNetWorth.js; same
        -- tie-break (date DESC, id DESC). Uses idx_transactions_bank_date_active.
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
            AND t.bank_account = a.bank_account
            AND t.balance IS NOT NULL
            AND t.date <= d.day
          ORDER BY t.date DESC, t.id DESC
          LIMIT 1
        ) lb ON true
        WHERE lb.balance IS NOT NULL
        ORDER BY a.bank_account, d.day
      `),
    ]);

    const [currentBalancesConverted, historyConverted] =
      await batchConvertGroupsWithHistoricalRateFallback(
        [
          latestBalanceResult.rows.map(r => ({
            ...r,
            amount: toNumber(toDecimal(r.balance)),
            currency: r.currency || 'EUR',
          })),
          historyResult.rows
            .filter(r => r.bank_account)
            .map(r => ({
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
        balance,
        transaction_count: parseInt(row.transaction_count, 10),
        first_transaction: row.first_transaction,
        last_transaction: row.last_transaction,
      });
      totalNetPosition += balance;
    }

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
