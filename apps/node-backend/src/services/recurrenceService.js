/**
 * Recurrence Service
 * Mirrors: apps/backend/services/recurrence_service.py
 */

const SUPPORTED_PATTERNS = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

export function calculateNextDate(currentDate, recurrencePattern) {
  if (!recurrencePattern) return null;
  const pattern = recurrencePattern.toLowerCase().trim();
  const d = new Date(currentDate);

  if (pattern === 'daily') {
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (pattern === 'weekly') {
    d.setDate(d.getDate() + 7);
    return d;
  }
  if (pattern === 'biweekly') {
    d.setDate(d.getDate() + 14);
    return d;
  }
  if (pattern === 'monthly') {
    d.setMonth(d.getMonth() + 1);
    return d;
  }
  if (pattern === 'quarterly') {
    d.setMonth(d.getMonth() + 3);
    return d;
  }
  if (pattern === 'yearly') {
    d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  // Custom: "every N days"
  const match = pattern.match(/^every\s+(\d+)\s+days?$/);
  if (match) {
    d.setDate(d.getDate() + parseInt(match[1], 10));
    return d;
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
