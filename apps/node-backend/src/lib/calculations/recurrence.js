/**
 * Recurrence date calculation module (Phase 3 relocation).
 *
 * Moved from services/recurrenceService.js. Pure calc — no IO, no DB.
 * Mirrors apps/backend/services/recurrence_service.py.
 *
 * Date math is TZ-aware: month-end clamping happens in APP_TIMEZONE wall-clock,
 * then converts back to UTC for storage. Prevents off-by-one shifts when the
 * scheduled hour is near midnight in a non-UTC zone (e.g. Jan 31 23:59 +01:00
 * must roll to Feb 28 23:59 +01:00, not Mar 1 / shifted by an hour).
 *
 * ONE grammar, TWO return shapes. The pattern grammar (daily/weekly/biweekly/
 * "every N days" + monthly/quarterly/yearly) lives ONLY in
 * {@link parseRecurrenceStep}; both steppers dispatch off it, so adding a
 * pattern there is the whole job — it can no longer land in one stepper and
 * silently miss the other:
 *
 *   - {@link calculateNextDate} — Date return value with APP_TIMEZONE
 *     wall-clock stepping. Used by /execute and {@link expandOccurrences}
 *     (cashflow forecast, AI-chat planned tools).
 *   - {@link nextOccurrenceYmd} — string-space ('YYYY-MM-DD' → 'YYYY-MM-DD'),
 *     with the optional {@link fastForwardYmd} jump. Used where an occurrence
 *     is a calendar day: infoRepositoryPlanned's next-month expansion.
 *
 * Both forms advance calendar days in APP_TIMEZONE. A day cadence therefore
 * stays exact across daylight-saving transitions: daily never repeats the
 * fall-back day and weekly never lands one wall-clock day early.
 *
 * Contract:
 *   parseRecurrenceStep(pattern) → { unit, amount } | undefined
 *   calculateNextDate(currentDate, recurrencePattern) → Date | null
 *   nextOccurrenceYmd(ymd, pattern) → string | undefined
 *   fastForwardYmd(ymd, pattern, targetYmd) → string
 *   isValidPattern(pattern) → boolean
 *   getSupportedPatterns() → string[]
 */

import {
  toAppTz,
  toUtc,
  appDateStringToUtc,
  toAppDateString,
  addDaysYmd,
  differenceInCalendarDaysYmd,
  firstOfMonthYmd,
} from "../timezone.js";
import { formatDateToYmd } from "../dateFormat.js";
import { PLANNED_RECURRENCE_PATTERNS } from "@vision/types/recurrence";

// The named cadences this module recognises, single-sourced in
// @vision/types/recurrence alongside the portfolio vocabulary that spells the
// same cadence 'bi-weekly'. Note this list is the *named* half of the grammar
// only — parseRecurrenceStep additionally accepts the custom `every N days`
// form, which is deliberately not a member.
const SUPPORTED_PATTERNS = PLANNED_RECURRENCE_PATTERNS;

/**
 * @typedef {object} RecurrenceStep
 * @property {'day'|'month'} unit Day steps have a fixed length; month steps
 *   vary per calendar month and clamp at month-end.
 * @property {number} amount Whole steps of `unit` per occurrence (>= 1).
 */

/**
 * THE recurrence pattern grammar — the single place a pattern is recognized.
 *
 * Named cadences: daily(1d) / weekly(7d) / biweekly(14d) / monthly(1m) /
 * quarterly(3m) / yearly(12m), plus the custom "every N days" form with
 * N >= 1 ("every 0 days" parses but is rejected: it makes no forward progress,
 * which is an infinite loop for any caller that advances until a target date
 * passes). Matching is case/whitespace-insensitive; anything else — including
 * `undefined` and non-strings — is undefined (never advanced, never valid).
 *
 * @param {string|null|undefined} pattern
 * @returns {RecurrenceStep|undefined}
 */
export function parseRecurrenceStep(pattern) {
  const p = String(pattern || "")
    .toLowerCase()
    .trim();
  if (p === "daily") return { unit: "day", amount: 1 };
  if (p === "weekly") return { unit: "day", amount: 7 };
  if (p === "biweekly") return { unit: "day", amount: 14 };
  if (p === "monthly") return { unit: "month", amount: 1 };
  if (p === "quarterly") return { unit: "month", amount: 3 };
  if (p === "yearly") return { unit: "month", amount: 12 };
  const match = p.match(/^every\s+(\d+)\s+days?$/);
  if (match) {
    const days = parseInt(match[1], 10);
    if (days >= 1) return { unit: "day", amount: days };
  }
  return undefined;
}

// Guard against infinite expansion on tiny custom intervals.
const MAX_OCCURRENCES = 500;

/**
 * Add days on the APP_TIMEZONE wall clock while preserving time-of-day. UTC
 * duration arithmetic is wrong here: a summer midnight plus seven UTC days
 * becomes 23:00 on the previous local day after fall-back.
 *
 * @param {string|number|Date} dateLike
 * @param {number} days
 * @returns {Date}
 */
