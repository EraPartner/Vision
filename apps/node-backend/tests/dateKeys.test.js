import { describe, expect, it } from 'vitest';
import { addDaysUtc, extractYearMonth, formatYearMonthKey, getDayKeyUtc } from '../src/lib/dateKeys.js';

describe('date key helpers', () => {
  it('formats one-based months with zero padding', () => {
    expect(formatYearMonthKey(2026, 1)).toBe('2026-01');
    expect(formatYearMonthKey('2026', '12')).toBe('2026-12');
  });

  it('advances UTC calendar days across year boundaries without mutating the input', () => {
    const original = new Date('2025-12-31T23:30:00.000Z');
    const next = addDaysUtc(original);

    expect(next.toISOString()).toBe('2026-01-01T23:30:00.000Z');
    expect(original.toISOString()).toBe('2025-12-31T23:30:00.000Z');
  });

  it('supports explicit negative UTC day offsets', () => {
    expect(addDaysUtc(new Date('2026-03-01T00:00:00.000Z'), -1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('formats a UTC day key independently of local timezone', () => {
    expect(getDayKeyUtc(new Date('2026-01-02T00:30:00.000Z'))).toBe('2026-01-02');
  });

  it('extracts the year-month prefix from normalized date strings', () => {
    expect(extractYearMonth('2026-08-26')).toBe('2026-08');
  });
});
