/**
 * Info Repository unit tests.
 * Tests the repository methods with mocked database queries and currency conversion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/services/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(async (rows) => rows.map(r => ({ ...r, amount_eur: Number(r.amount || 0) }))),
}));

vi.mock('../src/services/priceProviderService.js', () => ({
  fetchHistoricalPrices: vi.fn(async () => []),
  getHistoricalPriceAt: vi.fn((points, timestampMs) => {
    if (!Array.isArray(points) || points.length === 0) return undefined;
    let best;
    for (const point of points) {
      if (!point || !Number.isFinite(point.timestampMs)) continue;
      if (point.timestampMs <= timestampMs) best = point;
      else break;
    }
    return best?.price;
  }),
}));

import { query } from '../src/database/connection.js';
import { convertRowsToEur } from '../src/services/currencyConversionService.js';
import { fetchHistoricalPrices } from '../src/services/priceProviderService.js';
import infoRepository from '../src/repositories/infoRepository.js';

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
    // Default: mvAvailable returns false (no materialized views)
    query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT 1 FROM')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  describe('getNetWorth', () => {
    it('should return combined net worth from bank balances and portfolio', async () => {
      const calls = [];
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      query.mockImplementation(async (sql, params) => {
        calls.push(sql.trim().substring(0, 40));

        // mvAvailable checks -> false
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };

        if (sql.includes('first_data_date')) {
          return { rows: [{ first_data_date: '2026-02-01' }] };
        }

        // Daily bank history
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return {
            rows: [
              { day: '2026-02-01', bank_account: 'Chase', balance: '4500', currency: 'EUR' },
              { day: todayKey, bank_account: 'Chase', balance: '5000', currency: 'EUR' },
            ]
          };
        }

        // Daily portfolio history
        if (sql.includes('tx_cumulative')) {
          return {
            rows: [
              { day: '2026-02-01', currency: 'EUR', value: '3235' },
              { day: todayKey, currency: 'EUR', value: '4470' },
            ]
          };
        }

        if (sql.includes('FROM investments i') && sql.includes('LEFT JOIN portfolio_transactions pt')) {
          return { rows: [] };
        }

        return { rows: [] };
      });

      convertRowsToEur.mockImplementation(async (rows) => rows.map(r => ({ ...r, amount_eur: Number(r.amount || 0) })));

      const result = await infoRepository.getNetWorth();

      expect(result).toHaveProperty('current');
      expect(result).toHaveProperty('monthlyChange');
      expect(result).toHaveProperty('monthlyChangePercent');
      expect(result).toHaveProperty('snapshots');
      expect(result.current.liquid).toBe(5000);
      expect(result.current.investments).toBe(4470);
      expect(result.current.netWorth).toBe(9470);
      expect(result.snapshots.length).toBeGreaterThanOrEqual(2);
      expect(convertRowsToEur).toHaveBeenCalled();
      expect(convertRowsToEur).toHaveBeenNthCalledWith(
        1,
        expect.any(Array),
        'EUR',
        { useHistoricalRatesByDate: true, dateField: 'day' }
      );
      expect(convertRowsToEur).toHaveBeenNthCalledWith(
        2,
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
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: '2026-02-01' }] };
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return { rows: [{ day: todayKey, bank_account: 'Chase', balance: '5000', currency: 'EUR' }] };
        }
        if (sql.includes('tx_cumulative')) {
          return { rows: [{ day: todayKey, currency: 'EUR', value: '4470' }] };
        }
        if (sql.includes('FROM investments i') && sql.includes('LEFT JOIN portfolio_transactions pt')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      await infoRepository.getNetWorth('HUF');

      expect(convertRowsToEur).toHaveBeenNthCalledWith(
        1,
        expect.any(Array),
        'HUF',
        { useHistoricalRatesByDate: true, dateField: 'day' }
      );
      expect(convertRowsToEur).toHaveBeenNthCalledWith(
        2,
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

      const result = await infoRepository.getNetWorth();

      expect(result.current.liquid).toBe(0);
      expect(result.current.investments).toBe(0);
      expect(result.current.netWorth).toBe(0);
      expect(result.snapshots).toHaveLength(0);
      expect(result.monthlyChange).toBe(0);
    });

    it('should build net worth from transactions even when no investments exist', async () => {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: todayKey }] };

        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return {
            rows: [{ day: todayKey, bank_account: 'Main', balance: '1234.56', currency: 'EUR' }],
          };
        }

        if (sql.includes('tx_cumulative')) {
          return { rows: [] };
        }

        if (sql.includes('FROM investments i') && sql.includes('LEFT JOIN portfolio_transactions pt')) {
          return { rows: [] };
        }

        return { rows: [] };
      });

      const result = await infoRepository.getNetWorth();

      expect(result.current.liquid).toBe(1234.56);
      expect(result.current.investments).toBe(0);
      expect(result.current.netWorth).toBe(1234.56);
      expect(result.snapshots.length).toBeGreaterThan(0);
    });

    it('should compute monthly change percent correctly', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const firstDayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
      const secondDayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) {
          return { rows: [{ first_data_date: firstDayKey }] };
        }
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return {
            rows: [
              { day: firstDayKey, bank_account: 'A', balance: '1000', currency: 'EUR' },
              { day: secondDayKey, bank_account: 'A', balance: '1100', currency: 'EUR' },
            ]
          };
        }
        if (sql.includes('tx_cumulative')) return { rows: [] };
        if (sql.includes('FROM investments i') && sql.includes('LEFT JOIN portfolio_transactions pt')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorth();

      expect(result.monthlyChange).toBe(100);
      expect(result.monthlyChangePercent).toBe(10);
    });

    it('should fall back to cumulative transaction flow when no bank balances are available', async () => {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: '2026-02-01' }] };

        // No account-based balance history
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return { rows: [] };
        }

        // Fallback liquid flow query
        if (sql.includes('COALESCE(SUM(t.amount), 0) AS amount')) {
          return {
            rows: [
              { day: '2026-02-01', currency: 'EUR', value: '1200' },
              { day: todayKey, currency: 'EUR', value: '1500' },
            ],
          };
        }

        // Portfolio history
        if (sql.includes('tx_cumulative')) {
          return {
            rows: [
              { day: '2026-02-01', currency: 'EUR', value: '300' },
              { day: todayKey, currency: 'EUR', value: '500' },
            ],
          };
        }

        if (sql.includes('FROM investments i') && sql.includes('LEFT JOIN portfolio_transactions pt')) {
          return { rows: [] };
        }

        return { rows: [] };
      });

      const result = await infoRepository.getNetWorth();

      expect(result.current.liquid).toBe(1500);
      expect(result.current.investments).toBe(500);
      expect(result.current.netWorth).toBe(2000);
      expect(convertRowsToEur).toHaveBeenCalled();
    });

    it('should use current investment holdings for latest snapshot when historical portfolio value is missing', async () => {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: todayKey }] };

        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return { rows: [{ day: todayKey, bank_account: 'Main', balance: '1000', currency: 'EUR' }] };
        }

        if (sql.includes('tx_cumulative')) {
          return { rows: [] };
        }

        if (sql.includes('FROM investments i') && sql.includes('LEFT JOIN portfolio_transactions pt')) {
          return {
            rows: [
              {
                id: 1,
                asset_class: 'stock',
                currency: 'EUR',
                current_price: '25',
                units_in: '10',
                units_out: '0',
                buy_amount: '200',
                sell_amount: '0',
                appreciation: '0',
              },
            ],
          };
        }

        return { rows: [] };
      });

      const result = await infoRepository.getNetWorth();

      expect(result.current.liquid).toBe(1000);
      expect(result.current.investments).toBe(250);
      expect(result.current.netWorth).toBe(1250);
    });

    it('should fallback to seed date without active-only filters and log warning when needed', async () => {
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

        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return {
            rows: [{ day: todayKey, bank_account: 'FallbackAccount', balance: '99', currency: 'EUR' }],
          };
        }

        if (sql.includes('tx_cumulative')) return { rows: [] };

        if (sql.includes('FROM investments i') && sql.includes('LEFT JOIN portfolio_transactions pt')) {
          return { rows: [] };
        }

        return { rows: [] };
      });

      const result = await infoRepository.getNetWorth();

      expect(result.current.liquid).toBe(99);
      expect(result.current.netWorth).toBe(99);
      expect(logger.warn).toHaveBeenCalledWith(
        'Net worth seed date required fallback to include all records',
        expect.objectContaining({ firstDataDate: todayKey })
      );
    });

    it('should emit computation debug log with summary metrics', async () => {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: todayKey }] };
        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return { rows: [{ day: todayKey, bank_account: 'Main', balance: '1000', currency: 'EUR' }] };
        }
        if (sql.includes('tx_cumulative')) return { rows: [] };
        if (sql.includes('FROM investments i') && sql.includes('LEFT JOIN portfolio_transactions pt')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      await infoRepository.getNetWorth();

      expect(logger.debug).toHaveBeenCalledWith(
        'Net worth computed',
        expect.objectContaining({
          targetCurrency: 'EUR',
          firstDataDate: todayKey,
          currentNetWorth: 1000,
        })
      );
    });

    it('should use investment activity dates and historical prices for unit-asset daily valuation', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
      const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      fetchHistoricalPrices.mockResolvedValue([
        {
          timestampMs: Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0),
          price: 12,
        },
      ]);

      query.mockImplementation(async (sql) => {
        if (sql.includes('SELECT 1 FROM')) return { rows: [] };
        if (sql.includes('first_data_date')) return { rows: [{ first_data_date: yesterdayKey }] };

        if (sql.includes('account_list') && sql.includes('LEFT JOIN LATERAL')) {
          return {
            rows: [
              { day: yesterdayKey, bank_account: 'Main', balance: '0', currency: 'EUR' },
              { day: todayKey, bank_account: 'Main', balance: '0', currency: 'EUR' },
            ],
          };
        }

        if (sql.includes('i.asset_class NOT IN (\'stock\', \'etf\', \'crypto\', \'metals\')')) {
          return { rows: [] };
        }

        if (sql.includes('COALESCE(i.price_provider, \'manual\') AS price_provider')) {
          return {
            rows: [
              {
                id: 11,
                currency: 'EUR',
                current_price: '100',
                price_provider: 'yahoo',
                price_provider_id: 'AAPL',
                symbol: 'AAPL',
                price_provider_url: null,
                price_provider_latest_url: null,
                price_provider_latest_path: null,
                price_provider_history_url: null,
                price_provider_history_path: null,
                price_provider_history_ts_path: null,
                price_provider_history_price_path: null,
                first_tx_date: todayKey,
                created_date: yesterdayKey,
              },
            ],
          };
        }

        if (sql.includes('AS unit_delta')) {
          return {
            rows: [
              { investment_id: 11, day: todayKey, unit_delta: '2' },
            ],
          };
        }

        if (sql.includes('FROM investments i') && sql.includes('LEFT JOIN portfolio_transactions pt')) {
          return { rows: [] };
        }

        return { rows: [] };
      });

      const result = await infoRepository.getNetWorth();

      const yesterdaySnapshot = result.snapshots.find((s) => s.date === yesterdayKey);
      const todaySnapshot = result.snapshots.find((s) => s.date === todayKey);

      expect(yesterdaySnapshot?.investments).toBe(0);
      expect(todaySnapshot?.investments).toBe(24);
      expect(result.current.investments).toBe(24);
      expect(fetchHistoricalPrices).toHaveBeenCalledWith(
        expect.objectContaining({ id: 11, price_provider: 'yahoo' }),
        expect.objectContaining({ fromMs: expect.any(Number), toMs: expect.any(Number) })
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
      query.mockResolvedValue({ rows: [] });

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
      expect(convertRowsToEur).toHaveBeenNthCalledWith(
        1,
        expect.any(Array),
        'EUR',
        { useHistoricalRatesByDate: true, dateField: 'date' }
      );
      expect(convertRowsToEur).toHaveBeenNthCalledWith(
        2,
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
});