function addDaysInAppTz(dateLike, days) {
  const source = new Date(dateLike);
  const zoned = toAppTz(source);
  const sourceYmd = `${String(zoned.year).padStart(4, "0")}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;
  const shiftedYmd = addDaysYmd(sourceYmd, days);
  return toUtc({
    year: Number(shiftedYmd.slice(0, 4)),
    month: Number(shiftedYmd.slice(5, 7)),
    day: Number(shiftedYmd.slice(8, 10)),
    hour: zoned.hour,
    minute: zoned.minute,
    second: zoned.second,
  });
}

/**
 * Adds `monthDelta` months in APP_TIMEZONE wall-clock, clamping to the last
 * day of the target month when the source day doesn't exist (Jan 31 → Feb 28).
 * Preserves wall-clock hour/minute/second to avoid TZ-induced day shifts.
 * @param {string|number|Date} dateLike
 * @param {number} monthDelta
 * @returns {Date}
 */
function addMonthsClampedInAppTz(dateLike, monthDelta) {
  const source = new Date(dateLike);
  const zoned = toAppTz(source);
  const targetMonthIndex = zoned.month - 1 + monthDelta;
  const targetYear = zoned.year + Math.floor(targetMonthIndex / 12);
  // Double-modulo normalizes negative indices: e.g. -1 → 11 (December).
  const targetMonth0 = ((targetMonthIndex % 12) + 12) % 12;
  // Last day of target month (UTC-safe arithmetic for "0th of next month").
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth0 + 1, 0),
  ).getUTCDate();
  const targetDay = Math.min(zoned.day, lastDay);
  return toUtc({
    year: targetYear,
    month: targetMonth0 + 1,
    day: targetDay,
    hour: zoned.hour,
    minute: zoned.minute,
    second: zoned.second,
  });
}

/**
 * Date-returning stepper: the occurrence after `currentDate`, or null for a
 * pattern {@link parseRecurrenceStep} can't advance. Day and month steps both
 * use APP_TIMEZONE wall-clock arithmetic, preserving the local time-of-day.
 *
 * @param {string|number|Date} currentDate
 * @param {string|null|undefined} recurrencePattern
 * @returns {Date|null}
 */
export function calculateNextDate(currentDate, recurrencePattern) {
  if (!recurrencePattern) return null;
  const step = parseRecurrenceStep(recurrencePattern.toLowerCase().trim());
  if (!step) return null;
  return step.unit === "day"
    ? addDaysInAppTz(currentDate, step.amount)
    : addMonthsClampedInAppTz(currentDate, step.amount);
}

/**
 * @param {string|null|undefined} pattern
 * @returns {boolean}
 */
export function isValidPattern(pattern) {
  if (!pattern) return false;
  // A pattern is valid iff the shared grammar can advance it — the same
  // "every N days", N >= 1 rule calculateNextDate applies. (The old version
  // rejected the custom form, so it was useless as a guard and no caller used
  // it — a typo like "fortnightly" stored fine and then never advanced.)
  return parseRecurrenceStep(pattern.toLowerCase().trim()) !== undefined;
}

/**
 * Add `months` to a 'YYYY-MM-DD' string, clamping the day to the last day of
 * the target month when it doesn't exist there (Jan 31 +1 month → Feb 28).
 *
 * String twin of addMonthsClampedInAppTz, which clamps on the APP_TIMEZONE
 * wall-clock day — for a start-of-day occurrence that is exactly this string's
 * day, so the landing day is identical without the Date round trip. Applied
 * one step at a time by the walking callers, so the clamp compounds the same
 * way sequential calculateNextDate hops do (Jan 31 → Feb 28 → Mar 28, NOT back
 * to Mar 31).
 *
 * @param {string} ymd 'YYYY-MM-DD'
 * @param {number} months
 * @returns {string}
 */
function addMonthsClampedYmd(ymd, months) {
  const day = parseInt(ymd.slice(8, 10), 10);
  const firstOfTarget = firstOfMonthYmd(ymd, months);
  const lastDayOfTarget = parseInt(
    addDaysYmd(firstOfMonthYmd(ymd, months + 1), -1).slice(8, 10),
    10,
  );
  return `${firstOfTarget.slice(0, 8)}${String(Math.min(day, lastDayOfTarget)).padStart(2, "0")}`;
}

/**
 * Whole days from `fromYmd` to `toYmd` (negative if `toYmd` is earlier). Pure
 * calendar math on the parsed components — host-timezone independent.
 *
 * @param {string} fromYmd 'YYYY-MM-DD'
 * @param {string} toYmd 'YYYY-MM-DD'
 * @returns {number}
 */
/**
 * String-space stepper: the occurrence after `ymd` for `pattern`, or undefined
 * for a pattern {@link parseRecurrenceStep} can't advance. Calendar-string
 * twin of {@link calculateNextDate} — same grammar by construction (both
 * dispatch off parseRecurrenceStep), pure ADR-009 calendar math, so an
 * occurrence lands on the same day on every host and never drifts across DST.
 *
 * @param {string} ymd 'YYYY-MM-DD'
 * @param {string|null|undefined} pattern
 * @returns {string|undefined}
 */
export function nextOccurrenceYmd(ymd, pattern) {
  const step = parseRecurrenceStep(pattern);
  if (!step) return undefined;
  return step.unit === "day"
    ? addDaysYmd(ymd, step.amount)
    : addMonthsClampedYmd(ymd, step.amount);
}

/**
 * Optional fast-forward for the string-space stepper: jump a stale day-stepped
 * anchor to just before `targetYmd` in one hop, so a caller's bounded walk
 * (e.g. infoRepositoryPlanned's 120-occurrence cap) can't be exhausted before
 * the window by a fast-cadence row last advanced long ago (a daily row >120
 * days stale used to silently vanish from the forecast that way).
 *
 * The jump is a whole number of steps — exactly equivalent to N sequential
 * hops for day-based patterns, so the cadence phase is preserved — landing at
 * least one full step BEFORE the target so the boundary occurrence is never
 * skipped. Month-based patterns are returned unchanged (their step length
 * varies and a bulk month jump would change the sequential month-end clamping
 * semantics: Jan 31 → Feb 28 → Mar 28, not Jan 31 +2 months → Mar 31), as is
 * any anchor already within one step of the target and any pattern the
 * grammar can't advance.
 *
 * @param {string} ymd 'YYYY-MM-DD' anchor
 * @param {string|null|undefined} pattern
 * @param {string} targetYmd 'YYYY-MM-DD' the day the caller wants to reach
 * @returns {string} the advanced anchor (or `ymd` unchanged)
 */
export function fastForwardYmd(ymd, pattern, targetYmd) {
  const step = parseRecurrenceStep(pattern);
  if (!step || step.unit !== "day") return ymd;
  const deficitDays = differenceInCalendarDaysYmd(ymd, targetYmd);
  if (deficitDays <= step.amount) return ymd;
  const hops = Math.floor(deficitDays / step.amount) - 1;
  if (hops <= 0) return ymd;
  return addDaysYmd(ymd, hops * step.amount);
}

export function getSupportedPatterns() {
  return [...SUPPORTED_PATTERNS];
}

/**
 * Parse a planned_date into a UTC Date at start-of-day in APP_TIMEZONE.
 *
 * node-postgres parses DATE columns into a JS Date at server-local midnight (no
 * custom type parser is registered); recover its calendar day with local getters
 * before re-parsing in APP_TIMEZONE. Y-M-D strings are sliced and re-parsed in
 * APP_TIMEZONE directly. This is the parser the cashflow forecast uses — the
 * app-tz-correct reference — so occurrence dates stay stable across DST.
 *
 * @param {string|Date} value
 * @returns {Date}
 */
function parsePlannedDate(value) {
  if (value instanceof Date) {
    return appDateStringToUtc(formatDateToYmd(value));
  }
  return appDateStringToUtc(String(value).slice(0, 10));
}

/**
 * Expand one planned-transaction row into the ordered list of occurrence dates
 * that fall on or before `horizonYmd` (INCLUSIVE), as APP_TIMEZONE 'YYYY-MM-DD'
 * strings.
 *
 * App-tz-correct: the base date is parsed in APP_TIMEZONE and each subsequent
 * firing is advanced via {@link calculateNextDate} (also APP_TIMEZONE), then
 * rendered with {@link toAppDateString}. This is the single source of truth for
 * the horizon-expansion loop that cashflow forecast and the AI-chat planned
 * tools previously re-implemented with divergent (UTC-slice) date semantics.
 *
 * - The first element is always the stored planned_date (the base occurrence).
 * - Non-recurring rows yield at most that single date (only if within horizon).
 * - The horizon boundary is inclusive (an occurrence landing exactly on
 *   `horizonYmd` is included), matching the cashflow forecast reference.
 *
 * @param {{ planned_date: string|Date, is_recurring?: boolean, recurrence_pattern?: string|null }} row
 * @param {string} horizonYmd  inclusive upper bound, 'YYYY-MM-DD'
 * @param {{ maxOccurrences?: number }} [opts]
 * @returns {string[]}  ordered occurrence dates, 'YYYY-MM-DD'
 */
export function expandOccurrences(
  row,
  horizonYmd,
  { maxOccurrences = MAX_OCCURRENCES } = {},
) {
  const end = appDateStringToUtc(horizonYmd);
  const first = parsePlannedDate(row.planned_date);
  const occurrences = [];

  if (!row.is_recurring || !row.recurrence_pattern) {
    if (first <= end) occurrences.push(toAppDateString(first));
    return occurrences;
  }

  let current = first;
  let count = 0;
  while (current <= end && count < maxOccurrences) {
    occurrences.push(toAppDateString(current));
    const next = calculateNextDate(current, row.recurrence_pattern);
    if (!next || next <= current) break; // safety: no forward progress
    current = next;
    count++;
  }
  return occurrences;
}
