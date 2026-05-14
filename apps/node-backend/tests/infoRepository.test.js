/**
 * Info Repository unit tests.
 * Tests the repository methods with mocked database queries and currency conversion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  queryPrepared: vi.fn(),
}));

vi.mock('../src/services/currency/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(async (rows) => rows.map(r => ({ ...r, amount_eur: Number(r.amount || 0) }))),
}));

import { query, queryPrepared } from '../src/database/connection.js';
import { convertRowsToEur } from '../src/services/currency/currencyConversionService.js';
import infoRepository from '../src/repositories/infoRepository.js';
import { clearMvCache } from '../src/repositories/infoRepository.js';

vi.mock('../src/config/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '../src/config/logger.js';

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
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
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

    it('should pass target currency through conversion calls', async () => {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: todayKey }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [{ day: todayKey, investments: '4470' }] };
        }
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
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
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: todayKey }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [] };
        }
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
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
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const firstDayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
      const secondDayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: firstDayKey }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [] };
        }
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
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
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: '2026-02-01' }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [{ day: todayKey, investments: '500' }] };
        }
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return { rows: [] };
        }
        if (sql.includes('COALESCE(SUM(t.amount), 0) AS amount')) {
          return {
            rows: [
              { day: '2026-02-01', currency: 'EUR', value: '1200' },
              { day: todayKey, currency: 'EUR', value: '1500' },
            ],
          };
        }
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorthFromSnapshots();

      expect(result.current.liquid).toBe(1500);
      expect(result.current.investments).toBe(500);
      expect(result.current.netWorth).toBe(2000);
      expect(convertRowsToEur).toHaveBeenCalled();
    });

    it('should fallback to seed date without active-only filters when primary query returns null', async () => {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date') && sql.includes('WHERE is_active = true')) {
          return { rows: [{ first_data_date: null }] };
        }
        if (sql.includes('first_data_date') && !sql.includes('WHERE is_active = true')) {
          return { rows: [{ first_data_date: todayKey }] };
        }
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [] };
        }
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return { rows: [{ day: todayKey, bank_account: 'FallbackAccount', balance: '99', currency: 'EUR' }] };
        }
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorthFromSnapshots();

      expect(result.current.liquid).toBe(99);
      expect(result.current.netWorth).toBe(99);
    });

    it('should emit debug log with summary metrics', async () => {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: todayKey }] };
        if (sql.includes('portfolio_performance_snapshots') && sql.includes('value AS investments')) {
          return { rows: [] };
        }
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
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
              { recipient_id: 1, recipient_name: 'Amazon', period: new Date().toISOString().substring(0, 7), currency: 'EUR', abs_amount: '120.00' },
              { recipient_id: 1, recipient_name: 'Amazon', period: (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().substring(0, 7); })(), currency: 'EUR', abs_amount: '80.00' },
              { recipient_id: 2, recipient_name: 'Walmart', period: new Date().toISOString().substring(0, 7), currency: 'EUR', abs_amount: '60.00' },
            ]
          };
        }
        if (callIdx === 3) {
          // Current/previous month keys derived in-DB.
          return {
            rows: [{
              current_period: new Date().toISOString().substring(0, 7),
              prev_period: (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().substring(0, 7); })(),
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
            { recipient_id: 1, recipient_name: 'Shop', period: new Date().toISOString().substring(0, 7), currency: 'EUR', abs_amount: '50' },
          ]
        };
        if (callIdx === 3) return {
          rows: [{
            current_period: new Date().toISOString().substring(0, 7),
            prev_period: (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().substring(0, 7); })(),
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
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('DISTINCT ON (bank_account)')) {
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

      expect(result.months).toEqual([]);
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
      expect(fallbackSql).toContain('COALESCE(t.category_id, r.default_category_id) NOT IN ($1,$2)');
      expect(fallbackSql).toContain('LEFT JOIN filtered_transactions t ON t.date >= m.month_start');
    });
  });

  describe('general infoRepository methods', () => {
    it('should compute statistics from materialized view fast path', async () => {
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM mv_category_totals LIMIT 1')) return { rows: [{ '?column?': 1 }] };
        if (sql.includes('SELECT count(*) FROM transactions')) return { rows: [{ count: '3' }] };
        if (sql.includes('SELECT * FROM mv_category_totals')) {
          return {
            rows: [
              { category_id: 1, name: 'FOOD:GROCERIES', count: '2', total: '-10', currency: 'EUR' },
              { category_id: 1, name: 'FOOD:GROCERIES', count: '1', total: '-5', currency: 'USD' },
            ],
          };
        }
        return { rows: [] };
      });

      convertRowsToEur.mockResolvedValue([
        { category_id: 1, name: 'FOOD:GROCERIES', count: '2', amount_eur: -10 },
        { category_id: 1, name: 'FOOD:GROCERIES', count: '1', amount_eur: -4 },
      ]);

      const result = await infoRepository.getStatistics('EUR');
      expect(result.total_transactions).toBe(3);
      expect(result.total_amount).toBe(-14);
      expect(result.categories).toHaveLength(1);
      expect(result.categories[0]).toMatchObject({ id: 1, count: 3, total: -14 });
    });

    it('should compute statistics and category breakdown from fallback queries', async () => {
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

      const stats = await infoRepository.getStatistics('EUR');
      expect(stats.total_transactions).toBe(2);
      expect(stats.total_amount).toBe(-5);
      expect(stats.categories).toHaveLength(2);

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

    it('should summarize transactions with filters and empty fallback', async () => {
      convertRowsToEur.mockImplementation(async (rows) => rows.map((row) => ({
        ...row,
        amount_eur: Number(row.amount ?? 0),
      })));

      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ amount: '-4', currency: 'EUR', date: '2026-01-01' }, { amount: '2', currency: 'EUR', date: '2026-01-02' }] });

      const empty = await infoRepository.getTransactionSummary({ bankAccount: 'REV' });
      expect(empty).toEqual({ total_count: 0, total_amount: 0, average: 0, min: null, max: null });

      const result = await infoRepository.getTransactionSummary({ startDate: '2026-01-01', endDate: '2026-01-02', targetCurrency: 'EUR' });
      expect(result).toMatchObject({ total_count: 2, total_amount: -2, average: -1, min: -4, max: 2 });
    });

    it('should build planned expenses summary grouped by day', async () => {
      convertRowsToEur.mockImplementation(async (rows) => rows.map((row) => ({
        ...row,
        amount_eur: Number(row.amount ?? 0),
      })));

      query.mockResolvedValueOnce({
        rows: [
          { id: 1, planned_date: '2026-02-01', amount: '-20', currency: 'EUR', recipient_name: 'Rent', category_name: 'HOME:RENT', is_recurring: true, recurrence_pattern: 'monthly' },
          { id: 2, planned_date: '2026-02-01', amount: '50', currency: 'EUR', recipient_name: 'Salary', category_name: null, is_recurring: false, recurrence_pattern: null },
        ],
      });

      const result = await infoRepository.getPlannedExpensesNextMonth('EUR');
      expect(result.daily_data).toHaveLength(1);
      expect(result.summary.net_amount).toBe(30);
      expect(result.summary.transaction_count).toBe(2);
    });

    it('should compute average-vs-current spending projections', async () => {
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
            { amount: '-5', currency: 'EUR', date: '2026-01-03' },
            { amount: '1', currency: 'EUR', date: '2026-01-03' },
          ],
        });

      const result = await infoRepository.getAverageVsCurrentSpending('EUR');
      // Two transaction days, total spending 30 => 15/day
      expect(result.past_6_months.avg_daily_spending).toBe(15);
      expect(result.current_month.total_spending).toBe(5);
      expect(result.comparison).toHaveProperty('projected_monthly_total');
    });
  });
});
