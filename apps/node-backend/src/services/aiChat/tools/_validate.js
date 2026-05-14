/**
 * Minimal arg validators for AI-chat tools.
 *
 * The LLM emits JSON arguments; we must treat them as untrusted input
 * (malformed dates, NaN, SQL-unsafe strings, array overflows).
 *
 * These helpers coerce + throw with a stable error shape so the tool
 * dispatcher can feed the error back to the model for retry.
 */

export class ToolValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ToolValidationError';
    this.field = field || null;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new ToolValidationError(`${field} must be an ISO date (YYYY-MM-DD)`, field);
  }
  const d = new Date(`${value}T00:00:00Z`);
  // `new Date('2025-02-30T00:00:00Z')` silently rolls to Mar 2 instead of
  // throwing. Reject any string that doesn't round-trip — otherwise the bad
  // date reaches SQL as an opaque error instead of a clean validation error.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ToolValidationError(`${field} is not a valid date`, field);
  }
  return value;
}

export function requireDate(value, field) {
  const parsed = parseDate(value, field);
  if (!parsed) throw new ToolValidationError(`${field} is required`, field);
  return parsed;
}

export function parsePositiveInt(value, field, { min = 1, max = 1000, defaultValue = null } = {}) {
  if (value == null) return defaultValue;
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ToolValidationError(
      `${field} must be an integer between ${min} and ${max}`,
      field,
    );
  }
  return n;
}

export function parseEnum(value, field, allowed, { defaultValue = null, required = false } = {}) {
  if (value == null) {
    if (required) throw new ToolValidationError(`${field} is required`, field);
    return defaultValue;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ToolValidationError(
      `${field} must be one of: ${allowed.join(', ')}`,
      field,
    );
  }
  return value;
}

export function assertDateOrder(from, to) {
  if (from && to && from > to) {
    throw new ToolValidationError('`from` must be on or before `to`', 'from');
  }
}
