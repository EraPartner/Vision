/**
 * Minimal arg validators for AI-chat tools.
 *
 * The LLM emits JSON arguments; we must treat them as untrusted input
 * (malformed dates, NaN, SQL-unsafe strings, array overflows).
 *
 * These helpers coerce + throw with a stable error shape so the tool
 * dispatcher can feed the error back to the model for retry.
 */

/**
 * Per-turn context threaded through every tool's `run(args, context)` by
 * `dispatchTool` (see ./index.js). `cache` is the per-turn memoization Map
 * (../toolCache.js); `maxRows` bounds a tool's own row scans; `conversationId`
 * reaches the few tools that reference the conversation.
 * @typedef {object} ToolContext
 * @property {number} [maxRows]
 * @property {Map<string, Promise<any>>} [cache]
 * @property {string} [conversationId] UUID — `ai_conversations.id`.
 */

export class ToolValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} [field]
   */
  constructor(message, field) {
    super(message);
    this.name = 'ToolValidationError';
    this.field = field || null;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string|null}
 */
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

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function requireDate(value, field) {
  const parsed = parseDate(value, field);
  if (!parsed) throw new ToolValidationError(`${field} is required`, field);
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ min?: number, max?: number, defaultValue?: number|null }} [opts]
 * @returns {number|null}
 */
export function parsePositiveInt(value, field, { min = 1, max = 1000, defaultValue = null } = {}) {
  if (value == null) return defaultValue;
  // Non-string branch is passed through as-is (no coercion) — matches
  // original runtime behavior: a non-numeric non-string value fails the
  // isInteger check below rather than being silently Number()-coerced first.
  const n = typeof value === 'string' ? parseInt(value, 10) : /** @type {number} */ (value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ToolValidationError(
      `${field} must be an integer between ${min} and ${max}`,
      field,
    );
  }
  return n;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {readonly string[]} allowed
 * @param {{ defaultValue?: string|null, required?: boolean }} [opts]
 * @returns {string|null}
 */
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

/**
 * @param {string|null|undefined} from
 * @param {string|null|undefined} to
 * @returns {void}
 */
export function assertDateOrder(from, to) {
  if (from && to && from > to) {
    throw new ToolValidationError('`from` must be on or before `to`', 'from');
  }
}
