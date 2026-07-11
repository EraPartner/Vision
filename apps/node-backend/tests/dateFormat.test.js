import { describe, it, expect } from 'vitest';
import { formatDateToYmd, formatPgDateToYmd } from '../src/lib/dateFormat.js';

describe('formatDateToYmd (UTC extraction)', () => {
  it('renders a UTC-anchored date by its UTC calendar day', () => {
    // e.g. a `new Date(Date.UTC(y, m, 1))` month window: the intended day is
    // the UTC one regardless of server timezone.
    expect(formatDateToYmd(new Date(Date.UTC(2026, 5, 1)))).toBe('2026-06-01');
    // End-of-day anchor (monthAfter - 1ms) stays on the last day in UTC.
    const lastMs = new Date(Date.UTC(2026, 6, 1)).getTime() - 1;
    expect(formatDateToYmd(new Date(lastMs))).toBe('2026-06-30');
  });
});

describe('formatPgDateToYmd (local extraction)', () => {
  it('preserves the local calendar day of a local-midnight Date', () => {
    // node-postgres parses a DATE column into server-local midnight; local
    // getters must keep the calendar day rather than roll it back via UTC.
    expect(formatPgDateToYmd(new Date(2026, 5, 1))).toBe('2026-06-01');
    expect(formatPgDateToYmd(new Date(2026, 0, 15))).toBe('2026-01-15');
  });

  it('zero-pads month and day', () => {
    expect(formatPgDateToYmd(new Date(2026, 2, 3))).toBe('2026-03-03');
  });

  it('handles a last-day-of-month local date (the period_end case) without shifting', () => {
    // new Date(year, monthIndex, 0) = last day of the previous month, at local
    // midnight — must not roll back a day.
    expect(formatPgDateToYmd(new Date(2026, 6, 0))).toBe('2026-06-30');
  });
});
