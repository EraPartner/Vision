/**
 * Info Repository unit tests.
 * Tests the repository methods with mocked database queries and currency conversion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  queryPrepared: vi.fn(),
}));

vi.mock('../src/services/currency/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(async (rows) => rows.map(r => ({ ...r, amount_eur: Number(r.amount || 0) }))),
}));

// getIncludeTransfers() reads the `includeTransfers` setting; stub it so the
// transfer-exclusion lookup (ADR-083) doesn't consume the order-dependent
// `query` mocks below. Default null → transfers excluded.
vi.mock('../src/repositories/settingsRepository.js', () => ({
  settingsRepository: { get: vi.fn(async () => null), getAll: vi.fn(async () => ({})) },
  default: { get: vi.fn(async () => null), getAll: vi.fn(async () => ({})) },
}));

import { query, queryPrepared } from '../src/database/connection.js';
import { convertRowsToEur } from '../src/services/currency/currencyConversionService.js';
import infoRepository from '../src/repositories/infoRepository.js';
import { clearMvCache } from '../src/repositories/infoRepository.js';
import { COMPUTED_BALANCE_LATERAL } from '../src/repositories/accountBalanceSql.js';

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { logger } from '../src/config/logger.js';

// App-timezone today (ADR-009) — getNetWorthFromSnapshots anchors its day
// series on the app timezone, not the server-local/UTC calendar day.
import { todayAppDateString, addDaysYmd } from '../src/lib/timezone.js';

// YYYY-MM period helpers. Derive the previous month from the first-of-month in
// UTC so end-of-month run dates (the 29th–31st) don't roll `setMonth(-1)` into
// the wrong month and collapse current==prev — which made these MoM tests
// fail only on certain calendar days.
const currentPeriod = () => new Date().toISOString().substring(0, 7);
const prevPeriod = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().substring(0, 7);
};

describe('InfoRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMvCache();
    // Default: mvAvailable returns false (no materialized views)
    query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT 1 FROM')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  describe('getNetWorthFromSnapshots', () => {
    it('should return combined net worth from bank balances and portfolio snapshots', async () => {
      const todayKey = todayAppDateString();
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: '2026-02-01' }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return {
            rows: [
              { day: '2026-02-01', investments: '3235' },
              { day: todayKey, investments: '4470' },
            ],
          };
        }
        if (sql.includes('balance_series')) {
          return {
            rows: [
              { day: '2026-02-01', bank_account: 'Chase', balance: '4500', currency: 'EUR' },
              { day: todayKey, bank_account: 'Chase', balance: '5000', currency: 'EUR' },
            ],
          };
        }
        return { rows: [] };
      });

      convertRowsToEur.mockImplementation(async (rows) => rows.map(r => ({ ...r, amount_eur: Number(r.amount || 0) })));

      const result = await infoRepository.getNetWorthFromSnapshots();

      expect(result).toHaveProperty('current');
      expect(result).toHaveProperty('monthlyChange');
      expect(result).toHaveProperty('monthlyChangePercent');
      expect(result).toHaveProperty('snapshots');
      expect(result.current.liquid).toBe(5000);
      expect(result.current.investments).toBe(4470);
      expect(result.current.netWorth).toBe(9470);
      expect(result.snapshots.length).toBeGreaterThanOrEqual(2);
      expect(convertRowsToEur).toHaveBeenCalledWith(
        expect.any(Array),
        'EUR',
        { useHistoricalRatesByDate: true, dateField: 'day' }
      );
    });

    it('should overlay the latest point with the live portfolio value when provided', async () => {
      const todayKey = todayAppDateString();
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: '2026-02-01' }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return {
            rows: [
              { day: '2026-02-01', investments: '3235' },
              { day: todayKey, investments: '4470' },
            ],
          };
        }
        if (sql.includes('balance_series')) {
          return {
            rows: [
              { day: '2026-02-01', bank_account: 'Chase', balance: '4500', currency: 'EUR' },
              { day: todayKey, bank_account: 'Chase', balance: '5000', currency: 'EUR' },
            ],
          };
        }
        return { rows: [] };
      });

      convertRowsToEur.mockImplementation(async (rows) => rows.map(r => ({ ...r, amount_eur: Number(r.amount || 0) })));

      const result = await infoRepository.getNetWorthFromSnapshots('EUR', { liveInvestments: 5123.45 });

      // Headline "investments" comes from the live summary (5123.45), not the
      // stored snapshot value (4470) — this is the parity fix.
      expect(result.current.investments).toBe(5123.45);
      expect(result.current.netWorth).toBe(10123.45);
      // The latest chart point / table row reflects the same overlay so the
      // page is internally consistent with its own headline.
      const lastSnapshot = result.snapshots[result.snapshots.length - 1];
      expect(lastSnapshot.investments).toBe(5123.45);
      expect(lastSnapshot.netWorth).toBe(10123.45);
    });

    it('should pass target currency through conversion calls', async () => {
      const todayKey = todayAppDateString();
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: todayKey }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [{ day: todayKey, investments: '4470' }] };
        }
        if (sql.includes('balance_series')) {
          return { rows: [{ day: todayKey, bank_account: 'Chase', balance: '5000', currency: 'EUR' }] };
        }
        return { rows: [] };
      });

      await infoRepository.getNetWorthFromSnapshots('HUF');

      expect(convertRowsToEur).toHaveBeenCalledWith(
        expect.any(Array),
        'HUF',
        { useHistoricalRatesByDate: true, dateField: 'day' }
      );
    });

    it('should handle empty portfolio and bank data', async () => {
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: null }] };
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorthFromSnapshots();

      expect(result.current.liquid).toBe(0);
      expect(result.current.investments).toBe(0);
      expect(result.current.netWorth).toBe(0);
      expect(result.snapshots).toHaveLength(0);
      expect(result.monthlyChange).toBe(0);
    });

    it('should return investments: 0 when snapshots table is empty', async () => {
      const todayKey = todayAppDateString();
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: todayKey }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [] };
        }
        if (sql.includes('balance_series')) {
          return { rows: [{ day: todayKey, bank_account: 'Main', balance: '1234.56', currency: 'EUR' }] };
        }
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorthFromSnapshots();

      expect(result.current.liquid).toBe(1234.56);
      expect(result.current.investments).toBe(0);
      expect(result.current.netWorth).toBe(1234.56);
      expect(result.snapshots.length).toBeGreaterThan(0);
    });

    it('should compute monthly change correctly', async () => {
      const secondDayKey = todayAppDateString();
      const firstDayKey = addDaysYmd(secondDayKey, -1);
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: firstDayKey }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [] };
        }
        if (sql.includes('balance_series')) {
          return {
            rows: [
              { day: firstDayKey, bank_account: 'A', balance: '1000', currency: 'EUR' },
              { day: secondDayKey, bank_account: 'A', balance: '1100', currency: 'EUR' },
            ],
          };
        }
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorthFromSnapshots();

      expect(result.monthlyChange).toBe(100);
      expect(result.monthlyChangePercent).toBe(10);
    });

    it('should fall back to cumulative transaction flow when no bank balances are available', async () => {
      const todayKey = todayAppDateString();
      query.mockImplementation(async (sql) => {
        // Discriminated by 'tx_cumulative', the fallback's own CTE:
        // `COALESCE(SUM(t.amount), 0) AS amount` also appears inside the
        // shared balance-series CTEs, so it cross-matches the history walk.
        // Like the 'WITH anchor' branch below, this MUST come before the
        // generic 'SELECT 1 FROM' one — the fallback's tracking-only exclusion
        // contains `NOT EXISTS (SELECT 1 FROM accounts a …)`.
        if (sql.includes('tx_cumulative')) {
          return {
            rows: [
              { day: '2026-02-01', currency: 'EUR', value: '1200' },
              { day: todayKey, currency: 'EUR', value: '1500' },
            ],
          };
        }
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: '2026-02-01' }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [{ day: todayKey, investments: '500' }] };
        }
        if (sql.includes('balance_series')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorthFromSnapshots();

      // The fallback query must carry the tracking-only exclusion: a ledger
      // whose only active accounts are in_net_worth=false must not have THEIR
      // running total reported as net worth.
      const fallbackSql = query.mock.calls.map(([s]) => s)
        .find((s) => typeof s === 'string' && s.includes('tx_cumulative'));
      expect(fallbackSql).toContain('a.in_net_worth = false');

      expect(result.current.liquid).toBe(1500);
      expect(result.current.investments).toBe(500);
      expect(result.current.netWorth).toBe(2000);
      expect(convertRowsToEur).toHaveBeenCalled();
    });

    it('should fall back to the seed date via the combined COALESCE query when there are no active transactions', async () => {
      const todayKey = todayAppDateString();
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        // The first-data-date query now folds the active-only minimum and the
        // all-transactions fallback into one COALESCE (SIMP-51); the DB resolves
        // the fallback and returns the seed date directly.
        if (sql.includes('first_data_date')) {
          return { rows: [{ first_data_date: todayKey }] };
        }
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [] };
        }
        if (sql.includes('balance_series')) {
          return { rows: [{ day: todayKey, bank_account: 'FallbackAccount', balance: '99', currency: 'EUR' }] };
        }
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorthFromSnapshots();

      expect(result.current.liquid).toBe(99);
      expect(result.current.netWorth).toBe(99);
    });

    // ── WP-A1: current point uses the unified computed-balance definition ──
    //
    // The unified current-balance query is discriminated by 'WITH anchor'
    // (the shared lateral's CTE) — the daily history walk ends in a
    // 'balance_series' CTE instead, so the two mocks can't cross-match. The
    // 'WITH anchor' branch MUST come before the generic 'SELECT 1 FROM'
    // branch: the lateral's no-stamp fallback contains
    // `NOT EXISTS (SELECT 1 FROM anchor)`.
    const mockUnifiedNetWorth = ({ firstDataDate, investmentsRows, walkRows, currentRows }) => {
      query.mockImplementation(async (sql) => {
        if (sql.includes('WITH anchor')) return { rows: currentRows };
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: firstDataDate }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: investmentsRows };
        }
        if (sql.includes('balance_series')) {
          return { rows: walkRows };
        }
        return { rows: [] };
      });
    };

    it('overrides the current point with the unified anchor+delta balances (manual-only + stamped + liability)', async () => {
      const todayKey = todayAppDateString();
      const firstDayKey = addDaysYmd(todayKey, -2);
      mockUnifiedNetWorth({
        firstDataDate: firstDayKey,
        investmentsRows: [{ day: todayKey, investments: '1000' }],
        // The stamped walk only ever sees the imported-statement account and
        // freezes it at the stamp (5000); the manual-only account and the
        // post-anchor manual rows are invisible to it.
        walkRows: [
          { day: firstDayKey, bank_account: 'KBC', is_liability: false, balance: '4500', currency: 'EUR' },
          { day: todayKey, bank_account: 'KBC', is_liability: false, balance: '5000', currency: 'EUR' },
        ],
        // The unified definition sees all three fixture accounts:
        //  (a) manual-only (never stamped) → Σ(amount) = 200
        //  (b) stamped + manual rows after the anchor → 5000 + 150 = 5150
        //  (c) liability (in_net_worth, negative balance) → -300
        currentRows: [
          { bank_account: 'Cash', is_liability: false, balance: '200', currency: 'EUR' },
          { bank_account: 'KBC', is_liability: false, balance: '5150', currency: 'EUR' },
          { bank_account: 'Mortgage', is_liability: true, balance: '-300', currency: 'EUR' },
        ],
      });

      const result = await infoRepository.getNetWorthFromSnapshots();

      // Headline: population AND number come from the unified definition —
      // the manual-only account is included, the stamped account advanced
      // past its frozen stamp, the liability split out.
      expect(result.current.liquid).toBe(5350);
      expect(result.current.liabilities).toBe(-300);
      expect(result.current.investments).toBe(1000);
      expect(result.current.netWorth).toBe(6050);

      // History stays stamp-based (WP-A1 decision): earlier points are
      // untouched by the override.
      expect(result.snapshots[0].liquid).toBe(4500);
      expect(result.snapshots[0].liabilities).toBe(0);
      // Only the latest point was reconciled to the unified definition.
      const last = result.snapshots[result.snapshots.length - 1];
      expect(last.liquid).toBe(5350);
      expect(last.liabilities).toBe(-300);
      expect(last.netWorth).toBe(6050);
    });

    it('applies the live-investments overlay on top of the unified current point', async () => {
      const todayKey = todayAppDateString();
      mockUnifiedNetWorth({
        firstDataDate: todayKey,
        investmentsRows: [{ day: todayKey, investments: '1000' }],
        walkRows: [{ day: todayKey, bank_account: 'KBC', is_liability: false, balance: '5000', currency: 'EUR' }],
        currentRows: [
          { bank_account: 'KBC', is_liability: false, balance: '5150', currency: 'EUR' },
          { bank_account: 'Mortgage', is_liability: true, balance: '-300', currency: 'EUR' },
        ],
      });

      const result = await infoRepository.getNetWorthFromSnapshots('EUR', { liveInvestments: 2000 });

      expect(result.current.liquid).toBe(5150);
      expect(result.current.liabilities).toBe(-300);
      expect(result.current.investments).toBe(2000);
      expect(result.current.netWorth).toBe(6850);
    });

    it('keeps the walk-derived current point when no in-net-worth accounts exist', async () => {
      const todayKey = todayAppDateString();
      mockUnifiedNetWorth({
        firstDataDate: todayKey,
        investmentsRows: [],
        walkRows: [{ day: todayKey, bank_account: 'Chase', is_liability: false, balance: '5000', currency: 'EUR' }],
        currentRows: [],
      });

      const result = await infoRepository.getNetWorthFromSnapshots();

      expect(result.current.liquid).toBe(5000);
      expect(result.current.netWorth).toBe(5000);
    });

    it('sources the current point from the shared COMPUTED_BALANCE_LATERAL with no stamped-population gate', async () => {
      const todayKey = todayAppDateString();
      mockUnifiedNetWorth({
        firstDataDate: todayKey,
        investmentsRows: [],
        walkRows: [],
        currentRows: [],
      });

      await infoRepository.getNetWorthFromSnapshots();

      const calls = query.mock.calls.map((c) => c[0]);
      const currentSql = calls.find((sql) => typeof sql === 'string' && sql.includes('WITH anchor'));
      expect(currentSql).toBeDefined();
      // One SQL definition of "current balance" project-wide: the headline
      // embeds the exact shared lateral the hub/widget/reconcile use…
      expect(currentSql).toContain(COMPUTED_BALANCE_LATERAL.trim());
      // …respects the net-worth population rule…
      expect(currentSql).toContain('a.in_net_worth = true');
      // …and carries NO `lb.balance IS NOT NULL` gate (that predicate exists
      // only inside the lateral's anchor CTE and, deliberately, in the
      // stamp-based HISTORY walk — not on the current point's population).
      expect(currentSql).not.toContain('WHERE lb.balance IS NOT NULL');
    });

    it('should emit debug log with summary metrics', async () => {
      const todayKey = todayAppDateString();
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: todayKey }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [] };
        }
        if (sql.includes('balance_series')) {
          return { rows: [{ day: todayKey, bank_account: 'Main', balance: '1000', currency: 'EUR' }] };
        }
        return { rows: [] };
      });

      await infoRepository.getNetWorthFromSnapshots();

      expect(logger.debug).toHaveBeenCalledWith(
        'Net worth computed from snapshots',
        expect.objectContaining({
          targetCurrency: 'EUR',
          firstDataDate: todayKey,
          currentNetWorth: 1000,
        })
      );
    });
  });

  describe('getRecipientInsights', () => {
    it('should return top merchants and month-over-month data', async () => {
      let callIdx = 0;
      query.mockImplementation(async () => {
        callIdx++;
        if (callIdx === 1) {
          // Top merchants query
          return {
            rows: [
              { recipient_id: 1, recipient_name: 'Amazon', tx_count: 15, total_abs_amount: '750.50', first_seen: '2025-01-15', last_seen: '2026-03-01', currency: 'EUR' },
              { recipient_id: 2, recipient_name: 'Walmart', tx_count: 8, total_abs_amount: '420.00', first_seen: '2025-06-01', last_seen: '2026-02-28', currency: 'EUR' },
            ]
          };
        }
        if (callIdx === 2) {
          // MoM comparison query
          return {
            rows: [
              { recipient_id: 1, recipient_name: 'Amazon', period: currentPeriod(), currency: 'EUR', abs_amount: '120.00' },
              { recipient_id: 1, recipient_name: 'Amazon', period: prevPeriod(), currency: 'EUR', abs_amount: '80.00' },
              { recipient_id: 2, recipient_name: 'Walmart', period: currentPeriod(), currency: 'EUR', abs_amount: '60.00' },
            ]
          };
        }
        if (callIdx === 3) {
          // Current/previous month keys derived in-DB.
          return {
            rows: [{
              current_period: currentPeriod(),
              prev_period: prevPeriod(),
            }],
          };
        }
        return { rows: [] };
      });

      const result = await infoRepository.getRecipientInsights();

      expect(result.topMerchants).toHaveLength(2);
      expect(result.topMerchants[0].name).toBe('Amazon');
      expect(result.topMerchants[0].totalSpend).toBe(750.5);
      expect(result.topMerchants[0].transactionCount).toBe(15);
      expect(result.topMerchants[0].avgAmount).toBe(50.03);
      expect(result.topMerchants[1].name).toBe('Walmart');

      // MoM: only entries with non-null change_percent
      expect(result.monthOverMonth).toHaveLength(1);
      expect(result.monthOverMonth[0].name).toBe('Amazon');
      expect(result.monthOverMonth[0].changePercent).toBe(50.0);
      expect(result.monthOverMonth[0].currentSpend).toBe(120);
      expect(result.monthOverMonth[0].previousSpend).toBe(80);
    });

    it('should return empty arrays when no transactions', async () => {
      query.mockImplementation(async (sql) =>
        sql.includes("TO_CHAR(CURRENT_DATE")
          ? { rows: [{ current_period: '2026-01', prev_period: '2025-12' }] }
          : { rows: [] }
      );

      const result = await infoRepository.getRecipientInsights();

      expect(result.topMerchants).toEqual([]);
      expect(result.monthOverMonth).toEqual([]);
    });

    it('should filter out entries with null change_percent from monthOverMonth', async () => {
      let callIdx = 0;
      query.mockImplementation(async () => {
        callIdx++;
        if (callIdx === 1) return { rows: [{ recipient_id: 1, recipient_name: 'Shop', tx_count: 5, total_abs_amount: '200', first_seen: '2025-01-01', last_seen: '2026-03-01', currency: 'EUR' }] };
        if (callIdx === 2) return {
          rows: [
            { recipient_id: 1, recipient_name: 'Shop', period: currentPeriod(), currency: 'EUR', abs_amount: '50' },
          ]
        };
        if (callIdx === 3) return {
          rows: [{
            current_period: currentPeriod(),
            prev_period: prevPeriod(),
          }],
        };
        return { rows: [] };
      });

      const result = await infoRepository.getRecipientInsights();

      expect(result.topMerchants).toHaveLength(1);
      expect(result.monthOverMonth).toHaveLength(0);
    });
  });

  describe('getCashflowComparison', () => {
    it('should return cashflow data with correct structure', async () => {
      query.mockImplementation(async () => ({ rows: [] }));

      const result = await infoRepository.getCashflowComparison();

      expect(result).toHaveProperty('month');
      expect(result).toHaveProperty('year');
      expect(result).toHaveProperty('days_in_month');
      expect(result).toHaveProperty('current_day');
      expect(result).toHaveProperty('without_planned');
      expect(result).toHaveProperty('with_planned');
      // one entry per day of the current month
      expect(result.without_planned.length).toBe(result.days_in_month);
      expect(result.with_planned.length).toBe(result.days_in_month);
      expect(result.without_planned[0]).toMatchObject({ day: 1, average: 0, current: expect.anything() });
    });
  });

  describe('getBankBalances', () => {
    it('should return account balances with history', async () => {
      query.mockImplementation(async (sql) => {
        if (sql.includes('tx.transaction_count > 0')) {
          return {
            rows: [
              {
                bank_account: 'Revolut',
                balance: '2500',
                currency: 'EUR',
                date: '2026-03-01',
                transaction_count: '25',
                first_transaction: '2025-01-01',
                last_transaction: '2026-03-01',
              },
            ]
          };
        }
        if (sql.includes('ranked AS') && sql.includes('ROW_NUMBER() OVER')) return { rows: [] };
        return { rows: [] };
      });

      const result = await infoRepository.getBankBalances();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].bank_account).toBe('Revolut');
      expect(result.accounts[0].balance).toBe(2500);
      expect(result.total_net_position).toBe(2500);
      // Both current-balance and history rows are now batched into a single
      // convertRowsToEur call inside batchConvertGroupsWithHistoricalRateFallback.
      expect(convertRowsToEur).toHaveBeenCalledTimes(1);
      expect(convertRowsToEur).toHaveBeenCalledWith(
        expect.any(Array),
        'EUR',
        { useHistoricalRatesByDate: true, dateField: 'date' }
      );
    });
  });

  describe('getMonthlyFinancialSummary', () => {
    it('should use valid MV aggregation SQL when exclusions are empty', async () => {
      const calls = [];
      query.mockImplementation(async (sql) => {
        if (typeof sql !== 'string') return { rows: [] };
        calls.push(sql);

        // mvAvailable('mv_monthly_summary') check
        if (sql.includes('SELECT 1 FROM mv_monthly_summary LIMIT 1')) {
          return { rows: [{ '?column?': 1 }] };
        }

        if (sql.includes('FROM mv_monthly_summary')) {
          return { rows: [] };
        }

        return { rows: [] };
      });

      const result = await infoRepository.getMonthlyFinancialSummary([]);

      // MV path now zero-fills the 6-month window (matches the live path), so an
      // empty MV yields 6 zeroed months rather than [].
      expect(result.months).toHaveLength(6);
      expect(result.months.every(m => m.total_income === 0 && m.total_spending === 0 && m.transaction_count === 0)).toBe(true);
      expect(result.summary.transaction_count).toBe(0);

      const mvSql = calls.find(
        sql => sql.includes('FROM mv_monthly_summary') && sql.includes('SUM(transaction_count)')
      );
      expect(mvSql).toBeTruthy();
      expect(mvSql).toContain('GROUP BY month_start, month, year, currency');
      expect(mvSql).not.toContain('category_id,');
    });

    it('should build filtered fallback SQL without referencing recipients alias before join', async () => {
      const calls = [];
      query.mockImplementation(async (sql) => {
        if (typeof sql !== 'string') return { rows: [] };
        calls.push(sql);

        // mvAvailable('mv_monthly_summary') check -> false to force fallback
        if (sql.includes('SELECT 1 FROM mv_monthly_summary LIMIT 1')) {
          return { rows: [] };
        }

        if (sql.includes('WITH months AS')) {
          return { rows: [] };
        }

        return { rows: [] };
      });

      const result = await infoRepository.getMonthlyFinancialSummary([9, 22]);

      expect(result.months).toEqual([]);
      expect(result.summary.transaction_count).toBe(0);

      const fallbackSql = calls.find(sql => sql.includes('WITH months AS'));
      expect(fallbackSql).toBeTruthy();
      expect(fallbackSql).toContain('filtered_transactions AS');
      expect(fallbackSql).toContain('LEFT JOIN recipients r ON t.recipient_id = r.id');
      expect(fallbackSql).toContain('LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id');
      // Canonical exclusion semantics: 3-level category COALESCE (alias-aware).
      expect(fallbackSql).toContain('COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN ($1, $2)');
      // Aggregated per (date,currency) in the `daily` CTE, then joined by month.
      expect(fallbackSql).toContain('LEFT JOIN daily d ON d.date >= m.month_start');
    });
  });

  describe('general infoRepository methods', () => {
    it('should compute category breakdown from fallback queries', async () => {
      convertRowsToEur.mockImplementation(async (rows) => rows.map((row) => ({
        ...row,
        amount_eur: Number(row.amount ?? 0),
      })));

      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM mv_category_totals LIMIT 1')) return { rows: [] };
        if (sql.includes('SELECT count(*) FROM transactions')) return { rows: [{ count: '2' }] };
        if (sql.includes('FROM transactions t') && sql.includes('WHERE t.is_active = true') && !sql.includes('COALESCE(c.id')) {
          return { rows: [{ amount: '-3', currency: 'EUR', date: '2026-01-01' }, { amount: '-2', currency: 'USD', date: '2026-01-02' }] };
        }
        if (sql.includes('COALESCE(c.id, -1) AS category_id')) {
          return {
            rows: [
              { category_id: 2, name: 'TRANSPORT:FUEL', amount: '-3', currency: 'EUR', date: '2026-01-01' },
              { category_id: -1, name: 'UNCATEGORISED', amount: '-2', currency: 'USD', date: '2026-01-02' },
            ],
          };
        }
        return { rows: [] };
      });


      const breakdown = await infoRepository.getCategoryBreakdown('EUR');
      expect(breakdown).toHaveLength(2);
    });

    it('should return bank names and transaction count helpers', async () => {
      queryPrepared
        .mockResolvedValueOnce({ rows: [{ bank_account: 'A' }, { bank_account: 'B' }] })
        .mockResolvedValueOnce({ rows: [{ count: '42' }] });

      const banks = await infoRepository.getBanks();
      const count = await infoRepository.getTransactionCount();

      expect(banks).toEqual(['A', 'B']);
      expect(count).toBe(42);
    });

    it('should build planned expenses summary grouped by day', async () => {
      convertRowsToEur.mockImplementation(async (rows) => rows.map((row) => ({
        ...row,
        amount_eur: Number(row.amount ?? 0),
      })));

      // Pin the clock so the next-month window is deterministic (July 2026).
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      try {
        query.mockResolvedValueOnce({
          rows: [
            { id: 1, planned_date: '2026-07-05', amount: '-20', currency: 'EUR', recipient_name: 'Rent', category_name: 'HOME:RENT', is_recurring: true, recurrence_pattern: 'monthly' },
            { id: 2, planned_date: '2026-07-05', amount: '50', currency: 'EUR', recipient_name: 'Salary', category_name: null, is_recurring: false, recurrence_pattern: null },
          ],
        });

        const result = await infoRepository.getPlannedExpensesNextMonth('EUR');
        expect(result.daily_data).toHaveLength(1);
        expect(result.summary.net_amount).toBe(30);
        expect(result.summary.transaction_count).toBe(2);
        // The SQL must exclude already-executed planned transactions.
        expect(query.mock.calls[0][0]).toContain('is_executed = false');
      } finally {
        vi.useRealTimers();
      }
    });

    // The month window used to be built as LOCAL Dates (`new Date(today.year,
    // today.month, 1)`) but read back for the `month`/`year` fields with UTC
    // getters. On a server east of UTC — including the default
    // APP_TIMEZONE=Europe/Brussels — local midnight of the 1st is still the
    // PREVIOUS month in UTC, so the response named month 6 while period_start
    // (local extraction) named 2026-07-01, and at a year boundary it named the
    // previous YEAR too. Neither CI nor the container can see it: both run
    // TZ=UTC, where local and UTC getters agree.
    it.each([
      ['mid-year', '2026-06-15T12:00:00Z', 7, 2026, '2026-07-01', '2026-07-31'],
      ['across the year boundary', '2026-12-15T12:00:00Z', 1, 2027, '2027-01-01', '2027-01-31'],
    ])('names the next month consistently with period_start east of UTC (%s)', async (
      _label, systemTime, month, year, periodStart, periodEnd,
    ) => {
      convertRowsToEur.mockImplementation(async (rows) => rows.map((row) => ({
        ...row,
        amount_eur: Number(row.amount ?? 0),
      })));

      const prevTz = process.env.TZ;
      process.env.TZ = 'Asia/Tokyo'; // UTC+9 — local midnight is the day before in UTC
      vi.useFakeTimers();
      vi.setSystemTime(new Date(systemTime));
      try {
        query.mockResolvedValueOnce({ rows: [] });

        const result = await infoRepository.getPlannedExpensesNextMonth('EUR');

        expect(result.period_start).toBe(periodStart);
        expect(result.period_end).toBe(periodEnd);
        // The headline month/year must name the SAME month period_start does.
        expect({ month: result.month, year: result.year }).toEqual({ month, year });
        // …and the SQL window must be bound to that same month.
        expect(query.mock.calls[0][1]).toEqual([periodStart, expect.any(String)]);
      } finally {
        vi.useRealTimers();
        // Restore, not reassign: `process.env.TZ = undefined` writes the literal
        // string "undefined", leaving Intl on an invalid zone for the rest of
        // the file.
        if (prevTz === undefined) delete process.env.TZ;
        else process.env.TZ = prevTz;
      }
    });

    it('expands a recurring planned tx into its next-month occurrences', async () => {
      convertRowsToEur.mockImplementation(async (rows) => rows.map((row) => ({
        ...row,
        amount_eur: Number(row.amount ?? 0),
      })));

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      try {
        // Weekly recurring dated mid-CURRENT month — old code counted it once at
        // 2026-06-10 (outside next month); now it expands into July occurrences.
        query.mockResolvedValueOnce({
          rows: [
            { id: 1, planned_date: '2026-06-10', amount: '-50', currency: 'EUR', recipient_name: 'Gym', category_name: null, is_recurring: true, recurrence_pattern: 'weekly' },
          ],
        });

        const result = await infoRepository.getPlannedExpensesNextMonth('EUR');
        // July weekly occurrences: 07-01, 07-08, 07-15, 07-22, 07-29 = 5.
        expect(result.summary.transaction_count).toBe(5);
        expect(result.summary.total_expenses).toBe(-250);
        for (const d of result.daily_data) {
          expect(d.date >= '2026-07-01' && d.date < '2026-08-01').toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('fast-forwards a stale fast-cadence recurring row instead of dropping it (120-hop cap)', async () => {
      convertRowsToEur.mockImplementation(async (rows) => rows.map((row) => ({
        ...row,
        amount_eur: Number(row.amount ?? 0),
      })));

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
      try {
        // Daily row last advanced >120 days before the July window: the flat
        // 120-hop walk exhausted MAX_OCCURRENCES around mid-May and the row
        // silently vanished from the forecast. The fast-forward jump must
        // land it back in the window with every July day present.
        query.mockResolvedValueOnce({
          rows: [
            { id: 1, planned_date: '2025-11-01', amount: '-5', currency: 'EUR', recipient_name: 'Coffee', category_name: null, is_recurring: true, recurrence_pattern: 'daily' },
          ],
        });

        const result = await infoRepository.getPlannedExpensesNextMonth('EUR');
        // Every day of July 2026 = 31 occurrences.
        expect(result.summary.transaction_count).toBe(31);
        expect(result.summary.total_expenses).toBe(-155);
        const dates = result.daily_data.map((d) => d.date).sort();
        expect(dates[0]).toBe('2026-07-01');
        expect(dates[dates.length - 1]).toBe('2026-07-31');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should compute average-vs-current spending projections on calendar-day denominators', async () => {
      convertRowsToEur.mockImplementation(async (rows) => rows.map((row) => ({
        ...row,
        amount_eur: Number(row.amount ?? 0),
      })));

      query
        .mockResolvedValueOnce({
          rows: [
            { amount: '-10', currency: 'EUR', date: '2026-01-01' },
            { amount: '-20', currency: 'EUR', date: '2026-01-02' },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { amount: '-5', currency: 'EUR', date: '2026-03-03' },
            { amount: '1', currency: 'EUR', date: '2026-03-03' },
          ],
        })
        // Third call: the unfiltered ledger-start probe. A first row back at the
        // window floor means the full 6 observed months apply.
        .mockResolvedValueOnce({ rows: [{ first_date: '2025-09-04' }] });

      // Pin the clock so the calendar-day denominators are deterministic.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
      try {
        const result = await infoRepository.getAverageVsCurrentSpending('EUR');

        // Observed window = 2025-09-01 → 2026-03-01 = 6 months = 181 calendar
        // days; spend 30. Old (buggy) code divided by 2 transaction days → 15.
        expect(result.past_6_months.avg_daily_spending).toBeCloseTo(30 / 181, 2);
        // The monthly sibling divides the SAME 30 by the SAME window in months.
        expect(result.past_6_months.months_counted).toBe(6);
        expect(result.past_6_months.avg_monthly_spending).toBeCloseTo(30 / 6, 2);
        expect(result.current_month.total_spending).toBe(5);
        // daysElapsed is the calendar day (15), not the 1 day that had a txn.
        expect(result.current_month.days_elapsed).toBe(15);
        // 5 spent over 15 calendar days, projected across March's 31 days.
        expect(result.comparison.projected_monthly_total).toBeCloseTo((5 / 15) * 31, 2);
        // ADR-083: both the 6-month and current-month queries must exclude
        // internal transfers when includeTransfers is off (the default).
        expect(query.mock.calls[0][0]).toContain('is_transfer = false');
        expect(query.mock.calls[1][0]).toContain('is_transfer = false');
      } finally {
        vi.useRealTimers();
      }
    });

    // TODO E21: the old queries streamed raw rows capped by LIMIT 10000/5000
    // with NO ORDER BY — past the cap Postgres dropped *arbitrary* heap-order
    // rows, making the dashboard figures nondeterministically wrong.
    it('aggregates avg-vs-current in SQL, grouped by date/currency/sign with no LIMIT', async () => {
      convertRowsToEur.mockImplementation(async (rows) => rows.map((row) => ({
        ...row,
        amount_eur: Number(row.amount ?? 0),
      })));
      query.mockResolvedValue({ rows: [] });

      await infoRepository.getAverageVsCurrentSpending('EUR');

      // Calls 0/1 are the two aggregate windows; call 2 is the ledger-start
      // probe, which is a MIN(date) scalar and has nothing to group by.
      for (const [sql] of query.mock.calls.slice(0, 2)) {
        expect(sql).toContain('GROUP BY t.date, t.currency');
        expect(sql).toContain('SUM(t.amount)');
        expect(sql).not.toMatch(/LIMIT/i);
      }
      // The average denominator must be probed UNFILTERED: an exclusion or the
      // ADR-083 transfer predicate emptying the oldest months would silently
      // re-base the divisor (see infoRepositoryForecast's sqlLedgerStart).
      const probeSql = query.mock.calls[2][0];
      expect(probeSql).toContain('MIN(t.date)');
      expect(probeSql).not.toMatch(/is_transfer/);
      expect(probeSql).not.toMatch(/LIMIT/i);
    });
  });
});
