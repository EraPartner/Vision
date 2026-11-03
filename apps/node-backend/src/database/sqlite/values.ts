/**
 * Value conversion between JavaScript and Vision's SQLite storage (ADR-263).
 *
 * Reads: SQLite returns only integers, floats, text, blobs and NULL. The
 * declared column type of a direct column reference (StatementSync.columns()
 * reports it through subqueries and views) says what the value means, and
 * the reader turns it into what node-postgres returned for the PostgreSQL
 * type, so services keep the row shapes they were written for:
 *
 *   BOOLEAN              0/1          -> boolean
 *   TIMESTAMPTZ_TEXT     UTC text     -> Date
 *   DATE_TEXT            YYYY-MM-DD   -> local-midnight Date (node-postgres's DATE parser)
 *   JSONB_TEXT           jsonb text   -> parsed value
 *   JSON_TEXT            JSON text    -> parsed value
 *   TEXT_ARRAY           JSON array   -> array (was text[] or int[])
 *   BIGINT               integer      -> decimal string (node-postgres's int8)
 *   DECIMAL_TEXT(p,s)    decimal text -> the same text
 *   UUID_TEXT            uuid text    -> the same text
 *
 * An expression has no declared type. Its alias may carry the type instead:
 * `AS "flag::bool"`, `::json`, `::timestamptz`, `::date`, `::bigint`. The
 * suffix is removed from the row key.
 *
 * Writes: a Date becomes canonical UTC text, a boolean 0/1, an array or a
 * plain object JSON text, `undefined` NULL.
 */
import { formatInstant, instantFromDate, parseDate } from "./timestamps.ts";

export type SqlParam = null | number | bigint | string | Uint8Array;

export type Reader = (value: unknown) => unknown;

const identity: Reader = (v) => v;

/** String(v) for the values SQLite returns: text, numbers and blobs. */
function sqlText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  if (v instanceof Uint8Array) return v.join(",");
  return Object.prototype.toString.call(v);
}

const readBoolean: Reader = (v) => {
  if (v === null || v === undefined) return null;
  if (v === 1 || v === 1n) return true;
  if (v === 0 || v === 0n) return false;
  if (typeof v === "boolean") return v;
  throw new TypeError(`boolean column holds ${typeof v} ${sqlText(v)}`);
};

const CANONICAL_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

const readTimestamp: Reader = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new TypeError(`timestamp column holds ${typeof v}`);
  const m = CANONICAL_TS.exec(v);
  // Date.parse of ISO with a Z suffix is exact to the millisecond; the three
  // microsecond digits are dropped, as node-postgres's parser drops them.
  const ms = Date.parse(m ? `${m[1]}Z` : v);
  if (Number.isNaN(ms)) throw new TypeError(`unreadable timestamp ${v}`);
  return new Date(ms);
};

const readDate: Reader = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new TypeError(`date column holds ${typeof v}`);
  const d = parseDate(v);
  const out = new Date(d.year, d.month - 1, d.day);
  if (d.year < 100) out.setFullYear(d.year);
  return out;
};

const readJson: Reader = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  return JSON.parse(v) as unknown;
};

const readBigint: Reader = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return v;
};

const readText: Reader = (v) => (v === null || v === undefined ? null : sqlText(v));

/** True for the reader of BIGINT columns and `::bigint` aliases. */
export function readsBigint(reader: Reader): boolean {
  return reader === readBigint;
}

/**
 * A statement with a BIGINT column is read with BigInts (so values above
 * 2^53 stay exact); its other columns then see BigInt for every integer.
 * Wrap their readers so a safe integer is a number again and a larger one
 * becomes decimal text, as node-postgres returned int8.
 */
export function withBigIntInput(reader: Reader): Reader {
  if (reader === readBigint) return reader;
  return (v) => {
    if (typeof v !== "bigint") return reader(v);
    const asNumber = Number(v);
    return reader(Number.isSafeInteger(asNumber) ? asNumber : v.toString());
  };
}

