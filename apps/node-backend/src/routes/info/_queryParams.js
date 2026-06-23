/**
 * Query-string helpers shared by /api/info sub-routers.
 */

import { todayAppDateString } from '../../lib/timezone.js';

export function getTargetCurrency(req) {
  const raw = req.query.currency ?? req.query.target_currency;
  if (raw == null || raw === '') return 'EUR';

  const value = String(raw).toUpperCase().trim();
  return /^[A-Z]{3}$/.test(value) ? value : 'EUR';
}

export function getMonthParam(raw) {
  if (raw == null || raw === '') return undefined;
  const value = String(raw).trim();
  if (/^\d{4}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 7);
  return undefined;
}

export function isTruthyQueryParam(raw) {
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

// Kept as the import point for the /api/info sub-routers; the implementation
// is the shared APP_TIMEZONE "today" (UTC read here was yesterday until
// 01:00/02:00 local in UTC+ zones).
export function getCurrentDateString() {
  return todayAppDateString();
}
