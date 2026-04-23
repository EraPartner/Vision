/**
 * Timezone-safe date utilities.
 *
 * Always prefer these over `new Date(ymdString)` for date-only values.
 * `new Date("YYYY-MM-DD")` parses as UTC midnight, which shifts the
 * calendar date in any timezone east of UTC.
 */

export { parseLocalDateFromYmd as parseYmd, toYmd } from '@/components/shared/dateUtils';

/** Today's date at local midnight (00:00:00.000). */
export function todayLocal(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

/** Today's date as a local "YYYY-MM-DD" string. */
export function todayYmd(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Elapsed fractional days between two Date objects. */
export function daysBetween(from: Date, to: Date): number {
    return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
}