/** Reader for a declared column type, or null when the value passes through. */
export function readerForDeclaredType(declared: string | null | undefined): Reader | null {
  if (!declared) return null;
  const t = declared.trim().toUpperCase();
  if (t === "BOOLEAN") return readBoolean;
  if (t === "TIMESTAMPTZ_TEXT") return readTimestamp;
  if (t === "DATE_TEXT") return readDate;
  if (t === "JSONB_TEXT" || t === "JSON_TEXT" || t === "TEXT_ARRAY") return readJson;
  if (t === "BIGINT") return readBigint;
  return null;
}

const HINT = /::(bool|json|timestamptz|date|bigint|text)$/;

export interface ColumnPlan {
  /** Row key after the hint is removed. */
  key: string;
  read: Reader;
}

/** Plan one result column from its name and declared type. */
export function planColumn(name: string, declared: string | null | undefined): ColumnPlan {
  const hint = HINT.exec(name);
  if (hint) {
    const key = name.slice(0, name.length - hint[0].length);
    switch (hint[1]) {
      case "bool":
        return { key, read: readBoolean };
      case "json":
        return { key, read: readJson };
      case "timestamptz":
        return { key, read: readTimestamp };
      case "date":
        return { key, read: readDate };
      case "bigint":
        return { key, read: readBigint };
      default:
        return { key, read: readText };
    }
  }
  return { key: name, read: readerForDeclaredType(declared) ?? identity };
}

/** PostgreSQL's invalid_text_representation (22P02) for a value no input function reads. */
export class InputSyntaxError extends Error {
  readonly code = "22P02";
  constructor(message: string) {
    super(message);
    this.name = "InputSyntaxError";
  }
}

/** Each accepted word, the shortest prefix PostgreSQL takes for it, and its value. */
const BOOLEAN_WORDS: readonly (readonly [string, number, boolean])[] = [
  ["true", 1, true],
  ["false", 1, false],
  ["yes", 1, true],
  ["no", 1, false],
  ["on", 2, true],
  ["off", 2, false],
];

/**
 * PostgreSQL's boolean input (boolin) for a value bound where a boolean is
 * stored: node-postgres sent String(value), and PostgreSQL read it. A boolean
 * stays as is. Text, trimmed and in any case, may be a prefix of true, false,
 * yes or no, `on`, `of`/`off`, or exactly 1 or 0; so may a number's text.
 * Anything else raises 22P02, as PostgreSQL did.
 */
export function booleanInput(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const raw =
    typeof value === "string" || typeof value === "number" || typeof value === "bigint"
      ? String(value)
      : sqlText(value);
  const text = raw.trim().toLowerCase();
  if (text === "1") return true;
  if (text === "0") return false;
  for (const [word, shortest, result] of BOOLEAN_WORDS) {
    if (text.length >= shortest && word.startsWith(text)) return result;
  }
  throw new InputSyntaxError(`invalid input syntax for type boolean: "${raw}"`);
}

/** A Decimal.js-style value, which prints its exact digits with toString(). */
interface DecimalLike {
  toString(): string;
  toFixed(): string;
}

function isDecimalLike(v: object): v is DecimalLike {
  const candidate = v as { toFixed?: unknown; isFinite?: unknown; d?: unknown };
  return typeof candidate.toFixed === "function" && typeof candidate.isFinite === "function" && "d" in candidate;
}

/** Convert one bound value to what SQLite stores. */
export function toSqlParam(value: unknown): SqlParam {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "bigint":
      return value;
    case "number":
      if (Number.isNaN(value)) throw new TypeError("NaN cannot be bound to SQLite");
      return value;
    case "boolean":
      return value ? 1 : 0;
    case "object": {
      if (value instanceof Date) return formatInstant(instantFromDate(value));
      if (value instanceof Uint8Array) return value;
      if (Array.isArray(value)) return JSON.stringify(value);
      if (isDecimalLike(value)) return value.toString();
      return JSON.stringify(value);
    }
    default:
      throw new TypeError(`cannot bind a ${typeof value} to SQLite`);
  }
}

export function toSqlParams(values: readonly unknown[] | undefined): SqlParam[] {
  if (!values) return [];
  return values.map(toSqlParam);
}
