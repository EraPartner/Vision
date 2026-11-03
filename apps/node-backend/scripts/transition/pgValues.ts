/**
 * Exact parsers for the text PostgreSQL 18 prints in a plain pg_dump
 * (DateStyle ISO, extra_float_digits 3, standard_conforming_strings on).
 *
 * Nothing here goes through a JavaScript number unless the SQLite column is
 * REAL: integers become BigInt, decimals stay text, timestamps are converted
 * with integer arithmetic on days and seconds.
 */

import { at } from "./util.ts";

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

// ---------------------------------------------------------------------------
// Integers
// ---------------------------------------------------------------------------

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER_TEXT = /^-?(0|[1-9][0-9]*)$/;

/** int2/int4/int8 output text -> BigInt (SQLite INTEGER is 64-bit). */
export function parsePgInteger(text: string): bigint {
  if (!INTEGER_TEXT.test(text) || text === "-0") throw new ValueError(`not an integer: ${text}`);
  const value = BigInt(text);
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new ValueError(`integer ${text} does not fit SQLite's 64-bit INTEGER`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Booleans
// ---------------------------------------------------------------------------

export function parsePgBoolean(text: string): bigint {
  if (text === "t") return 1n;
  if (text === "f") return 0n;
  throw new ValueError(`not a boolean: ${text}`);
}

// ---------------------------------------------------------------------------
// Floats
// ---------------------------------------------------------------------------

/** float4/float8 output with extra_float_digits > 0 (shortest exact form). */
const FLOAT_TEXT = /^-?(?:[0-9]+(?:\.[0-9]+)?(?:e[+-][0-9]+)?)$/;

export interface ParsedFloat {
  value: number;
  /** The input was negative zero; SQLite stores REAL -0.0 as 0. */
  negativeZero: boolean;
}

export function parsePgFloat(text: string): ParsedFloat {
  if (text === "NaN" || text === "Infinity" || text === "-Infinity") {
    throw new ValueError(`${text} cannot be stored: SQLite turns NaN into NULL and has no exact infinity in Vision's contract`);
  }
  if (!FLOAT_TEXT.test(text)) throw new ValueError(`not a floating-point number: ${text}`);
  const value = Number(text);
  if (!Number.isFinite(value)) throw new ValueError(`floating-point value out of range: ${text}`);
  if (Object.is(value, -0)) return { value: 0, negativeZero: true };
  return { value, negativeZero: false };
}

// ---------------------------------------------------------------------------
// Exact decimals (verification arithmetic, independent of the backend's)
// ---------------------------------------------------------------------------

export interface FixedDecimal {
  /** value = coef / 10^scale */
  coef: bigint;
  scale: number;
}

/** PostgreSQL numeric output: no exponent, no leading +, no leading zeros. */
const DECIMAL_OUTPUT = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Parse numeric output text exactly. NaN and the infinities are refused. */
export function parseFixed(text: string): FixedDecimal {
  if (/^-?(NaN|Infinity)$/.test(text)) throw new ValueError(`${text} is not a finite decimal`);
  const m = DECIMAL_OUTPUT.exec(text);
  if (!m) throw new ValueError(`not PostgreSQL numeric output: ${text}`);
  const fraction = m[3] ?? "";
  const coef = BigInt(`${m[2]}${fraction}`);
  if (m[1] === "-" && coef === 0n) throw new ValueError(`negative zero is not PostgreSQL numeric output: ${text}`);
  return { coef: m[1] === "-" ? -coef : coef, scale: fraction.length };
}

function rescale(value: FixedDecimal, scale: number): bigint {
  return value.coef * 10n ** BigInt(scale - value.scale);
}

export function addFixed(a: FixedDecimal, b: FixedDecimal): FixedDecimal {
  const scale = Math.max(a.scale, b.scale);
  return { coef: rescale(a, scale) + rescale(b, scale), scale };
}

export function compareFixed(a: FixedDecimal, b: FixedDecimal): number {
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function formatFixed(value: FixedDecimal): string {
  const negative = value.coef < 0n;
  const digits = (negative ? -value.coef : value.coef).toString().padStart(value.scale + 1, "0");
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale);
  const body = value.scale > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

/**
 * Structural check of a decimal for a DECIMAL_TEXT(p,s) column: exactly `s`
 * fraction digits and at most `p - s` integer digits, as numeric(p,s) output
 * always has. Without a typmod any scale is canonical.
 */
export function isCanonicalDecimalFor(text: string, precision: number | null, scale: number | null): boolean {
  const m = DECIMAL_OUTPUT.exec(text);
  if (!m) return false;
  if (m[1] === "-" && /^0(\.0*)?$/.test(text.slice(1))) return false;
  if (precision === null || scale === null) return true;
  const fraction = m[3];
  if (scale === 0 ? fraction !== undefined : fraction?.length !== scale) return false;
  const integerDigits = m[2] === "0" ? 0 : at(m, 2).length;
  return integerDigits <= precision - scale;
}

// ---------------------------------------------------------------------------
// Dates and timestamps
// ---------------------------------------------------------------------------

/** Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's algorithm). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Vision's DATE_TEXT/TIMESTAMPTZ_TEXT contract covers years 1-9999. */
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

const DATE_OUTPUT = /^([0-9]{4,})-([0-9]{2})-([0-9]{2})( BC)?$/;

/** PostgreSQL date output (ISO) -> `YYYY-MM-DD`. */
export function convertPgDate(text: string): string {
  if (text === "infinity" || text === "-infinity") {
    throw new ValueError(`${text} dates cannot be stored (Vision's DATE_TEXT holds years 1-9999)`);
  }
  const m = DATE_OUTPUT.exec(text);
  if (!m) throw new ValueError(`not a PostgreSQL ISO date: ${text}`);
  if (m[4] !== undefined) throw new ValueError(`BC dates cannot be stored: ${text}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < MIN_YEAR || year > MAX_YEAR) throw new ValueError(`year ${year} is outside 1-9999: ${text}`);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new ValueError(`not a calendar date: ${text}`);
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * timestamptz output in DateStyle ISO: `YYYY-MM-DD HH:MM:SS[.f]±HH[:MM[:SS]]`,
 * years of four or more digits, optional ` BC`.
 */
const TIMESTAMPTZ_OUTPUT =
  /^([0-9]{4,})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?([+-])([0-9]{2})(?::([0-9]{2}))?(?::([0-9]{2}))?( BC)?$/;

/**
 * PostgreSQL timestamptz output (with the session's UTC offset) -> Vision's
 * canonical `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC, exactly, microseconds kept.
 */
export function convertPgTimestamptz(text: string): string {
  if (text === "infinity" || text === "-infinity") {
    throw new ValueError(`${text} timestamps cannot be stored (Vision's TIMESTAMPTZ_TEXT holds years 1-9999)`);
  }
  const m = TIMESTAMPTZ_OUTPUT.exec(text);
  if (!m) throw new ValueError(`not a PostgreSQL ISO timestamp with time zone: ${text}`);
  if (m[12] !== undefined) throw new ValueError(`BC timestamps cannot be stored: ${text}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const micros = Number((m[7] ?? "").padEnd(6, "0"));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new ValueError(`not a calendar date: ${text}`);
  }
  if (hour > 23 || minute > 59 || second > 59) throw new ValueError(`not a time of day: ${text}`);
  const offsetHours = Number(m[9]);
  const offsetMinutes = m[10] === undefined ? 0 : Number(m[10]);
  const offsetSeconds = m[11] === undefined ? 0 : Number(m[11]);
  if (offsetMinutes > 59 || offsetSeconds > 59 || offsetHours > 15) {
    throw new ValueError(`not a UTC offset: ${text}`);
  }
  const offset = (m[8] === "-" ? -1 : 1) * (offsetHours * 3600 + offsetMinutes * 60 + offsetSeconds);
  // Seconds since the epoch stay far inside 2^53 for any 5-digit year.
  const utcSeconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset;
  const days = Math.floor(utcSeconds / 86400);
  const secondOfDay = utcSeconds - days * 86400;
  const civil = civilFromDays(days);
  if (civil.year < MIN_YEAR || civil.year > MAX_YEAR) {
    throw new ValueError(`UTC year ${civil.year} is outside 1-9999: ${text}`);
  }
  const hh = Math.floor(secondOfDay / 3600);
  const mm = Math.floor((secondOfDay % 3600) / 60);
  const ss = secondOfDay % 60;
  return (
    `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}` +
    `T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(micros, 6)}Z`
  );
}

// ---------------------------------------------------------------------------
// UUIDs
// ---------------------------------------------------------------------------

const UUID_OUTPUT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** uuid output is always lower-case 8-4-4-4-12. */
export function convertPgUuid(text: string): string {
  if (!UUID_OUTPUT.test(text)) throw new ValueError(`not a PostgreSQL uuid: ${text}`);
  return text;
}

// ---------------------------------------------------------------------------
// char(n)
// ---------------------------------------------------------------------------

/**
 * `character(n)` output is padded with spaces to n characters. PostgreSQL
 * ignores the padding in comparisons; Vision's SQLite contract stores the
 * value without it (docs/reference/sqlite-sql-dialect.md).
 */
export function stripBpcharPadding(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end--;
  return text.slice(0, end);
}
