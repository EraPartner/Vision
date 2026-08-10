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

  it('truncates at the 500-occurrence cap BEFORE reaching the horizon for a stale daily row', () => {
    // A daily row anchored 731 days before the horizon exhausts the default
    // cap 232 days short of it: 500 occurrences, base first, ending
    // 2025-05-14 << 2026-01-01. This truncation is load-bearing for callers
    // that window the result AFTER expansion — it is exactly why
    // infoRepositoryPlanned could not reuse this function for its next-month
    // window and fast-forwards stale day-cadence anchors instead
    // (fastForwardYmd). Do not "fix" it here without auditing those windows.
    const out = expandOccurrences(
      { planned_date: '2024-01-01', is_recurring: true, recurrence_pattern: 'daily' },
      '2026-01-01',
    );
    expect(out).toHaveLength(500);
    expect(out[0]).toBe('2024-01-01');
    expect(out[out.length - 1]).toBe('2025-05-14');
  });

  it('honors a caller-supplied maxOccurrences cap', () => {
    const out = expandOccurrences(
      { planned_date: '2026-01-05', is_recurring: true, recurrence_pattern: 'weekly' },
      '2026-12-31',
      { maxOccurrences: 3 },
    );
    expect(out).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
  });

  // PRESERVED DIVERGENCE (documented in lib/calculations/recurrence.js): this
  // Date-space walk keeps the anchor's UTC time-of-day, so a summer-anchored
  // day cadence crossing the fall-back DST transition (Europe/Brussels,
  // 2026-10-25) renders every later occurrence one calendar day EARLY — unlike
  // the string-space stepper (nextOccurrenceYmd), which infoRepositoryPlanned
  // uses and which is calendar-exact (Oct 14 + 2 weeks = Oct 28, not Oct 27).
  // These pins assert what forecast/AI-chat consumers get TODAY; changing them
  // means changing published schedules, which is a decision, not a refactor.
  it('PINS the fall-back drift: a summer-anchored weekly row lands a day early after DST ends', () => {
    const out = expandOccurrences(
      { planned_date: '2026-10-14', is_recurring: true, recurrence_pattern: 'weekly' },
      '2026-11-30',
    );
    expect(out).toEqual([
      '2026-10-14', '2026-10-21', '2026-10-27', '2026-11-03',
      '2026-11-10', '2026-11-17', '2026-11-24',
    ]);
  });

  it('PINS the fall-back drift: a summer-anchored daily row repeats the transition day and stops short of an inclusive horizon', () => {
    const out = expandOccurrences(
      { planned_date: '2026-10-23', is_recurring: true, recurrence_pattern: 'daily' },
      '2026-10-28',
    );
    // 2026-10-25 appears twice; 2026-10-28 is missing even though the horizon
    // is inclusive, because the drifted instant sits 23h past the horizon's
    // start-of-day.
    expect(out).toEqual([
      '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-25', '2026-10-26', '2026-10-27',
    ]);
  });
});
