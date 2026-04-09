/**
 * Recurrence Service
 * Mirrors: apps/backend/services/recurrence_service.py
 */

const SUPPORTED_PATTERNS = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

function toUtcDateOnly(dateLike) {
  const source = new Date(dateLike);
  return new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()));
}

function addDaysUtc(dateLike, days) {
  const result = toUtcDateOnly(dateLike);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function addMonthsClampedUtc(dateLike, monthDelta) {
  const base = toUtcDateOnly(dateLike);
  const originalDay = base.getUTCDate();
  const targetFirst = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + monthDelta, 1));
  const lastDay = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)).getUTCDate();
  const targetDay = Math.min(originalDay, lastDay);
  return new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth(), targetDay));
}

export function calculateNextDate(currentDate, recurrencePattern) {
  if (!recurrencePattern) return null;
  const pattern = recurrencePattern.toLowerCase().trim();

  if (pattern === 'daily') {
    return addDaysUtc(currentDate, 1);
  }
  if (pattern === 'weekly') {
    return addDaysUtc(currentDate, 7);
  }
  if (pattern === 'biweekly') {
    return addDaysUtc(currentDate, 14);
  }
  if (pattern === 'monthly') {
    return addMonthsClampedUtc(currentDate, 1);
  }
  if (pattern === 'quarterly') {
    return addMonthsClampedUtc(currentDate, 3);
  }
  if (pattern === 'yearly') {
    return addMonthsClampedUtc(currentDate, 12);
  }

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
