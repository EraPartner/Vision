import { describe, it, expect } from 'vitest';
import { expandOccurrences } from '../../src/lib/calculations/recurrence.js';

/**
 * Shared horizon-expansion loop (formerly duplicated in cashflowForecast and the
 * aiChat planned tools). Semantics mirror cashflowForecast — the app-tz-correct
 * reference: dates advance in APP_TIMEZONE and the horizon boundary is INCLUSIVE.
 * Default APP_TIMEZONE is Europe/Brussels.
 */
describe('expandOccurrences', () => {
  it('includes the base occurrence as the first element', () => {
    const out = expandOccurrences(
      { planned_date: '2026-01-15', is_recurring: true, recurrence_pattern: 'monthly' },
      '2026-01-15',
    );
    expect(out[0]).toBe('2026-01-15');
  });

  it('expands monthly and INCLUDES an occurrence landing exactly on the horizon', () => {
    const out = expandOccurrences(
      { planned_date: '2026-01-15', is_recurring: true, recurrence_pattern: 'monthly' },
      '2026-04-15',
    );
    expect(out).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
  });

  it('excludes an occurrence one day past the horizon (boundary is inclusive, not open)', () => {
    const out = expandOccurrences(
      { planned_date: '2026-01-15', is_recurring: true, recurrence_pattern: 'monthly' },
      '2026-04-14',
    );
    expect(out).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
  });

  it('clamps month-end in APP_TIMEZONE wall-clock (Jan 31 -> Feb 28), the behavior the UTC-slice aiChat loop got wrong', () => {
    const out = expandOccurrences(
      { planned_date: '2026-01-31', is_recurring: true, recurrence_pattern: 'monthly' },
      '2026-03-31',
    );
    // App-tz month clamp: Jan 31 -> Feb 28 -> Mar 28 (day tracks the last actual day).
    expect(out).toEqual(['2026-01-31', '2026-02-28', '2026-03-28']);
  });

  it('advances weekly across the spring DST boundary in clean 7-day calendar steps', () => {
    // Europe/Brussels springs forward on 2026-03-29; the app-tz-correct loop keeps
    // the day-of-week stable rather than shifting a day at the transition.
    const out = expandOccurrences(
      { planned_date: '2026-03-22', is_recurring: true, recurrence_pattern: 'weekly' },
      '2026-04-15',
    );
    expect(out).toEqual(['2026-03-22', '2026-03-29', '2026-04-05', '2026-04-12']);
  });

  it('returns the single date for a non-recurring row within the horizon', () => {
    expect(
      expandOccurrences({ planned_date: '2026-02-10', is_recurring: false }, '2026-06-01'),
    ).toEqual(['2026-02-10']);
  });

  it('returns an empty list for a non-recurring row past the horizon', () => {
    expect(
      expandOccurrences({ planned_date: '2026-07-10', is_recurring: false }, '2026-06-01'),
    ).toEqual([]);
  });

  it('accepts a pg-style local-midnight Date and recovers the stored calendar day', () => {
    const pgDate = new Date(2026, 4, 15); // local midnight May 15 2026
    const out = expandOccurrences(
      { planned_date: pgDate, is_recurring: true, recurrence_pattern: 'monthly' },
      '2026-06-15',
    );
    expect(out).toEqual(['2026-05-15', '2026-06-15']);
  });
});
