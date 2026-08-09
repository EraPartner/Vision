import { describe, it, expect } from 'vitest';
import {
  parseRecurrenceStep,
  nextOccurrenceYmd,
  fastForwardYmd,
  calculateNextDate,
  isValidPattern,
} from '../../src/lib/calculations/recurrence.js';
import { appDateStringToUtc, toAppDateString } from '../../src/lib/timezone.js';

/**
 * Shared string-space stepper — the single recurrence grammar both steppers
 * dispatch off (parseRecurrenceStep), extracted from infoRepositoryPlanned's
 * private twin so a pattern added once flows to string-space AND Date-space.
 *
 * The string-space cases below pin the exact sequences the old private
 * implementation produced (verified 0/29k-mismatch against a verbatim copy);
 * the equivalence and divergence blocks pin its relationship to the Date-space
 * stepper: identical everywhere EXCEPT day-based steps whose walk starts on a
 * DST (summer-offset) anchor and crosses APP_TIMEZONE's fall-back transition —
 * a pre-existing divergence that is preserved, not fixed (see the module
 * header in lib/calculations/recurrence.js). Default APP_TIMEZONE is
 * Europe/Brussels.
 */
describe('parseRecurrenceStep (the one grammar)', () => {
  it.each([
    ['daily', { unit: 'day', amount: 1 }],
    ['weekly', { unit: 'day', amount: 7 }],
    ['biweekly', { unit: 'day', amount: 14 }],
    ['monthly', { unit: 'month', amount: 1 }],
    ['quarterly', { unit: 'month', amount: 3 }],
    ['yearly', { unit: 'month', amount: 12 }],
    ['every 1 day', { unit: 'day', amount: 1 }],
    ['every 10 days', { unit: 'day', amount: 10 }],
    ['  EVERY 5 DAYS ', { unit: 'day', amount: 5 }],
    [' Monthly ', { unit: 'month', amount: 1 }],
  ])('parses %j', (pattern, step) => {
    expect(parseRecurrenceStep(pattern)).toEqual(step);
  });

  it.each([
    ['every 0 days'], // matches the regex but makes no forward progress
    ['fortnightly'],
    [''],
    [undefined],
    ['every day'],
  ])('rejects %j as undefined', (pattern) => {
    expect(parseRecurrenceStep(pattern)).toBeUndefined();
  });

  it('agrees with isValidPattern on the whole grammar', () => {
    for (const p of ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'every 3 days', 'every 0 days', 'fortnightly']) {
      expect(parseRecurrenceStep(p) !== undefined).toBe(isValidPattern(p));
    }
  });
});

describe('nextOccurrenceYmd (string-space stepper)', () => {
  it.each([
    ['daily', '2026-06-15', '2026-06-16'],
    ['weekly', '2026-06-15', '2026-06-22'],
    ['biweekly', '2026-06-15', '2026-06-29'],
    ['every 10 days', '2026-06-15', '2026-06-25'],
    ['weekly', '2026-12-29', '2027-01-05'], // year rollover
  ])('%s: %s -> %s', (pattern, ymd, next) => {
    expect(nextOccurrenceYmd(ymd, pattern)).toBe(next);
  });

  it('clamps monthly at month-end: Jan 31 -> Feb 28 in a non-leap year', () => {
    expect(nextOccurrenceYmd('2026-01-31', 'monthly')).toBe('2026-02-28');
  });

  it('clamps monthly to Feb 29 in a leap year', () => {
    expect(nextOccurrenceYmd('2028-01-31', 'monthly')).toBe('2028-02-29');
  });

  it('compounds the clamp across sequential hops (Jan 31 -> Feb 28 -> Mar 28, never back to the 31st)', () => {
    const feb = nextOccurrenceYmd('2026-01-31', 'monthly');
    const mar = nextOccurrenceYmd(feb, 'monthly');
    expect([feb, mar]).toEqual(['2026-02-28', '2026-03-28']);
  });

  it('clamps quarterly (Jan 31 -> Apr 30) and yearly from a leap day (2028-02-29 -> 2029-02-28)', () => {
    expect(nextOccurrenceYmd('2026-01-31', 'quarterly')).toBe('2026-04-30');
    expect(nextOccurrenceYmd('2028-02-29', 'yearly')).toBe('2029-02-28');
  });

  it('returns undefined for a pattern the grammar cannot advance', () => {
    expect(nextOccurrenceYmd('2026-06-15', 'fortnightly')).toBeUndefined();
    expect(nextOccurrenceYmd('2026-06-15', 'every 0 days')).toBeUndefined();
    expect(nextOccurrenceYmd('2026-06-15', undefined)).toBeUndefined();
  });
});

