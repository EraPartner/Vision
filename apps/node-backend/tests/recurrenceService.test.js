/**
 * Recurrence Service Tests
 * Mirrors: apps/backend/tests (recurrence patterns from test_planned_transactions.py)
 */

import { describe, it, expect } from 'vitest';
import { calculateNextDate, isValidPattern, getSupportedPatterns } from '../src/services/recurrenceService.js';

describe('RecurrenceService', () => {
  describe('calculateNextDate', () => {
    it('calculates daily', () => {
      const d = new Date('2026-02-15');
      const next = calculateNextDate(d, 'daily');
      expect(next.toISOString().split('T')[0]).toBe('2026-02-16');
    });

    it('calculates weekly', () => {
      const d = new Date('2026-02-15');
      const next = calculateNextDate(d, 'weekly');
      expect(next.toISOString().split('T')[0]).toBe('2026-02-22');
    });

    it('calculates biweekly', () => {
      const d = new Date('2026-02-15');
      const next = calculateNextDate(d, 'biweekly');
      expect(next.toISOString().split('T')[0]).toBe('2026-03-01');
    });

    it('calculates monthly', () => {
      const d = new Date('2026-02-15');
      const next = calculateNextDate(d, 'monthly');
      expect(next.toISOString().split('T')[0]).toBe('2026-03-15');
    });

    it('calculates quarterly', () => {
      const d = new Date('2026-02-15');
      const next = calculateNextDate(d, 'quarterly');
      expect(next.toISOString().split('T')[0]).toBe('2026-05-15');
    });

    it('calculates yearly', () => {
      const d = new Date('2026-02-15');
      const next = calculateNextDate(d, 'yearly');
      expect(next.toISOString().split('T')[0]).toBe('2027-02-15');
    });

    it('calculates custom "every 10 days"', () => {
      const d = new Date('2026-02-15');
      const next = calculateNextDate(d, 'every 10 days');
      expect(next.toISOString().split('T')[0]).toBe('2026-02-25');
    });

    it('returns null for unsupported pattern', () => {
      expect(calculateNextDate(new Date(), 'invalid')).toBe(null);
    });

    it('returns null for empty pattern', () => {
      expect(calculateNextDate(new Date(), '')).toBe(null);
    });

    it('returns null for null pattern', () => {
      expect(calculateNextDate(new Date(), null)).toBe(null);
    });

    it('is case insensitive', () => {
      const d = new Date('2026-02-15');
      const next = calculateNextDate(d, 'MONTHLY');
      expect(next.toISOString().split('T')[0]).toBe('2026-03-15');
    });
  });

  describe('isValidPattern', () => {
    it('returns true for valid patterns', () => {
      expect(isValidPattern('daily')).toBe(true);
      expect(isValidPattern('weekly')).toBe(true);
      expect(isValidPattern('monthly')).toBe(true);
      expect(isValidPattern('quarterly')).toBe(true);
      expect(isValidPattern('yearly')).toBe(true);
    });

    it('returns false for invalid', () => {
      expect(isValidPattern('invalid')).toBe(false);
      expect(isValidPattern('')).toBe(false);
      expect(isValidPattern(null)).toBe(false);
    });
  });

  describe('getSupportedPatterns', () => {
    it('returns array of patterns', () => {
      const patterns = getSupportedPatterns();
      expect(patterns).toContain('daily');
      expect(patterns).toContain('monthly');
      expect(patterns).toContain('yearly');
      expect(patterns.length).toBeGreaterThanOrEqual(5);
    });
  });
});
