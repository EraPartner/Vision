/**
 * Info sub-repository: net worth from portfolio snapshots + bank balances.
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
import { COMPUTED_BALANCE_LATERAL } from './accountBalanceSql.js';
import { toNumber, toDecimal } from '../lib/money.js';
import { todayAppDateString } from '../lib/timezone.js';
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
   *
   * The liquid/liability *history* series is stamp-based (latest stamped
   * `transactions.balance` ≤ each day), but the **current** point — headline,
   * last chart point, latest table row — is overridden with the unified
   * anchor+delta computed balance (`COMPUTED_BALANCE_LATERAL`, ADR-094 /
   * WP-A1), the same single definition the accounts hub and dashboard widget
   * consume. The naive stamped walk it replaced silently
   * dropped manual-only (never-stamped) in-net-worth accounts from the
   * headline and froze stamped accounts at their last imported statement
   * figure.
   *
   * @param {string} [targetCurrency]
   * @param {{ liveInvestments?: number }} [opts]
   */
  async getNetWorthFromSnapshots(targetCurrency = 'EUR', { liveInvestments } = {}) {
    // First data date over active transactions + snapshots, falling back to any
    // transaction when there are no active ones — folded into one round-trip via
    // COALESCE (LEAST ignores NULLs, so it only falls through when both the
    // snapshot and active-txn minima are NULL) (SIMP-51).
    const firstDateResult = await query(`
      SELECT COALESCE(
        LEAST(
          (SELECT MIN(snapshot_date) FROM portfolio_performance_snapshots WHERE currency = $1),
          (SELECT MIN(date)::date FROM transactions WHERE is_active = true)
        ),
        (SELECT MIN(date)::date FROM transactions)
      )::date AS first_data_date
    `, [targetCurrency]);

    const firstDataDate = firstDateResult.rows[0]?.first_data_date;

    const firstDataDateYmd = firstDataDate
      ? (firstDataDate instanceof Date ? formatDateToYmd(firstDataDate) : String(firstDataDate).split('T')[0])
      : null;

    if (!firstDataDateYmd) {
      logger.info('Net worth has no source records', { targetCurrency });
      return {
        current: { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 },
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

    // App-timezone today (ADR-009), threaded into the SQL bounds as well so
    // the generated day series and the JS walk below agree on the last day —
    // Postgres CURRENT_DATE follows the server timezone, not the app's.
    const todayYmd = todayAppDateString();

    // History walk (stamp-based, per WP-A1 decision) and the unified
    // current-point balances (anchor+delta lateral) are independent — run in
    // parallel.
    const [bankHistoryResult, currentBalancesResult] = await Promise.all([
      query(`
      WITH bounds AS (
        SELECT $1::date AS start_date, $2::date AS end_date
      ),
      days AS (
        SELECT generate_series(start_date, end_date, interval '1 day')::date AS day
        FROM bounds
      ),
      account_list AS (
        -- in_net_worth gates the bank/cash side of net worth (ADR-089): a
        -- tracking-only account (in_net_worth=false) does not contribute.
        -- is_liability splits negative debt balances (ADR-092) out of the
        -- "liquid assets" bucket so a mortgage is not counted as liquid cash.
        -- The stamped-only probe below serves the HISTORY series only (WP-A1
        -- decision); the current point is overridden after the walk with the
        -- unified computed-balance lateral.
        SELECT a.id AS account_id, a.name AS bank_account,
               (a.type = 'liability') AS is_liability
        FROM accounts a
        WHERE a.in_net_worth = true
          AND a.id IN (
            SELECT t.account_id FROM transactions t
             WHERE t.is_active = true AND t.account_id IS NOT NULL
          )
      )
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS day,
        a.bank_account,
        a.is_liability,
        COALESCE(lb.currency, 'EUR') AS currency,
        lb.balance
      FROM days d
      CROSS JOIN account_list a
      LEFT JOIN LATERAL (
        SELECT t.currency, t.balance
        FROM transactions t
        WHERE t.is_active = true
          AND t.account_id = a.account_id
          AND t.balance IS NOT NULL
          AND t.date <= d.day
        ORDER BY t.date DESC, t.id DESC
        LIMIT 1
      ) lb ON true
      WHERE lb.balance IS NOT NULL
      ORDER BY d.day, a.account_id
    `, [firstDataDateYmd, todayYmd]),
      // Unified current balance per in-net-worth account (WP-A1): the shared
      // anchor+delta lateral, with NO `balance IS NOT NULL` population gate —
      // a manual-only account (nothing stamped) falls back to Σ(amount) inside
      // the lateral instead of vanishing from the headline. An account with no
      // active rows contributes a harmless 0. The currency mirrors the
      // bank-balances query: the most recent active row's, falling back to the
      // account's own currency.
      query(`
      SELECT a.name AS bank_account,
             (a.type = 'liability') AS is_liability,
             COALESCE(lb.balance, 0) AS balance,
             COALESCE(cur.currency, a.currency, 'EUR') AS currency
      FROM accounts a
      ${COMPUTED_BALANCE_LATERAL}
      LEFT JOIN LATERAL (
        SELECT t.currency
        FROM transactions t
        WHERE t.account_id = a.id AND t.is_active = true
        ORDER BY t.date DESC, t.id DESC
        LIMIT 1
      ) cur ON true
      WHERE a.in_net_worth = true
    `),
    ]);

    // Convert the current-point balances at today's date so the historical-rate
    // lookup keys on the same day the headline represents.
    const [bankHistoryConvertedInitial, currentBalancesConverted] = await Promise.all([
      convertRowsWithHistoricalRateFallback(
        mapRowsForAmountConversion(bankHistoryResult.rows, 'balance'),
        targetCurrency,
        'day'
      ),
      convertRowsWithHistoricalRateFallback(
        mapRowsForAmountConversion(
          currentBalancesResult.rows.map((r) => ({ ...r, day: todayYmd })),
          'balance'
        ),
        targetCurrency,
        'day'
      ),
    ]);
    let bankHistoryConverted = bankHistoryConvertedInitial;

    if (bankHistoryConverted.length === 0) {
      logger.debug('Net worth account balance history empty; using transaction flow fallback', {
        targetCurrency,
        firstDataDate: firstDataDateYmd,
      });

      const liquidFlowResult = await query(`
        WITH bounds AS (
          SELECT $1::date AS start_date, $2::date AS end_date
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
      `, [firstDataDateYmd, todayYmd]);

      bankHistoryConverted = await convertRowsWithHistoricalRateFallback(
        mapRowsForAmountConversion(liquidFlowResult.rows, 'value'),
        targetCurrency,
        'day'
      );
    }

    // Split each in-net-worth account's daily balance into liquid assets vs
    // liabilities (ADR-092): debt balances are negative and must not drag the
    // "liquid assets" headline negative. netWorth = liquid + liabilities + investments.
    const liquidByDay = {};
    const liabilitiesByDay = {};
    for (const row of bankHistoryConverted) {
      const bucket = row.is_liability ? liabilitiesByDay : liquidByDay;
      if (!bucket[row.day]) bucket[row.day] = 0;
      // Decimal accumulation (money-hygiene): per-day EUR balances summed with
      // native `+=` drift sub-cent before the roundToCents below.
      bucket[row.day] = toNumber(toDecimal(bucket[row.day]).plus(toDecimal(row.amount_eur)));
    }

    const start = new Date(`${firstDataDateYmd}T00:00:00Z`);
    // End anchor on the app-timezone today (ADR-009) — UTC midnight dropped
    // the newest day from the series between local midnight and 01:00/02:00.
    const end = new Date(`${todayYmd}T00:00:00Z`);

    const snapshots = [];
    // Forward-fill the last known investments value: portfolio snapshots are
    // not guaranteed to exist for every calendar day, and a missing day must
    // carry the prior value forward rather than collapse net worth to
    // liquid-only.
    let lastInvestments = 0;
    for (let day = new Date(start); day <= end; day = addDaysUtc(day)) {
      const dayKey = getDayKeyUtc(day);
      const liquid = roundToCents(liquidByDay[dayKey] || 0);
      const liabilities = roundToCents(liabilitiesByDay[dayKey] || 0);
      if (Object.prototype.hasOwnProperty.call(investmentsByDay, dayKey)) {
        lastInvestments = investmentsByDay[dayKey];
      }
      const investments = roundToCents(lastInvestments);
      snapshots.push({
        date: dayKey,
        liquid,
        liabilities,
        investments,
        netWorth: roundToCents(liquid + liabilities + investments),
      });
    }

    const sanitizedSnapshots = sanitizeIsolatedDailyInvestmentSpikes(snapshots);

    // WP-A1: override the *current* point's liquid/liability figures with the
    // unified computed-balance definition (see the method doc). Only the last
    // point moves — the history series deliberately stays stamp-based — so a
    // manual-only account or post-anchor manual activity can introduce a step
    // between the penultimate (stamped) and latest (computed) points. Skipped
    // when the accounts query returned nothing (no in-net-worth accounts, e.g.
    // an un-migrated ledger running on the transaction-flow fallback), keeping
    // the walk/fallback-derived point instead.
    if (currentBalancesConverted.length > 0 && sanitizedSnapshots.length > 0) {
      let liquidNow = toDecimal(0);
      let liabilitiesNow = toDecimal(0);
      for (const row of currentBalancesConverted) {
        if (row.is_liability) liabilitiesNow = liabilitiesNow.plus(toDecimal(row.amount_eur));
        else liquidNow = liquidNow.plus(toDecimal(row.amount_eur));
      }
      const last = sanitizedSnapshots[sanitizedSnapshots.length - 1];
      last.liquid = roundToCents(toNumber(liquidNow));
      last.liabilities = roundToCents(toNumber(liabilitiesNow));
      last.netWorth = roundToCents(last.liquid + last.liabilities + last.investments);
    }

    // Reconcile the most-recent point with the live portfolio summary. The
    // stored snapshot value is only rebuilt at startup (snapshotBuilder runs
    // once in warmup), so on its own the Net Worth "Investments" headline
    // freezes at the boot-time price while the Dashboard/Performance cards —
    // served live from portfolioSummaryService — keep moving with each hourly
    // price refresh. The caller passes the live total so the latest snapshot
    // (headline, last chart point, and latest table row) always matches those
    // two surfaces. See ADR-064.
    if (Number.isFinite(liveInvestments) && sanitizedSnapshots.length > 0) {
      const last = sanitizedSnapshots[sanitizedSnapshots.length - 1];
      const investments = roundToCents(liveInvestments);
      last.investments = investments;
      last.netWorth = roundToCents(last.liquid + (last.liabilities || 0) + investments);
    }

    const latest = sanitizedSnapshots[sanitizedSnapshots.length - 1] || { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 };
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
        liabilities: latest.liabilities ?? 0,
        investments: latest.investments,
        netWorth: latest.netWorth,
      },
      monthlyChange: roundToCents(monthlyChange),
      monthlyChangePercent: roundToCents(monthlyChangePercent),
      snapshots: sanitizedSnapshots,
    };
  },
};