describe('string-space vs Date-space steppers', () => {
  /** Walk `steps` string-space hops from `anchor`. */
  const stringWalk = (anchor, pattern, steps) => {
    const out = [];
    let cur = anchor;
    for (let i = 0; i < steps; i++) {
      cur = nextOccurrenceYmd(cur, pattern);
      out.push(cur);
    }
    return out;
  };
  /** Walk `steps` calculateNextDate hops from start-of-day(anchor), rendered per app TZ. */
  const dateWalk = (anchor, pattern, steps) => {
    const out = [];
    let cur = appDateStringToUtc(anchor);
    for (let i = 0; i < steps; i++) {
      cur = calculateNextDate(cur, pattern);
      out.push(toAppDateString(cur));
    }
    return out;
  };

  it('month-based patterns produce identical sequences from ANY anchor (incl. month-end and leap day)', () => {
    for (const pattern of ['monthly', 'quarterly', 'yearly']) {
      for (const anchor of ['2026-01-31', '2026-02-28', '2028-01-31', '2028-02-29', '2026-06-15', '2026-12-31']) {
        expect(stringWalk(anchor, pattern, 30)).toEqual(dateWalk(anchor, pattern, 30));
      }
    }
  });

  it('day-based patterns produce identical sequences from a winter (standard-offset) anchor across BOTH DST transitions', () => {
    // A winter start-of-day instant sits at 23:00Z; +N UTC days keeps 23:00Z,
    // which renders as midnight CET in winter and 01:00 CEST in summer —
    // always the calendar-exact day. 500 daily steps span spring AND fall.
    for (const [pattern, steps] of [['daily', 500], ['weekly', 80], ['biweekly', 40], ['every 3 days', 200]]) {
      expect(stringWalk('2026-01-05', pattern, steps)).toEqual(dateWalk('2026-01-05', pattern, steps));
    }
  });

  it('PINS the pre-existing divergence: a summer-anchored day step crossing fall-back lands a day EARLY in Date-space', () => {
    // 2026-10-25 is Europe/Brussels' fall-back Sunday. The string-space
    // stepper is calendar-exact (Oct 20 + 7 = Oct 27) — the behavior
    // getPlannedExpensesNextMonth has always had. The Date-space stepper keeps
    // the anchor's UTC time-of-day (22:00Z for a CEST start-of-day), which
    // renders as 23:00 CET the PREVIOUS calendar day once DST ends — the
    // behavior expandOccurrences consumers (cashflow forecast, AI-chat
    // planned tools) have always had. Unifying either onto the other would
    // change schedules; both sides are preserved and pinned here.
    expect(nextOccurrenceYmd('2026-10-20', 'weekly')).toBe('2026-10-27');
    expect(toAppDateString(calculateNextDate(appDateStringToUtc('2026-10-20'), 'weekly'))).toBe('2026-10-26');

    // Daily even repeats the transition day in Date-space.
    expect(stringWalk('2026-10-24', 'daily', 2)).toEqual(['2026-10-25', '2026-10-26']);
    expect(dateWalk('2026-10-24', 'daily', 2)).toEqual(['2026-10-25', '2026-10-25']);
  });
});

