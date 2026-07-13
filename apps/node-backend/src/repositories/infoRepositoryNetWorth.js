/**
 * Info sub-repository: net worth from portfolio snapshots + bank balances.
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
import { computeDailySnapshots } from '../services/portfolio/snapshotBuilder.js';
import { accountRepository } from './accountRepository.js';
import { convertToCurrency } from '../services/currency/currencyConversionService.js';
import { toNumber } from '../lib/money.js';
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

/**
 * Read the persisted per-account holdings split (ADR-100, migration 0074) for
 * one currency, shaped as the same Map<accountKey, [{date, holdings}]> the live
 * replay produces. Returns null when the side table is absent or holds no rows
 * for the currency, so the caller falls back to a live computeDailySnapshots
 * replay. Rows are pre-sparse (only accounts holding value on a day) and stored
 * ordered by (account_key, snapshot_date).
 *
 * @param {string} target uppercase currency code
 * @returns {Promise<Map<string, {date: string, holdings: number}[]>|null>}
 */
async function readPersistedAccountSeries(target) {
  const tableExists = await query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'portfolio_snapshot_accounts'
    LIMIT 1
  `);
  if (tableExists.rows.length === 0) return null;

  const result = await query(`
    SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS day, account_key, value
    FROM portfolio_snapshot_accounts
    WHERE currency = $1
    ORDER BY account_key, snapshot_date
  `, [target]);

  if (result.rows.length === 0) return null;

  const seriesByAcct = new Map();
  for (const row of result.rows) {
    const key = row.account_key;
    if (!seriesByAcct.has(key)) seriesByAcct.set(key, []);
    seriesByAcct.get(key).push({ date: row.day, holdings: roundToCents(row.value) });
  }
  return seriesByAcct;
}

export const netWorthRepository = {
  /**
   * Net Worth (snapshot-backed) — reads investment values from pre-computed
   * portfolio_performance_snapshots (populated by portfolioPerformanceSnapshotService).
   * Bank balances are still derived live from the transactions table.
   * No network calls — all data from the database.
   *
   * @param {string} [targetCurrency]
   * @param {{ liveInvestments?: number }} [opts]
   */
  async getNetWorthFromSnapshots(targetCurrency = 'EUR', { liveInvestments } = {}) {
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

    const bankHistoryResult = await query(`
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
    `, [firstDataDateYmd, todayYmd]);

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
      bucket[row.day] += row.amount_eur;
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

  /**
   * Net worth expressed natively as Σ accounts (ADR-100): per in-net-worth account,
   * the rebuilt daily HOLDINGS series (from the snapshot builder's per-account split,
   * Σ accounts == the aggregate value by construction) plus current cash (ADR-094).
   * Legacy lots with no account collapse into one `accountId: null` ("unassigned") row.
   *
   * @param {string} [targetCurrency]
   */
  async getNetWorthByAccount(targetCurrency = 'EUR') {
    const target = (targetCurrency || 'EUR').toUpperCase();

    // Prefer the persisted per-account split (migration 0074): a cheap indexed
    // read of the same value_by_account the snapshot builder already computed,
    // instead of replaying the full multi-year day-walk on every cache miss.
    // Falls back to a live replay when the side table is missing or empty (an
    // un-migrated DB, or before the first snapshot store) — same graceful
    // degrade the FX-neutral column uses.
    const [persistedSeries, accounts] = await Promise.all([
      readPersistedAccountSeries(target),
      accountRepository.getAll({ active: null }),
    ]);

    let holdingsSeriesByAcct = persistedSeries;
    if (!holdingsSeriesByAcct) {
      const snapshots = await computeDailySnapshots(target);
      holdingsSeriesByAcct = new Map();
      for (const s of snapshots) {
        for (const [acctKey, value] of Object.entries(s.value_by_account || {})) {
          if (!holdingsSeriesByAcct.has(acctKey)) holdingsSeriesByAcct.set(acctKey, []);
          holdingsSeriesByAcct.get(acctKey).push({ date: s.snapshot_date, holdings: roundToCents(value) });
        }
      }
    }
    const lastHoldings = (key) => {
      const series = holdingsSeriesByAcct.get(key);
      return series && series.length ? series[series.length - 1].holdings : 0;
    };

    const rows = [];
    for (const a of accounts) {
      if (!a.in_net_worth) continue;
      const key = String(a.id);
      const acctCur = (a.currency || 'EUR').toUpperCase();
      const cashNative = Number(a.computed_balance) || 0;
      const cash = roundToCents(
        acctCur === target ? cashNative : toNumber(await convertToCurrency(cashNative, acctCur, target)),
      );
      const currentHoldings = lastHoldings(key);
      rows.push({
        accountId: a.id,
        name: a.display_name || a.name,
        currency: acctCur,
        cash,
        currentHoldings,
        currentTotal: roundToCents(cash + currentHoldings),
        holdingsSeries: holdingsSeriesByAcct.get(key) || [],
      });
    }

    // Unassigned holdings (legacy lots, no account) — holdings only, no cash sleeve.
    const unassigned = holdingsSeriesByAcct.get('unassigned');
    if (unassigned && unassigned.length) {
      const currentHoldings = unassigned[unassigned.length - 1].holdings;
      rows.push({
        accountId: null,
        name: null,
        currency: target,
        cash: 0,
        currentHoldings,
        currentTotal: currentHoldings,
        holdingsSeries: unassigned,
      });
    }

    rows.sort((a, b) => b.currentTotal - a.currentTotal);
    return { currency: target, accounts: rows };
  },
};
