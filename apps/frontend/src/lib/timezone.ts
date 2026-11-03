/**
 * Timezone-safe date utilities.
 *
 * Always prefer these over `new Date(ymdString)` for date-only values.
 * `new Date("YYYY-MM-DD")` parses as UTC midnight, which shifts the
 * calendar date in any timezone east of UTC.
 */

import { differenceInDays, parseLocalDateFromYmd, toYmd } from '@/lib/dateUtils';

export { toYmd } from '@/lib/dateUtils';

/** Today's date at local midnight (00:00:00.000). */
export function todayLocal(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

/** Today's date as a local "YYYY-MM-DD" string. */
export function todayYmd(): string {
    return toYmd(new Date());
}

/**
 * Whole local calendar days from `now` until the `ymd` day (0 = today,
 * negative once it has passed). Counts days, not elapsed hours, so a 23- or
 * 25-hour DST day cannot move the result.
 */
export function calendarDaysUntil(ymd: string, now: Date = new Date()): number {
    return differenceInDays(parseLocalDateFromYmd(ymd), now);
}
