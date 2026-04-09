/**
 * Recurrence edge-case tests.
 * Mirrors: apps/backend/tests/test_recurrence_fix.py
 */
import { describe, it, expect } from 'vitest';
import { calculateNextDate } from '../src/services/recurrenceService.js';

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

describe('Recurrence Fix - Edge Cases', () => {
  describe('monthly recurrence', () => {
    it('should maintain the same day of month', () => {
      const current = toUtcDate(2026, 1, 15); // Feb 15 UTC
      const next = calculateNextDate(current, 'monthly');
      expect(utcParts(next).year).toBe(2026);
      expect(utcParts(next).month).toBe(2); // March
      expect(utcParts(next).day).toBe(15);
    });

    it('should handle month-end edge case (Jan 31 -> Feb/Mar)', () => {
      const current = toUtcDate(2026, 0, 31); // Jan 31 UTC
      const next = calculateNextDate(current, 'monthly');
      expect(utcParts(next).month).toBe(1); // February
      expect(utcParts(next).day).toBe(28);
    });
  });

  describe('weekly recurrence', () => {
    it('should add 7 days', () => {
      const current = toUtcDate(2026, 1, 15); // Feb 15 UTC
      const next = calculateNextDate(current, 'weekly');
      expect(utcParts(next).year).toBe(2026);
      expect(utcParts(next).month).toBe(1); // still Feb
      expect(utcParts(next).day).toBe(22);
    });
  });

  describe('custom day intervals', () => {
    it('should handle "every 10 days"', () => {
      const current = toUtcDate(2026, 1, 15);
      const next = calculateNextDate(current, 'every 10 days');
      expect(utcParts(next).day).toBe(25);
    });

    it('should handle "every 1 day" (singular)', () => {
      const current = toUtcDate(2026, 1, 15);
      const next = calculateNextDate(current, 'every 1 day');
      expect(utcParts(next).day).toBe(16);
    });

    it('should handle "every 45 days" crossing months', () => {
      const current = toUtcDate(2026, 1, 15); // Feb 15 UTC
      const next = calculateNextDate(current, 'every 45 days');
      expect(utcParts(next).month).toBe(3); // April
      expect(utcParts(next).day).toBe(1);
    });
  });

  describe('all standard patterns from Feb 15, 2026', () => {
    const current = toUtcDate(2026, 1, 15);

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
        if (expected.year) expect(utcParts(next).year).toBe(expected.year);
        expect(utcParts(next).month).toBe(expected.month);
        expect(utcParts(next).day).toBe(expected.day);
      });
    }
  });
});
