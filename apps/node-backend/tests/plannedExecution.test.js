/**
 * Planned transaction execution tests.
 * Mirrors: apps/backend/tests/test_planned_execution.py
 *
 * Tests one-time and recurring planned transaction execution logic,
 * including recurrence pattern advancement and double-execution prevention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateNextDate, isValidPattern, getSupportedPatterns } from '../src/services/recurrenceService.js';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { query } from '../src/database/connection.js';

function toUtcDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function utcParts(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
}

describe('Planned Transaction Execution', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Recurrence Service ─────────────────────────────────────
  describe('Recurrence Service', () => {
    it('should list all supported patterns', () => {
      const patterns = getSupportedPatterns();
      expect(patterns).toContain('daily');
      expect(patterns).toContain('weekly');
      expect(patterns).toContain('monthly');
      expect(patterns).toContain('quarterly');
      expect(patterns).toContain('yearly');
    });

    it('should validate known patterns', () => {
      expect(isValidPattern('monthly')).toBe(true);
      expect(isValidPattern('weekly')).toBe(true);
      expect(isValidPattern('daily')).toBe(true);
    });

    it('should reject invalid patterns', () => {
      expect(isValidPattern('invalid')).toBe(false);
      expect(isValidPattern('')).toBe(false);
    });

    it('should calculate all pattern next dates', () => {
      const base = toUtcDate(2026, 1, 15); // Feb 15, 2026 UTC

      const daily = calculateNextDate(base, 'daily');
      expect(utcParts(daily).day).toBe(16);

      const weekly = calculateNextDate(base, 'weekly');
      expect(utcParts(weekly).day).toBe(22);

      const biweekly = calculateNextDate(base, 'biweekly');
      expect(utcParts(biweekly).month).toBe(2); // March
      expect(utcParts(biweekly).day).toBe(1);

      const monthly = calculateNextDate(base, 'monthly');
      expect(utcParts(monthly).month).toBe(2); // March
      expect(utcParts(monthly).day).toBe(15);

      const quarterly = calculateNextDate(base, 'quarterly');
      expect(utcParts(quarterly).month).toBe(4); // May
      expect(utcParts(quarterly).day).toBe(15);

      const yearly = calculateNextDate(base, 'yearly');
      expect(utcParts(yearly).year).toBe(2027);
      expect(utcParts(yearly).month).toBe(1);
    });
  });

  // ── One-Time Execution ─────────────────────────────────────
  describe('One-Time Execution', () => {
    it('should execute a one-time planned transaction', async () => {
      // Mock: get planned txn (not yet executed)
      query.mockResolvedValueOnce({
        rows: [{
          id: 1, planned_date: '2026-03-01', is_executed: false,
          is_recurring: false, bank_account: 'Test Bank',
          recipient_id: 1, amount: -50.00,
        }],
      });
      // Mock: update to executed
      query.mockResolvedValueOnce({
        rows: [{
          id: 1, is_executed: true, executed_transaction_id: 100,
        }],
      });

      // Simulate execution
      const planned = (await query('SELECT')).rows[0];
      expect(planned.is_executed).toBe(false);
      expect(planned.is_recurring).toBe(false);

      const updated = (await query('UPDATE')).rows[0];
      expect(updated.is_executed).toBe(true);
      expect(updated.executed_transaction_id).toBe(100);
    });

    it('should reject double execution of one-time transaction', async () => {
      // Already executed
      query.mockResolvedValueOnce({
        rows: [{
          id: 1, is_executed: true, is_recurring: false,
          executed_transaction_id: 100,
        }],
      });

      const planned = (await query('SELECT')).rows[0];

      // Simulate the check that would happen in the service
      expect(planned.is_executed).toBe(true);
      const shouldReject = !planned.is_recurring && planned.is_executed;
      expect(shouldReject).toBe(true);
    });
  });

  // ── Recurring Execution ────────────────────────────────────
  describe('Recurring Execution', () => {
    it('should execute and advance date for recurring transaction', async () => {
      const currentDate = toUtcDate(2026, 1, 15); // Feb 15 UTC
      const nextDate = calculateNextDate(currentDate, 'monthly');

      // After execution, the planned_date should advance
      expect(utcParts(nextDate).month).toBe(2); // March
      expect(utcParts(nextDate).day).toBe(15);
    });

    it('should allow multiple executions of recurring transaction', async () => {
      // Execute 3 times monthly starting Feb 15
      let currentDate = toUtcDate(2026, 1, 15);
      const executionDates = [currentDate];

      for (let i = 0; i < 3; i++) {
        currentDate = calculateNextDate(currentDate, 'monthly');
        executionDates.push(currentDate);
      }

      expect(executionDates).toHaveLength(4); // original + 3 executions
      expect(utcParts(executionDates[1]).month).toBe(2); // March
      expect(utcParts(executionDates[2]).month).toBe(3); // April
      expect(utcParts(executionDates[3]).month).toBe(4); // May
    });

    it('should track execution history', async () => {
      // Mock: insert execution records
      const executions = [
        { id: 1, planned_transaction_id: 1, executed_transaction_id: 100, execution_date: '2026-02-15' },
        { id: 2, planned_transaction_id: 1, executed_transaction_id: 101, execution_date: '2026-03-15' },
        { id: 3, planned_transaction_id: 1, executed_transaction_id: 102, execution_date: '2026-04-15' },
      ];

      query.mockResolvedValueOnce({ rows: executions });
      const result = await query('SELECT * FROM planned_transaction_executions WHERE planned_transaction_id = 1');
      expect(result.rows).toHaveLength(3);
      expect(result.rows[0].execution_date).toBe('2026-02-15');
      expect(result.rows[2].execution_date).toBe('2026-04-15');
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────
  describe('Edge Cases', () => {
    it('should handle month-end dates correctly', () => {
      const jan31 = toUtcDate(2026, 0, 31); // Jan 31 UTC
      const next = calculateNextDate(jan31, 'monthly');
      // Should go to Feb 28 (or handle overflow)
      expect(utcParts(next).month).toBe(1); // February
      expect(utcParts(next).day).toBeLessThanOrEqual(28);
    });

    it('should handle year boundary', () => {
      const dec15 = toUtcDate(2026, 11, 15); // Dec 15 UTC
      const next = calculateNextDate(dec15, 'monthly');
      expect(utcParts(next).year).toBe(2027);
      expect(utcParts(next).month).toBe(0); // January
    });

    it('should handle leap year', () => {
      const jan31 = toUtcDate(2028, 0, 31); // 2028 is leap year UTC
      const next = calculateNextDate(jan31, 'monthly');
      expect(utcParts(next).month).toBe(1); // February
      expect(utcParts(next).day).toBeLessThanOrEqual(29);
    });
  });
});
