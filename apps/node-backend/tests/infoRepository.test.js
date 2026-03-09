/**
 * Info Repository unit tests.
 * Tests the repository methods with mocked database queries and currency conversion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/services/currencyConversionService.js', () => ({
  convertToEur: vi.fn((amount) => amount), // identity by default
}));

import { query } from '../src/database/connection.js';
import { convertToEur } from '../src/services/currencyConversionService.js';
import infoRepository from '../src/repositories/infoRepository.js';

describe('InfoRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: mvAvailable returns false (no materialized views)
    query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('LIMIT 1')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  describe('getNetWorth', () => {
    it('should return combined net worth from bank balances and portfolio', async () => {
      const calls = [];
      query.mockImplementation(async (sql, params) => {
        calls.push(sql.trim().substring(0, 40));

        // mvAvailable checks -> false
        if (sql.includes('LIMIT 1')) return { rows: [] };

        // getBankBalances -> live fallback: account list
        if (sql.includes('GROUP BY bank_account') && sql.includes('MIN(date)')) {
          return { rows: [{ bank_account: 'Chase', transaction_count: '10', first_transaction: '2025-01-01', last_transaction: '2026-03-01' }] };
        }
        // getBankBalances -> amounts for Chase
        if (sql.includes('bank_account = $1')) {
          return { rows: [{ amount: '5000', currency: 'EUR', date: '2026-03-01' }] };
        }
        // getBankBalances -> history
        if (sql.includes('generate_series') && sql.includes('CROSS JOIN')) {
          return {
            rows: [
              { bank_account: 'Chase', month_start: '2026-02-01', month_end: '2026-02-28', cumulative_amount: '4500', currency: 'EUR' },
              { bank_account: 'Chase', month_start: '2026-03-01', month_end: '2026-03-31', cumulative_amount: '5000', currency: 'EUR' },
            ]
          };
        }
        // Portfolio history
        if (sql.includes('portfolio_transactions') && sql.includes('generate_series')) {
          return {
            rows: [
              { month: '2026-02', cum_buys: '3000', cum_sells: '0', cum_income: '50', cum_appreciation: '200', cum_fees: '10', cum_taxes: '5' },
              { month: '2026-03', cum_buys: '4000', cum_sells: '0', cum_income: '100', cum_appreciation: '400', cum_fees: '20', cum_taxes: '10' },
            ]
          };
        }
        // Current portfolio value
        if (sql.includes('investments i') && sql.includes('is_active')) {
          return {
            rows: [
              { id: 1, asset_class: 'etf', current_price: '120', total_units: '30', net_invested: '3000', total_income: '100', total_appreciation: '400' },
            ]
          };
        }
        return { rows: [] };
      });

      convertToEur.mockImplementation((amount) => amount);

      const result = await infoRepository.getNetWorth();

      expect(result).toHaveProperty('current');
      expect(result).toHaveProperty('monthlyChange');
      expect(result).toHaveProperty('monthlyChangePercent');
      expect(result).toHaveProperty('snapshots');
      expect(result.current.liquid).toBe(5000);
      // ETF: 120 * 30 = 3600
      expect(result.current.investments).toBe(3600);
      expect(result.current.netWorth).toBe(8600);
      expect(result.snapshots.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty portfolio and bank data', async () => {
      query.mockImplementation(async (sql) => {
        if (sql.includes('LIMIT 1')) return { rows: [] };
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorth();

      expect(result.current.liquid).toBe(0);
      expect(result.current.investments).toBe(0);
      expect(result.current.netWorth).toBe(0);
      expect(result.snapshots).toHaveLength(0);
      expect(result.monthlyChange).toBe(0);
    });

    it('should compute monthly change percent correctly', async () => {
      query.mockImplementation(async (sql) => {
        if (sql.includes('LIMIT 1')) return { rows: [] };
        if (sql.includes('GROUP BY bank_account') && sql.includes('MIN(date)')) return { rows: [] };
        if (sql.includes('CROSS JOIN')) {
          const currentMonth = new Date().toISOString().substring(0, 7);
          const prevDate = new Date();
          prevDate.setMonth(prevDate.getMonth() - 1);
          const prevMonth = prevDate.toISOString().substring(0, 7);
          return {
            rows: [
              { bank_account: 'A', month_start: `${prevMonth}-01`, cumulative_amount: '1000', currency: 'EUR' },
              { bank_account: 'A', month_start: `${currentMonth}-01`, cumulative_amount: '1100', currency: 'EUR' },
            ]
          };
        }
        if (sql.includes('portfolio_transactions') && sql.includes('generate_series')) return { rows: [] };
        if (sql.includes('investments i')) return { rows: [] };
        return { rows: [] };
      });

      const result = await infoRepository.getNetWorth();

      expect(result.monthlyChange).toBe(100);
      expect(result.monthlyChangePercent).toBe(10);
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
              { recipient_id: 1, recipient_name: 'Amazon', transaction_count: 15, total_spend: '750.50', avg_amount: '50.03', first_seen: '2025-01-15', last_seen: '2026-03-01' },
              { recipient_id: 2, recipient_name: 'Walmart', total_spend: '420.00', transaction_count: 8, avg_amount: '52.50', first_seen: '2025-06-01', last_seen: '2026-02-28' },
            ]
          };
        }
        if (callIdx === 2) {
          // MoM comparison query
          return {
            rows: [
              { recipient_id: 1, recipient_name: 'Amazon', current_spend: '120.00', previous_spend: '80.00', change_percent: '50.0' },
              { recipient_id: 2, recipient_name: 'Walmart', current_spend: '60.00', previous_spend: '0', change_percent: null },
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
        if (callIdx === 1) return { rows: [{ recipient_id: 1, recipient_name: 'Shop', transaction_count: 5, total_spend: '200', avg_amount: '40', first_seen: '2025-01-01', last_seen: '2026-03-01' }] };
        if (callIdx === 2) return {
          rows: [
            { recipient_id: 1, recipient_name: 'Shop', current_spend: '50', previous_spend: '0', change_percent: null },
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
        if (sql.includes('LIMIT 1')) return { rows: [] };
        if (sql.includes('GROUP BY bank_account') && sql.includes('MIN(date)')) {
          return { rows: [{ bank_account: 'Revolut', transaction_count: '25', first_transaction: '2025-01-01', last_transaction: '2026-03-01' }] };
        }
        if (sql.includes('bank_account = $1')) {
          return {
            rows: [
              { amount: '3000', currency: 'EUR', date: '2026-03-01' },
              { amount: '-500', currency: 'EUR', date: '2026-02-15' },
            ]
          };
        }
        if (sql.includes('CROSS JOIN')) return { rows: [] };
        return { rows: [] };
      });

      const result = await infoRepository.getBankBalances();

      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].bank_account).toBe('Revolut');
      expect(result.accounts[0].balance).toBe(2500);
      expect(result.total_net_position).toBe(2500);
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
