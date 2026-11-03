/**
 * The round-trip check: does a value SQLite stores mean exactly what the
 * dump's text said? Written separately from the forward conversion
 * (typeMapping.ts / pgValues.ts), so a conversion bug cannot confirm itself:
 * integers compare as BigInt, timestamps as epoch microseconds computed
 * through JavaScript's own calendar, arrays by printing the stored JSON back
 * with PostgreSQL's array_out rules, and everything stored as text must be
 * the dump's text (char(n) without its padding).
 */
import { formatPgTextArray } from "./pgArray.ts";
import type { ColumnConverter, SqliteValue } from "./typeMapping.ts";
import { normaliseDeclared } from "./typeMapping.ts";

const INTEGER_TEXT = /^-?[0-9]+$/;
const DUMP_TS =
  /^([0-9]{4,5})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,6})?([+-])([0-9]{2})(?::([0-9]{2}))?(?::([0-9]{2}))?$/;
const STORED_TS = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{6})Z$/;

/** Milliseconds since the epoch of a UTC wall-clock time, via Date (any year). */
function epochMillis(year: number, month: number, day: number, h: number, m: number, s: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(h, m, s, 0);
  // Date rolls over silently; refuse a field it had to roll.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return Number.NaN;
  return date.getTime();
}

function dumpTimestampMicros(text: string): bigint | null {
  const m = DUMP_TS.exec(text);
  if (!m) return null;
  const n = (i: number): number => Number(m[i] ?? "0");
  const ms = epochMillis(n(1), n(2), n(3), n(4), n(5), n(6));
  if (Number.isNaN(ms)) return null;
  const fraction = BigInt(((m[7] ?? ".").slice(1) + "000000").slice(0, 6));
  const offsetSeconds = (m[8] === "-" ? -1 : 1) * (n(9) * 3600 + n(10) * 60 + n(11));
  return BigInt(ms) * 1000n + fraction - BigInt(offsetSeconds) * 1_000_000n;
}

function storedTimestampMicros(text: string): bigint | null {
  const m = STORED_TS.exec(text);
  if (!m) return null;
  const n = (i: number): number => Number(m[i] ?? "0");
  const ms = epochMillis(n(1), n(2), n(3), n(4), n(5), n(6));
  if (Number.isNaN(ms)) return null;
  return BigInt(ms) * 1000n + BigInt(m[7] ?? "0");
}

function sameFloat(raw: string, stored: number): boolean {
  if (raw === "-0") return stored === 0;
  const expected = Number(raw);
  if (!Number.isFinite(expected)) return false;
  return Object.is(expected, stored);
}

function arrayText(stored: string, integers: boolean): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const elements: Array<string | null> = [];
  for (const item of parsed as unknown[]) {
    if (item === null) elements.push(null);
    else if (integers && typeof item === "number" && Number.isSafeInteger(item)) elements.push(String(item));
    else if (!integers && typeof item === "string") elements.push(item);
    else return null;
  }
  return formatPgTextArray(elements);
}

/** True when `stored` (as SQLite returns it, integers as BigInt) is exactly `raw`. */
export function storedMatchesDump(converter: ColumnConverter, raw: string | null, stored: SqliteValue): boolean {
  if (raw === null) return stored === null;
  if (stored === null) return false;
  const declared = normaliseDeclared(converter.facts.declaredType);
  const pgType = converter.facts.pgType;
  if (declared === "INTEGER" || declared === "INT" || declared === "BIGINT") {
    return typeof stored === "bigint" && INTEGER_TEXT.test(raw) && BigInt(raw) === stored;
  }
  if (declared === "BOOLEAN") {
    return (raw === "t" && stored === 1n) || (raw === "f" && stored === 0n);
  }
  if (declared === "REAL") return typeof stored === "number" && sameFloat(raw, stored);
  if (typeof stored !== "string") return false;
  if (declared === "TIMESTAMPTZ_TEXT") {
    const a = dumpTimestampMicros(raw);
    const b = storedTimestampMicros(stored);
    return a !== null && b !== null && a === b;
  }
  if (declared === "TEXT_ARRAY") return arrayText(stored, /^(smallint|integer|bigint)\[\]$/.test(pgType)) === raw;
  if (declared === "TEXT" && pgType.startsWith("character(")) {
    return raw.startsWith(stored) && /^ *$/.test(raw.slice(stored.length));
  }
  // DECIMAL_TEXT, DATE_TEXT, JSONB_TEXT, JSON_TEXT, UUID_TEXT and TEXT keep the dump's text.
  return stored === raw;
}
