/**
 * Query-string helpers shared by /api/info sub-routers.
 */

import { todayAppDateString } from '../../lib/timezone.js';

/**
 * @typedef {import('../../types/express.js').ExpressRequest} ExpressRequest
 */

/**
 * @param {ExpressRequest} req
 * @returns {string}
 */
export function getTargetCurrency(req) {
  const raw = req.query.currency ?? req.query.target_currency;
  if (raw == null || raw === '') return 'EUR';

  const value = String(raw).toUpperCase().trim();
  return /^[A-Z]{3}$/.test(value) ? value : 'EUR';
}

/**
 * @param {any} raw
 * @returns {string|undefined}
 */
export function getMonthParam(raw) {
  if (raw == null || raw === '') return undefined;
  const value = String(raw).trim();
  if (/^\d{4}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 7);
  return undefined;
}

/**
 * @param {any} raw
 * @returns {boolean}
 */
export function isTruthyQueryParam(raw) {
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

/**
 * Default-aware boolean query-param parser. Unlike isTruthyQueryParam (which
 * always treats an absent value as false), this returns `defaultValue` when the
 * param is absent/empty, so sibling endpoints that intentionally default the
 * same flag differently (e.g. cashflow-forecast-methods defaults include_backtest
 * ON, -rolling defaults it OFF) can share one parser instead of hand-rolling
 * `!== 'false'` on one and `=== 'true'` on the other — which silently accepted
 * different spellings per endpoint. Accepts true/1/'true'/'1' → true,
 * false/0/'false'/'0' → false; any other value falls back to `defaultValue`.
 */
/**
 * @param {any} raw
 * @param {boolean} [defaultValue]
 * @returns {boolean}
 */
export function parseBoolQueryParam(raw, defaultValue = false) {
  if (raw == null || raw === '') return defaultValue;
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return defaultValue;
}

// Kept as the import point for the /api/info sub-routers; the implementation
// is the shared APP_TIMEZONE "today" (UTC read here was yesterday until
// 01:00/02:00 local in UTC+ zones).
/** @returns {string} */
export function getCurrentDateString() {
  return todayAppDateString();
}
