import { describe, it, expect, afterEach } from 'vitest';
import { formatDateToYmd } from '../src/lib/dateFormat.js';

// pg reads DATE columns as LOCAL-midnight Date objects. These tests pin the
// local-extraction contract under a TZ east of UTC, where the old
// toISOString-based implementation rendered every value one day early.
const prevTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = prevTz;
});

describe('formatDateToYmd (local extraction)', () => {
  it('formats a pg-read DATE (local midnight) to its own calendar day east of UTC', () => {
    process.env.TZ = 'Europe/Brussels';
    const pgRead = new Date(2026, 5, 1); // local midnight, June 1
    // Old UTC extraction: toISOString() → '2026-05-31T22:00:00.000Z' → '2026-05-31'.
    expect(formatDateToYmd(pgRead)).toBe('2026-06-01');
  });

  it('formats a locally-constructed month end to the last day (period_end regression)', () => {
    process.env.TZ = 'Europe/Brussels';
    // infoRepo.monthly builds period_end as new Date(y, m, 0) — under UTC
    // extraction this rendered as the SECOND-to-last day of the month.
    expect(formatDateToYmd(new Date(2026, 6, 0))).toBe('2026-06-30');
    expect(formatDateToYmd(new Date(2026, 2, 0))).toBe('2026-02-28');
  });

  it('is identity-stable in UTC (no behavior change for UTC deployments)', () => {
    process.env.TZ = 'UTC';
    expect(formatDateToYmd(new Date(2026, 0, 15))).toBe('2026-01-15');
  });
});
