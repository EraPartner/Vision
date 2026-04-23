/**
 * Info sub-repository: net worth from portfolio snapshots + bank balances.
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
import {
  roundToCents,
  formatDateToYmd,
  extractYearMonth,
  addDaysUtc,
  getDayKeyUtc,
  mapRowsForAmountConversion,
  convertRowsWithHistoricalRateFallback,
  sanitizeIsolatedDailyInvestmentSpikes,
} from './infoRepositoryHelpers.js';

export const netWorthRepository = {
  /**
   * Net Worth (snapshot-backed) — reads investment values from pre-computed
   * portfolio_performance_snapshots (populated by portfolioPerformanceSnapshotService).
   * Bank balances are still derived live from the transactions table.
   * No network calls — all data from the database.
   */
  async getNetWorthFromSnapshots(targetCurrency = 'EUR') {
    const firstDateResult = await query(`
      SELECT LEAST(
        (SELECT MIN(snapshot_date) FROM portfolio_performance_snapshots WHERE currency = $1),
        (SELECT MIN(date)::date FROM transactions WHERE is_active = true)
      )::date AS first_data_date
    `, [targetCurrency]);

    let firstDataDate = firstDateResult.rows[0]?.first_data_date;

    if (!firstDataDate) {
      const fallbackResult = await query(`
        SELECT LEAST(
          (SELECT MIN(snapshot_date) FROM portfolio_performance_snapshots WHERE currency = $1),
          (SELECT MIN(date)::date FROM transactions)
        )::date AS first_data_date
      `, [targetCurrency]);
      firstDataDate = fallbackResult.rows[0]?.first_data_date;
    }

    const firstDataDateYmd = firstDataDate
      ? (firstDataDate instanceof Date ? formatDateToYmd(firstDataDate) : String(firstDataDate).split('T')[0])
      : null;

    if (!firstDataDateYmd) {
      logger.info('Net worth has no source records', { targetCurrency });
      return {
        current: { liquid: 0, investments: 0, netWorth: 0 },
        monthlyChange: 0,
        monthlyChangePercent: 0,
        snapshots: [],
      };
    }

    const snapshotResult = await query(`
      SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS day, value AS investments
      FROM portfolio_performance_snapshots
      WHERE currency = $1
      ORDER BY snapshot_date ASC
    `, [targetCurrency]);

    const investmentsByDay = {};
    for (const row of snapshotResult.rows) {
      investmentsByDay[row.day] = Number(row.investments) || 0;
    }

    const bankHistoryResult = await query(`
      WITH bounds AS (
        SELECT $1::date AS start_date, CURRENT_DATE AS end_date
      ),
      days AS (
        SELECT generate_series(start_date, end_date, interval '1 day')::date AS day
        FROM bounds
      ),
      account_list AS (
        SELECT DISTINCT bank_account
        FROM transactions
        WHERE is_active = true
          AND bank_account IS NOT NULL
      )
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS day,
        a.bank_account,
        COALESCE(lb.currency, 'EUR') AS currency,
        lb.balance
      FROM days d
      CROSS JOIN account_list a
      LEFT JOIN LATERAL (
        SELECT t.currency, t.balance
        FROM transactions t
        WHERE t.is_active = true
          AND t.bank_account = a.bank_account
          AND t.balance IS NOT NULL
          AND t.date <= d.day
        ORDER BY t.date DESC, t.id DESC
        LIMIT 1
      ) lb ON true
      WHERE lb.balance IS NOT NULL
      ORDER BY d.day, a.bank_account
    `, [firstDataDateYmd]);

    let bankHistoryConverted = await convertRowsWithHistoricalRateFallback(
      mapRowsForAmountConversion(bankHistoryResult.rows, 'balance'),
      targetCurrency,
      'day'
    );

    if (bankHistoryConverted.length === 0) {
      logger.debug('Net worth account balance history empty; using transaction flow fallback', {
        targetCurrency,
        firstDataDate: firstDataDateYmd,
      });

      const liquidFlowResult = await query(`
        WITH bounds AS (
          SELECT $1::date AS start_date, CURRENT_DATE AS end_date
        ),
        days AS (
          SELECT generate_series(start_date, end_date, interval '1 day')::date AS day
          FROM bounds
        ),
        currencies AS (
          SELECT DISTINCT COALESCE(t.currency, 'EUR') AS currency
          FROM transactions t
          WHERE t.is_active = true
            AND t.date >= (SELECT start_date FROM bounds)
            AND t.date <= (SELECT end_date FROM bounds)
        ),
        tx_daily AS (
          SELECT
            t.date::date AS day,
            COALESCE(t.currency, 'EUR') AS currency,
            COALESCE(SUM(t.amount), 0) AS amount
          FROM transactions t
          WHERE t.is_active = true
            AND t.date >= (SELECT start_date FROM bounds)
            AND t.date <= (SELECT end_date FROM bounds)
          GROUP BY t.date::date, COALESCE(t.currency, 'EUR')
        ),
        tx_series AS (
          SELECT
            d.day,
            c.currency,
            COALESCE(td.amount, 0) AS amount
          FROM days d
          CROSS JOIN currencies c
          LEFT JOIN tx_daily td ON td.day = d.day AND td.currency = c.currency
        ),
        tx_cumulative AS (
          SELECT
            day,
            currency,
            SUM(amount) OVER (PARTITION BY currency ORDER BY day) AS value
          FROM tx_series
        )
        SELECT
          to_char(day, 'YYYY-MM-DD') AS day,
          currency,
          value
        FROM tx_cumulative
        ORDER BY day, currency
      `, [firstDataDateYmd]);

      bankHistoryConverted = await convertRowsWithHistoricalRateFallback(
        mapRowsForAmountConversion(liquidFlowResult.rows, 'value'),
        targetCurrency,
        'day'
      );
    }

    const liquidByDay = {};
    for (const row of bankHistoryConverted) {
      if (!liquidByDay[row.day]) liquidByDay[row.day] = 0;
      liquidByDay[row.day] += row.amount_eur;
    }

    const start = new Date(`${firstDataDateYmd}T00:00:00Z`);
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);

    const snapshots = [];
    for (let day = new Date(start); day <= end; day = addDaysUtc(day)) {
      const dayKey = getDayKeyUtc(day);
      const liquid = roundToCents(liquidByDay[dayKey] || 0);
      const investments = roundToCents(investmentsByDay[dayKey] || 0);
      snapshots.push({
        date: dayKey,
        liquid,
        investments,
        netWorth: roundToCents(liquid + investments),
      });
    }

    const sanitizedSnapshots = sanitizeIsolatedDailyInvestmentSpikes(snapshots);

    const latest = sanitizedSnapshots[sanitizedSnapshots.length - 1] || { liquid: 0, investments: 0, netWorth: 0 };
    const currentMonthPrefix = latest.date ? extractYearMonth(latest.date) : null;
    const firstCurrentMonthIdx = currentMonthPrefix
      ? sanitizedSnapshots.findIndex(s => s.date.startsWith(currentMonthPrefix))
      : -1;
    const baseline = firstCurrentMonthIdx > 0
      ? sanitizedSnapshots[firstCurrentMonthIdx - 1]
      : sanitizedSnapshots[0];
    const monthlyChange = baseline ? latest.netWorth - baseline.netWorth : 0;
    const monthlyChangePercent = baseline && baseline.netWorth !== 0
      ? (monthlyChange / Math.abs(baseline.netWorth)) * 100
      : 0;

    logger.debug('Net worth computed from snapshots', {
      targetCurrency,
      firstDataDate: firstDataDateYmd,
      snapshots: sanitizedSnapshots.length,
      currentLiquid: latest.liquid,
      currentInvestments: latest.investments,
      currentNetWorth: latest.netWorth,
    });

    return {
      current: {
        liquid: latest.liquid,
        investments: latest.investments,
        netWorth: latest.netWorth,
      },
      monthlyChange: roundToCents(monthlyChange),
      monthlyChangePercent: roundToCents(monthlyChangePercent),
      snapshots: sanitizedSnapshots,
    };
  },
};
