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

import { toAppTz, toUtc } from '../../lib/timezone.js';

const SUPPORTED_PATTERNS = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

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

  // Custom: "every N days"
  const match = pattern.match(/^every\s+(\d+)\s+days?$/);
  if (match) {
    return addDaysUtc(currentDate, parseInt(match[1], 10));
  }

  return null;
}

export function isValidPattern(pattern) {
  if (!pattern) return false;
  return SUPPORTED_PATTERNS.includes(pattern.toLowerCase().trim());
}

export function getSupportedPatterns() {
  return [...SUPPORTED_PATTERNS];
}
