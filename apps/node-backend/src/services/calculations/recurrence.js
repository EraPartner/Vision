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
 * Contract:
 *   calculateNextDate(currentDate, recurrencePattern) → Date | null
 *   isValidPattern(pattern) → boolean
 *   getSupportedPatterns() → string[]
 */

import { toAppTz, toUtc, appDateStringToUtc, toAppDateString } from '../../lib/timezone.js';
import { formatDateToYmd } from '../../lib/dateFormat.js';

const SUPPORTED_PATTERNS = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

// Guard against infinite expansion on tiny custom intervals.
const MAX_OCCURRENCES = 500;

function addDaysUtc(dateLike, days) {
  const source = new Date(dateLike);
  const result = new Date(source.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Adds `monthDelta` months in APP_TIMEZONE wall-clock, clamping to the last
 * day of the target month when the source day doesn't exist (Jan 31 → Feb 28).
 * Preserves wall-clock hour/minute/second to avoid TZ-induced day shifts.
 */
function addMonthsClampedInAppTz(dateLike, monthDelta) {
  const source = new Date(dateLike);
  const zoned = toAppTz(source);
  const targetMonthIndex = zoned.month - 1 + monthDelta;
  const targetYear = zoned.year + Math.floor(targetMonthIndex / 12);
  // Double-modulo normalizes negative indices: e.g. -1 → 11 (December).
  const targetMonth0 = ((targetMonthIndex % 12) + 12) % 12;
  // Last day of target month (UTC-safe arithmetic for "0th of next month").
  const lastDay = new Date(Date.UTC(targetYear, targetMonth0 + 1, 0)).getUTCDate();
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

export function calculateNextDate(currentDate, recurrencePattern) {
  if (!recurrencePattern) return null;
  const pattern = recurrencePattern.toLowerCase().trim();

  if (pattern === 'daily') return addDaysUtc(currentDate, 1);
  if (pattern === 'weekly') return addDaysUtc(currentDate, 7);
  if (pattern === 'biweekly') return addDaysUtc(currentDate, 14);
  if (pattern === 'monthly') return addMonthsClampedInAppTz(currentDate, 1);
  if (pattern === 'quarterly') return addMonthsClampedInAppTz(currentDate, 3);
  if (pattern === 'yearly') return addMonthsClampedInAppTz(currentDate, 12);

  // Custom: "every N days" — N must be >= 1. "every 0 days" matches the regex
  // but returns the same date, which is an infinite loop for any caller that
  // advances until the date passes a target.
  const match = pattern.match(/^every\s+(\d+)\s+days?$/);
  if (match) {
    const days = parseInt(match[1], 10);
    return days >= 1 ? addDaysUtc(currentDate, days) : null;
  }

  return null;
}

export function isValidPattern(pattern) {
  if (!pattern) return false;
  const normalized = pattern.toLowerCase().trim();
  if (SUPPORTED_PATTERNS.includes(normalized)) return true;
  // Must mirror calculateNextDate's custom grammar: "every N days", N >= 1.
  // (The old version rejected this, so it was useless as a guard and no caller
  // used it — a typo like "fortnightly" stored fine and then never advanced.)
  const match = normalized.match(/^every\s+(\d+)\s+days?$/);
  return match ? parseInt(match[1], 10) >= 1 : false;
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
export function expandOccurrences(row, horizonYmd, { maxOccurrences = MAX_OCCURRENCES } = {}) {
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
