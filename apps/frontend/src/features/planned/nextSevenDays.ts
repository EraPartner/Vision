/**
 * Window arithmetic for the Planned page's next-7-days strip.
 *
 * Semantics are lifted verbatim from the "Due this week" stat tile this
 * replaced: only `is_active` payments count, the due date is parsed by
 * splitting Y-M-D into a LOCAL midnight Date (never `new Date(str)`, which is
 * UTC midnight and shifts the calendar day east of UTC), and the window is
 * `differenceInDays(due, today) >= 0 && <= 7` — today plus the seven days
 * after it, eight columns in all.
 */

import { differenceInDays } from "@/lib/dateUtils";
import { parsePlannedDueDate, toLocalMidnight } from "@/features/planned/plannedDueDate";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

/** Days shown, inclusive of today: offsets 0…7 — the `days <= 7` window. */
export const WINDOW_DAYS = 8;

export interface DayBucket {
  /** Local-midnight Date for this column. */
  date: Date;
  /** 0 = today … 7 = today+7. */
  offset: number;
  items: PlannedPayment[];
}

export function bucketNextSevenDays(payments: PlannedPayment[], today: Date): DayBucket[] {
  const normalizedToday = toLocalMidnight(today);

  const buckets: DayBucket[] = Array.from({ length: WINDOW_DAYS }, (_, offset) => ({
    date: new Date(
      normalizedToday.getFullYear(),
      normalizedToday.getMonth(),
      normalizedToday.getDate() + offset,
      0, 0, 0, 0,
    ),
    offset,
    items: [],
  }));

  for (const p of payments) {
    if (!p.is_active) continue;
    const dueDate = parsePlannedDueDate(p.due_date);
    if (dueDate.kind !== "date") continue;
    const days = differenceInDays(dueDate.date, normalizedToday);
    if (days < 0 || days > WINDOW_DAYS - 1) continue;
    buckets[days].items.push(p);
  }

  for (const bucket of buckets) {
    // Biggest outflow first, so a day's headline item is the one that matters.
    bucket.items.sort((a, b) => a.amount - b.amount);
  }

  return buckets;
}
