/**
 * Timezone boundary helpers (ADR-009).
 *
 * Storage = UTC. Business math = APP_TIMEZONE. Display = browser zone.
 *
 * All zoned wall-clock math inside services/calculations/* MUST go through
 * toAppTz / toUtc. No raw `new Date()` + offset arithmetic in calc modules.
 */

import { env } from "../config/env.ts";

const DEFAULT_ZONE = "Europe/Brussels";

function resolveZone() {
  const zone = env.APP_TIMEZONE;
  if (!zone) return DEFAULT_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(
      `Invalid APP_TIMEZONE: ${zone}. Use an IANA zone name (e.g. Europe/Brussels).`,
    );
  }
  return zone;
}

export const APP_TIMEZONE = resolveZone();

export interface AppTzParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Convert UTC Date to zoned wall-clock components.
 */
export function toAppTz(utcDate: Date, zone: string = APP_TIMEZONE): AppTzParts {
  if (!(utcDate instanceof Date) || Number.isNaN(utcDate.getTime())) {
    throw new TypeError("toAppTz requires a valid Date");
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utcDate);

  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  let year = get("year");
  let month = get("month");
  let day = get("day");
  let hour = get("hour");
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
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Convert zoned wall-clock components to a UTC Date.
 * Uses a fixed-point pass to handle DST boundaries.
 */
export function toUtc(
  {
    year,
    month,
    day,
    hour = 0,
    minute = 0,
    second = 0,
  }: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
  },
  zone: string = APP_TIMEZONE,
): Date {
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
export function toAppDateString(utcDate: Date, zone: string = APP_TIMEZONE): string {
  const { year, month, day } = toAppTz(utcDate, zone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Today's calendar date (YYYY-MM-DD) in APP_TIMEZONE.
 *
 * The single sanctioned source of "today" for business logic. Building it via
 * `new Date().toISOString()` reads the UTC calendar day, which is yesterday
 * between local midnight and 01:00/02:00 in UTC+ zones (ADR-009).
 */
export function todayAppDateString(zone: string = APP_TIMEZONE): string {
  return toAppDateString(new Date(), zone);
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseYmdParts(yyyyMmDd: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = YMD_RE.exec(yyyyMmDd);
  if (!match) throw new TypeError(`Expected YYYY-MM-DD, got: ${yyyyMmDd}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

const MS_PER_DAY = 86_400_000;

/**
 * Strict YYYY-MM-DD to an integer UTC calendar-day index. Throws for malformed
 * or normalized dates so callers cannot silently turn 2026-02-30 into March.
 */
export function ymdToEpochDay(yyyyMmDd: string): number {
  if (!YMD_RE.test(yyyyMmDd)) {
    throw new TypeError(`Expected YYYY-MM-DD, got: ${yyyyMmDd}`);
  }
  const ms = Date.parse(`${yyyyMmDd}T00:00:00.000Z`);
  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== yyyyMmDd
  ) {
    throw new TypeError(`Invalid calendar date: ${yyyyMmDd}`);
  }
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * Signed calendar-day difference, positive when `toYmd` is later.
 */
export function differenceInCalendarDaysYmd(fromYmd: string, toYmd: string): number {
  return ymdToEpochDay(toYmd) - ymdToEpochDay(fromYmd);
}

/**
 * Add `days` (may be negative) to a YYYY-MM-DD string. Pure calendar math —
 * no timezone involved, so the result is identical on every host.
 */
export function addDaysYmd(yyyyMmDd: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new TypeError(`days must be an integer, got: ${days}`);
  }
  const shifted = new Date((ymdToEpochDay(yyyyMmDd) + days) * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/**
 * First day of the month `monthOffset` months relative to a YYYY-MM-DD string
 * (0 = same month, -11 = eleven months back). Pure calendar math.
 */
export function firstOfMonthYmd(yyyyMmDd: string, monthOffset = 0): string {
  const { year, month } = parseYmdParts(yyyyMmDd);
  const shifted = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${m}-01`;
}

/**
 * Parse a YYYY-MM-DD string into a UTC Date representing start-of-day in APP_TIMEZONE.
 */
export function appDateStringToUtc(yyyyMmDd: string, zone: string = APP_TIMEZONE): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!match) throw new TypeError(`Expected YYYY-MM-DD, got: ${yyyyMmDd}`);
  const [, y, m, d] = match;
  return toUtc({ year: Number(y), month: Number(m), day: Number(d) }, zone);
}
