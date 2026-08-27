/**
 * Minimal arg validators for AI-chat tools.
 *
 * The LLM emits JSON arguments; we must treat them as untrusted input
 * (malformed dates, NaN, SQL-unsafe strings, array overflows).
 *
 * These helpers coerce + throw with a stable error shape so the tool
 * dispatcher can feed the error back to the model for retry.
 */

import { validateId } from '../../../lib/validation.js';

/**
 * Per-turn context threaded through every tool's `run(args, context)` by
 * `dispatchTool` (see ./index.js). `cache` is the per-turn memoization Map
 * (../toolCache.js); `maxRows` bounds a tool's own row scans.
 * @typedef {object} ToolContext
 * @property {number} [maxRows]
 * @property {Map<string, Promise<any>>} [cache]
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
 * Bounded positive integer — the tools' `limit`/`topN`/`year` knobs *and* their
 * `categoryId`/`recipientId`/`plannedId` arguments.
 *
 * Shape is `validateId`'s, so an id the model emits here is parsed by exactly
 * the same rule as one arriving on a route: a plain base-10 digit string or an
 * integer number, nothing else. It used to be `parseInt`, which took the
 * leading digits of anything — `"12abc"` and `"12.9"` both became 12, so a
 * malformed id operated on the wrong record instead of erroring. That failure
 * mode is worse here than anywhere else in the codebase: the caller is a model,
 * so an error it can read is something it can correct, while a silently wrong
 * record is something nothing in the loop notices.
 *
 * `min`/`max` are the caller's own bounds and stay separate from the shape
 * check — `year` starts at 2000, `minOccurrences` at 2.
 * @param {unknown} value
 * @param {string} field
 * @param {{ min?: number, max?: number, defaultValue?: number|null }} [opts]
 * @returns {number|null}
 */
export function parsePositiveInt(value, field, { min = 1, max = 1000, defaultValue = null } = {}) {
  if (value == null) return defaultValue;
  const result = validateId(value, field, max);
  if (!result.valid || result.value < min) {
    // The received value is echoed because the message is fed straight back to
    // the model (dispatchTool's formatError): "must be an integer between 1 and
    // 500" alone does not tell it what was wrong with "12.9".
    let received;
    try { received = JSON.stringify(value); } catch { received = String(value); }
    throw new ToolValidationError(
      `${field} must be an integer between ${min} and ${max} — received ${received.slice(0, 60)}`,
      field,
    );
  }
  return result.value;
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