describe('fastForwardYmd (optional fast-forward)', () => {
  it('jumps a stale biweekly anchor a whole number of steps, landing at least one step before the target', () => {
    // 2026-01-07 is 175 days before 2026-07-01; floor(175/14)-1 = 11 hops.
    const jumped = fastForwardYmd('2026-01-07', 'biweekly', '2026-07-01');
    expect(jumped).toBe('2026-06-10');
    // Phase preserved: the jump is exactly 11 sequential biweekly hops...
    let walked = '2026-01-07';
    for (let i = 0; i < 11; i++) walked = nextOccurrenceYmd(walked, 'biweekly');
    expect(walked).toBe(jumped);
    // ...and the next occurrences bracket the target without skipping it.
    expect(nextOccurrenceYmd(jumped, 'biweekly')).toBe('2026-06-24'); // still before
    expect(nextOccurrenceYmd('2026-06-24', 'biweekly')).toBe('2026-07-08'); // first at/after target
  });

  it('never skips an occurrence landing exactly ON the target (deficit an exact multiple of the step)', () => {
    // 2025-12-03 is exactly 210 = 15*14 days before 2026-07-01.
    const jumped = fastForwardYmd('2025-12-03', 'biweekly', '2026-07-01');
    expect(jumped).toBe('2026-06-17');
    expect(nextOccurrenceYmd(jumped, 'biweekly')).toBe('2026-07-01');
  });

  it('jumps a stale daily anchor to the day before the target', () => {
    // 242 days stale -> 241 one-day hops.
    expect(fastForwardYmd('2025-11-01', 'daily', '2026-07-01')).toBe('2026-06-30');
  });

  it('fast-forwards the custom "every N days" cadence on its own phase', () => {
    // 59 days deficit at step 3: floor(59/3)-1 = 18 hops = +54 days.
    const jumped = fastForwardYmd('2026-01-01', 'every 3 days', '2026-03-01');
    expect(jumped).toBe('2026-02-24');
    expect(nextOccurrenceYmd(jumped, 'every 3 days')).toBe('2026-02-27'); // still before the target
  });

  it('is a no-op within one step of the target, past the target, for month-based patterns, and for unadvanceable patterns', () => {
    expect(fastForwardYmd('2026-06-25', 'weekly', '2026-07-01')).toBe('2026-06-25'); // deficit 6 < 7
    expect(fastForwardYmd('2026-06-24', 'weekly', '2026-07-01')).toBe('2026-06-24'); // deficit == step
    expect(fastForwardYmd('2026-08-15', 'weekly', '2026-07-01')).toBe('2026-08-15'); // negative deficit
    // Month steps must compound their clamp sequentially (Jan 31 -> Feb 28 ->
    // Mar 28); a bulk jump would rewrite that, so they are never fast-forwarded.
    expect(fastForwardYmd('2020-01-31', 'monthly', '2026-07-01')).toBe('2020-01-31');
    expect(fastForwardYmd('2020-01-31', 'yearly', '2026-07-01')).toBe('2020-01-31');
    expect(fastForwardYmd('2020-01-31', 'fortnightly', '2026-07-01')).toBe('2020-01-31');
  });

  it('equals N sequential hops for a long random matrix (phase-exactness of the jump)', () => {
    for (const pattern of ['daily', 'weekly', 'biweekly', 'every 3 days', 'every 10 days']) {
      for (const anchor of ['2024-02-29', '2025-11-01', '2026-10-20']) {
        const target = '2027-03-15';
        const jumped = fastForwardYmd(anchor, pattern, target);
        // Walk sequentially until within the jump's landing zone.
        let walked = anchor;
        while (walked < jumped) walked = nextOccurrenceYmd(walked, pattern);
        expect(walked).toBe(jumped);
        expect(jumped < target).toBe(true);
      }
    }
  });
});
