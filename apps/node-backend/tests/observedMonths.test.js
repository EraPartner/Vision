import { describe, expect, it } from 'vitest';
import { countObservedMonths, monthKeyFromDbDate } from '../src/lib/observedMonths.js';

describe('observed-month helpers', () => {
  it.each([
    [null, null],
    ['2026-03-14', '2026-03'],
    [new Date(2026, 2, 14), '2026-03'],
    ['not-a-date', null],
  ])('normalizes a PostgreSQL DATE representation %p', (value, expected) => {
    expect(monthKeyFromDbDate(value)).toBe(expected);
  });

  it('counts empty elapsed months but not months before ledger start', () => {
    const march2026 = 2026 * 12 + 2;
    expect(countObservedMonths('2026-01', march2026, 24)).toBe(3);
  });

  it('clamps missing, future, and old ledger starts to the valid divisor range', () => {
    const march2026 = 2026 * 12 + 2;
    expect(countObservedMonths(null, march2026, 6)).toBe(1);
    expect(countObservedMonths('2026-04', march2026, 6)).toBe(1);
    expect(countObservedMonths('2020-01', march2026, 6)).toBe(6);
  });
});
