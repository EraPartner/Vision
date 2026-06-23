import { describe, it, expect } from 'vitest';
import { runGolden } from '../golden/runGolden.js';
import { calculateNextDate, isValidPattern } from '../../src/services/calculations/recurrence.js';

/**
 * Golden-fixture regression suite for services/calculations/recurrence.
 * Fixture inputs: { currentDate: ISO string, pattern: string }.
 * Output is normalized to { next: ISO string | null } so JSON round-trip is stable.
 */
function runPattern({ currentDate, pattern }) {
  const result = calculateNextDate(new Date(currentDate), pattern);
  return { next: result ? result.toISOString() : null };
}

describe('recurrence golden', () => {
  it('daily (+1 day)', async () => {
    await runGolden('recurrence/daily', runPattern);
  });

  it('weekly (+7 days)', async () => {
    await runGolden('recurrence/weekly', runPattern);
  });

  it('biweekly (+14 days)', async () => {
    await runGolden('recurrence/biweekly', runPattern);
  });

  it('monthly (+1 month)', async () => {
    await runGolden('recurrence/monthly', runPattern);
  });

  it('monthly-jan31-clamp (Jan 31 → Feb 28 in non-leap year)', async () => {
    await runGolden('recurrence/monthly-jan31-clamp', runPattern);
  });

  it('monthly-jan31-clamp-leap (Jan 31 → Feb 29 in leap year 2028)', async () => {
    await runGolden('recurrence/monthly-jan31-clamp-leap', runPattern);
  });

  it('quarterly (+3 months)', async () => {
    await runGolden('recurrence/quarterly', runPattern);
  });

  it('yearly (Feb 29 leap day + 1 year → Feb 28)', async () => {
    await runGolden('recurrence/yearly', runPattern);
  });

  it('custom every-10-days regex', async () => {
    await runGolden('recurrence/custom-every-10-days', runPattern);
  });

  it('invalid pattern returns null', async () => {
    await runGolden('recurrence/invalid-pattern', runPattern);
  });
});

describe('isValidPattern', () => {
  it('accepts the named patterns', () => {
    for (const p of ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']) {
      expect(isValidPattern(p)).toBe(true);
    }
  });

  it('accepts "every N days" with N >= 1 (matches calculateNextDate grammar)', () => {
    expect(isValidPattern('every 10 days')).toBe(true);
    expect(isValidPattern('every 1 day')).toBe(true);
    expect(isValidPattern('every 0 days')).toBe(false); // no forward progress
  });

  it('rejects typos and empty values', () => {
    expect(isValidPattern('fortnightly')).toBe(false);
    expect(isValidPattern('')).toBe(false);
    expect(isValidPattern(undefined)).toBe(false);
  });
});
