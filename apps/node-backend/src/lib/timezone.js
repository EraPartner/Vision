/**
 * Timezone boundary helpers (ADR-009).
 *
 * Storage = UTC. Business math = APP_TIMEZONE. Display = browser zone.
 *
 * All zoned wall-clock math inside services/calculations/* MUST go through
 * toAppTz / toUtc. No raw `new Date()` + offset arithmetic in calc modules.
 */

import { env } from '../config/env.js';

const DEFAULT_ZONE = 'Europe/Brussels';

function resolveZone() {
  const zone = env.APP_TIMEZONE;
  if (!zone) return DEFAULT_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(`Invalid APP_TIMEZONE: ${zone}. Use an IANA zone name (e.g. Europe/Brussels).`);
  }
  return zone;
}

export const APP_TIMEZONE = resolveZone();

/**
 * Convert UTC Date to zoned wall-clock components.
 */
export function toAppTz(utcDate, zone = APP_TIMEZONE) {
  if (!(utcDate instanceof Date) || Number.isNaN(utcDate.getTime())) {
    throw new TypeError('toAppTz requires a valid Date');
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(utcDate);

  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  let year = get('year');
  let month = get('month');
  let day = get('day');
  let hour = get('hour');
  // Some Intl implementations report hour=24 at midnight. Roll into next day
  // and re-normalize via Date.UTC to handle month/year overflow correctly.
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  return {
    year,
    month,
    day,
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * Convert zoned wall-clock components to a UTC Date.
 * Uses a fixed-point pass to handle DST boundaries.
 */
export function toUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, zone = APP_TIMEZONE) {
  let ts = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 2; i += 1) {
    const zoned = toAppTz(new Date(ts), zone);
    const zonedUtc = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = target - zonedUtc;
    if (diff === 0) break;
    ts += diff;
  }
  return new Date(ts);
}

/**
 * Format a UTC Date as YYYY-MM-DD in APP_TIMEZONE.
 */
export function toAppDateString(utcDate, zone = APP_TIMEZONE) {
  const { year, month, day } = toAppTz(utcDate, zone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parse a YYYY-MM-DD string into a UTC Date representing start-of-day in APP_TIMEZONE.
 */
export function appDateStringToUtc(yyyyMmDd, zone = APP_TIMEZONE) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!match) throw new TypeError(`Expected YYYY-MM-DD, got: ${yyyyMmDd}`);
  const [, y, m, d] = match;
  return toUtc({ year: Number(y), month: Number(m), day: Number(d) }, zone);
}
