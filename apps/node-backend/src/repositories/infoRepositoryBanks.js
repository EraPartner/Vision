/**
 * Info sub-repository: bank account balances and monthly history.
 */

import { query } from '../database/connection.js';
import { toDecimal, toNumber } from '../lib/money.js';
import {
  roundToCents,
  formatDateToYmd,
  extractYearMonth,
  batchConvertGroupsWithHistoricalRateFallback,
} from './infoRepositoryHelpers.js';

export const banksRepository = {
  /**
   * Get current balance per bank account and monthly historical balances.
   * Uses the balance field from the single most recent transaction (by date)
   * per bank account, matching the old Python backend behaviour.
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
        WITH months AS (
          SELECT generate_series(
            date_trunc('month', CURRENT_DATE - interval '11 months'),
            date_trunc('month', CURRENT_DATE),
            interval '1 month'
          )::date AS month_start
        ),
        account_list AS (
          SELECT DISTINCT bank_account
          FROM transactions
          WHERE is_active = true AND bank_account IS NOT NULL
        ),
        ranked AS (
          SELECT
            a.bank_account,
            m.month_start,
            COALESCE(t.currency, 'EUR') AS currency,
            t.balance,
            t.date,
            ROW_NUMBER() OVER (
              PARTITION BY a.bank_account, m.month_start
              ORDER BY t.date DESC, t.id DESC
            ) AS rn
          FROM months m
          CROSS JOIN account_list a
          LEFT JOIN transactions t ON t.bank_account = a.bank_account
            AND t.date <= (m.month_start + interval '1 month' - interval '1 day')::date
            AND t.is_active = true
            AND t.balance IS NOT NULL
        )
        SELECT bank_account, month_start, currency, balance, date
        FROM ranked
        WHERE rn = 1 AND balance IS NOT NULL
        ORDER BY bank_account, month_start
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

      const monthStr = row.month_start instanceof Date
        ? formatDateToYmd(row.month_start)
        : row.month_start;

      const monthKey = extractYearMonth(monthStr);
      historyMap[key].push({ month: monthKey, balance: roundToCents(row.amount_eur) });
    }

    for (const key of Object.keys(historyMap)) {
      historyMap[key].sort((a, b) => a.month.localeCompare(b.month));
    }

    const totalsByMonth = new Map();
    for (const entries of Object.values(historyMap)) {
      for (const { month, balance } of entries) {
        totalsByMonth.set(month, toNumber(toDecimal(totalsByMonth.get(month) ?? 0).plus(toDecimal(balance))));
      }
    }
    const totalHistory = [...totalsByMonth.keys()]
      .sort()
      .map((month) => ({ month, balance: roundToCents(totalsByMonth.get(month)) }));

    return {
      accounts,
      total_net_position: roundToCents(totalNetPosition),
      history: historyMap,
      total_history: totalHistory,
    };
  },
};
