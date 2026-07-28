/**
 * Info sub-repository: net worth from portfolio snapshots + bank balances.
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
import {
  COMPUTED_BALANCE_LATERAL,
  computedBalanceSeriesCtes,
} from './accountBalanceSql.js';
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
   * The **current** point — headline, last chart point, latest table row — is
   * the unified anchor+delta computed balance (`COMPUTED_BALANCE_LATERAL`,
   * ADR-094 / WP-A1), the same single definition the accounts hub and dashboard
   * widget consume. The naive stamped read it replaced silently dropped
   * manual-only (never-stamped) in-net-worth accounts from the headline and
   * froze stamped accounts at their last imported statement figure.
   *
   * The liquid/liability *history* series applies that same definition to every
   * earlier day (`computedBalanceSeriesCtes`). It used to be stamp-based, so a
   * manual-only account showed up in the last point only and the chart stepped
   * up overnight — a step the monthly-change figure then reported as a real
   * gain. A day before an account's first active row still yields no row for it
   * (it contributes 0 to that day's total, and its first known balance is never
   * carried backwards).
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

    /** @type {Record<string, number>} */
    const investmentsByDay = {};
    for (const row of snapshotResult.rows) {
      investmentsByDay[row.day] = Number(row.investments) || 0;
    }

    // App-timezone today (ADR-009), threaded into the SQL bounds as well so
    // the generated day series and the JS walk below agree on the last day —
    // Postgres CURRENT_DATE follows the server timezone, not the app's.
    const todayYmd = todayAppDateString();

    // History walk and the unified current-point balances (the same
    // anchor+delta definition, unbounded) are independent — run in parallel.
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
        SELECT a.id AS account_id, a.name AS bank_account,
               (a.type = 'liability') AS is_liability,
               a.currency AS account_currency
        FROM accounts a
        WHERE a.in_net_worth = true
          AND a.id IN (
            SELECT t.account_id FROM transactions t
             WHERE t.is_active = true AND t.account_id IS NOT NULL
          )
      ),
      -- The walk resolves each day with the SAME unstamped-tolerant
      -- anchor+delta definition the current point uses, bounded at that day.
      -- The stamped-only probe it replaces (plus a WHERE lb.balance IS NOT
      -- NULL gate) hid never-stamped accounts from EVERY point except the last
      -- one — the current-point override below then added them back in one go,
      -- so the chart stepped up overnight and reported it as a monthly gain.
      -- Cross-currency Σ (not per-currency) on purpose: it must mirror the
      -- current-point lateral below exactly, or the step returns for
      -- multi-currency accounts.
      ${computedBalanceSeriesCtes()}
      -- The currency mirrors the current-point query: the latest active row's
      -- (as of the day), falling back to the account's own.
      SELECT
        to_char(s.day, 'YYYY-MM-DD') AS day,
        a.bank_account,
        a.is_liability,
        COALESCE(s.row_currency, a.account_currency, 'EUR') AS currency,
        s.balance
      FROM balance_series s
      JOIN account_list a ON a.account_id = s.account_id
      ORDER BY s.day, s.account_id
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
          currentBalancesResult.rows.map(
            (/** @type {{ bank_account: string, is_liability: boolean, balance: string, currency: string }} */ r) =>
              ({ ...r, day: todayYmd }),
          ),
          'balance'
        ),
        targetCurrency,
        'day'
      ),
    ]);
    let bankHistoryConverted = bankHistoryConvertedInitial;

    // Reached whenever the walk produced no rows at all: no in-net-worth
    // account owns an active row. That covers the un-migrated ledger this was
    // written for (transactions still carrying a NULL account_id) but ALSO the
    // case where every account with activity is in_net_worth=false. The walk
    // itself no longer needs rescuing when nothing is stamped, since an
    // unstamped account resolves to its running Σ(amount) day by day, which is
    // exactly what this fallback computes.
    //
    // `NOT_TRACKING_ONLY` below is what keeps the two populations apart. The
    // fallback used to sum EVERY active transaction with no account /
    // in_net_worth predicate at all, so a ledger whose only active accounts are
    // in_net_worth=false reported THEIR running total as net worth (measured:
    // liquid −143.25 where 0 is correct). It cannot simply inner-join
    // `accounts` either — the un-migrated ledger it exists for has rows with a
    // `bank_account` string (or nothing) and NO accounts row behind them, and
    // an inner join would drop exactly the rows the fallback is here to count.
    //
    // So the predicate excludes only rows POSITIVELY attributed to an
    // in_net_worth=false account, mirroring the walk's own resolution, which
    // reads `transactions.account_id` and nothing else (`account_list` above).
    // Rows with a NULL account_id stay counted: they are unattributed, and
    // nothing says they belong to a tracking-only account. An all-tracking
    // ledger therefore yields no rows at all → every day is 0.
    const NOT_TRACKING_ONLY = `
            AND NOT EXISTS (
              SELECT 1 FROM accounts a
              WHERE a.id = t.account_id AND a.in_net_worth = false
            )`;
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
            ${NOT_TRACKING_ONLY}
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
            ${NOT_TRACKING_ONLY}
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
    /** @type {Record<string, number>} */
    const liquidByDay = {};
    /** @type {Record<string, number>} */
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

    // WP-A1: set the *current* point's liquid/liability figures from the
    // unified computed-balance definition (see the method doc). Now that the
    // walk resolves every earlier day with that same definition this is
    // continuous with the point before it, so no step is introduced; it still
    // matters because the walk is bounded at each day (a future-dated row
    // counts here first) and because the population is every in-net-worth
    // account, including ones with no active rows at all. Skipped when the
    // accounts query returned nothing (no in-net-worth accounts, e.g. an
    // un-migrated ledger running on the transaction-flow fallback), keeping the
    // walk/fallback-derived point instead.
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

    const latest = sanitizedSnapshots[sanitizedSnapshots.length - 1]
      || /** @type {{ date?: string, liquid: number, liabilities: number, investments: number, netWorth: number }} */ ({ liquid: 0, liabilities: 0, investments: 0, netWorth: 0 });
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
