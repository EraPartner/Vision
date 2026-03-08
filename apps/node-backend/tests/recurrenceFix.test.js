/**
 * Recurrence edge-case tests.
 * Mirrors: apps/backend/tests/test_recurrence_fix.py
 */
import { describe, it, expect } from 'vitest';
import { calculateNextDate } from '../src/services/recurrenceService.js';

describe('Recurrence Fix - Edge Cases', () => {
  describe('monthly recurrence', () => {
    it('should maintain the same day of month', () => {
      const current = new Date(2026, 1, 15); // Feb 15
      const next = calculateNextDate(current, 'monthly');
      expect(next.getFullYear()).toBe(2026);
      expect(next.getMonth()).toBe(2); // March
      expect(next.getDate()).toBe(15);
    });

    it('should handle month-end edge case (Jan 31 -> Feb 28/29)', () => {
      const current = new Date(2026, 0, 31); // Jan 31
      const next = calculateNextDate(current, 'monthly');
      expect(next.getMonth()).toBe(1); // February
      // Feb 2026 has 28 days
      expect(next.getDate()).toBeLessThanOrEqual(28);
    });
  });

  describe('weekly recurrence', () => {
    it('should add 7 days', () => {
      const current = new Date(2026, 1, 15); // Feb 15
      const next = calculateNextDate(current, 'weekly');
      expect(next.getFullYear()).toBe(2026);
      expect(next.getMonth()).toBe(1); // still Feb
      expect(next.getDate()).toBe(22);
    });
  });

  describe('custom day intervals', () => {
    it('should handle "every 10 days"', () => {
      const current = new Date(2026, 1, 15);
      const next = calculateNextDate(current, 'every 10 days');
      expect(next.getDate()).toBe(25);
    });

    it('should handle "every 1 day" (singular)', () => {
      const current = new Date(2026, 1, 15);
      const next = calculateNextDate(current, 'every 1 day');
      expect(next.getDate()).toBe(16);
    });

    it('should handle "every 45 days" crossing months', () => {
      const current = new Date(2026, 1, 15); // Feb 15
      const next = calculateNextDate(current, 'every 45 days');
      expect(next.getMonth()).toBe(3); // April
      expect(next.getDate()).toBe(1);
    });
  });

  describe('all standard patterns from Feb 15, 2026', () => {
    const current = new Date(2026, 1, 15);

    const cases = [
      ['daily', { month: 1, day: 16 }],
      ['weekly', { month: 1, day: 22 }],
      ['biweekly', { month: 2, day: 1 }],
      ['monthly', { month: 2, day: 15 }],
      ['quarterly', { month: 4, day: 15 }],
      ['yearly', { year: 2027, month: 1, day: 15 }],
    ];

    for (const [pattern, expected] of cases) {
      it(`should calculate ${pattern} correctly`, () => {
        const next = calculateNextDate(current, pattern);
        if (expected.year) expect(next.getFullYear()).toBe(expected.year);
        expect(next.getMonth()).toBe(expected.month);
        expect(next.getDate()).toBe(expected.day);
      });
    }
  });
});
