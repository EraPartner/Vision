/**
 * The SQL functions every Vision SQLite connection registers (ADR-263).
 *
 * They replace what PostgreSQL provided natively: exact NUMERIC arithmetic,
 * month and interval arithmetic, `now()`, LIKE/ILIKE/regex in the C locale,
 * pg_trgm similarity, jsonb containment, UUIDs and GREATEST/LEAST. Every
 * function is a pure function of its arguments except `now()`, `today()`,
 * `gen_random_uuid()` and `nextval()`, so the deterministic ones may appear
 * in CHECK constraints, partial-index predicates and triggers.
 *
 * Names follow PostgreSQL where one exists (`date_trunc`, `to_char`,
 * `similarity`, `greatest`) so ported SQL reads the same; NUMERIC operators
 * become `dec_*` calls because SQLite has no operator overloading.
 */
import { randomUUID } from "node:crypto";
import type { AggregateOptions, DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from "node:sqlite";
import { ftsMatch, ftsRank } from "./fts.ts";
import { canonicalJsonbText, isCanonicalJsonbText, quoteJsonbString } from "./jsonb.ts";
import * as N from "./numeric.ts";
import type { Dec } from "./numeric.ts";
import * as T from "./timestamps.ts";
import { compareCodePoints, ilike, jsonContains, like, regexpMatch, similarity } from "./text.ts";

/** What `now()` reads: the transaction start inside a transaction. */
export interface ConnectionClock {
  /** Set by the driver at BEGIN; cleared at COMMIT/ROLLBACK. */
  transactionStart: T.Instant | null;
  /** Set by the driver before each statement outside a transaction. */
  statementStart: T.Instant | null;
}

type SqlValue = null | number | bigint | string | Uint8Array;

function decOut(value: Dec | null): string | null {
  return value === null ? null : N.formatDec(value);
}

function binaryDec(fn: string, op: (a: Dec, b: Dec) => Dec) {
  return (a: unknown, b: unknown): string | null => {
    const x = N.toDec(a, fn);
    const y = N.toDec(b, fn);
    if (x === null || y === null) return null;
    return N.formatDec(op(x, y));
  };
}

function intArg(value: unknown, fn: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  throw new TypeError(`${fn}: expected a whole number, got ${String(value)}`);
}

function textArg(value: unknown, fn: string): string {
  if (typeof value === "string") return value;
  throw new TypeError(`${fn}: expected text, got ${typeof value}`);
}

/**
 * node:sqlite hands a JavaScript number to SQLite as a REAL, so `1` would
 * read back as `1.0` in text, JSON and typeof(). Integer results are
 * returned as BigInt, which SQLite stores as INTEGER.
 */
function int(value: number): bigint {
  return BigInt(value);
}

function bool(value: boolean | null): bigint | null {
  return value === null ? null : value ? 1n : 0n;
}

/** A date text stays a date; anything else is read as a timestamp. */
function dateOrInstant(value: unknown, fn: string): T.CivilDate | T.Instant | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${fn}: expected date or timestamp text`);
  return T.isDateText(value) ? T.parseDate(value) : T.parseInstant(value);
}

function sign(c: number | bigint): number {
  return c < 0 ? -1 : c > 0 ? 1 : 0;
}

/** Exact comparison of an INTEGER with a REAL. */
function compareIntReal(a: bigint, b: number): number {
  if (b === Infinity) return -1;
  if (b === -Infinity) return 1;
  const floor = Math.floor(b);
  const c = sign(a - BigInt(floor));
  if (c !== 0) return c;
  return floor === b ? 0 : -1;
}

/** SQLite's ordering of values: numbers, then text (bytewise), then blobs. */
function compareSqlValues(a: Exclude<SqlValue, null>, b: Exclude<SqlValue, null>): number {
  const rank = (v: Exclude<SqlValue, null>) => (typeof v === "string" ? 1 : v instanceof Uint8Array ? 2 : 0);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "string" && typeof b === "string") return compareCodePoints(a, b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return sign(d);
    }
    return sign(a.length - b.length);
  }
  if (typeof a === "bigint" && typeof b === "bigint") return sign(a - b);
  if (typeof a === "number" && typeof b === "number") return sign(a - b);
  if (typeof a === "bigint" && typeof b === "number") return compareIntReal(a, b);
  if (typeof a === "number" && typeof b === "bigint") return -compareIntReal(b, a);
  return 0;
}

function isSqlValue(v: unknown): v is Exclude<SqlValue, null> {
  return typeof v === "number" || typeof v === "bigint" || typeof v === "string" || v instanceof Uint8Array;
}

/** GREATEST/LEAST over SQLite values, ignoring NULLs (PostgreSQL rule). */
function pick(values: unknown[], larger: boolean): SqlValue {
  let best: SqlValue = null;
  for (const value of values) {
    if (!isSqlValue(value)) continue;
    if (best === null) {
      best = value;
      continue;
    }
    const c = compareSqlValues(value, best);
    if (larger ? c > 0 : c < 0) best = value;
  }
  return best;
}

/** `vision_array_ok`: a JSON array of strings, or of integers, with NULLs allowed. */
function isCanonicalArrayText(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const items: unknown[] = parsed;
  const present = items.filter((item) => item !== null);
  const allStrings = present.every((item) => typeof item === "string");
  const allIntegers = present.every((item) => typeof item === "number" && Number.isSafeInteger(item));
  return (allStrings || allIntegers) && JSON.stringify(items) === text;
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** PostgreSQL `x::jsonb` for text and `to_jsonb(x)` for numbers. */
function toJsonbText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return canonicalJsonbText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    // to_jsonb(double precision) reads float8out text back as a numeric.
    return Number.isFinite(value) ? canonicalJsonbText(String(value)) : quoteJsonbString(String(value));
  }
  throw Object.assign(new TypeError("vision_jsonb: a blob is not jsonb"), { code: "42804" });
}

/** An aggregate whose state is a JavaScript object. */
interface AggregateSpec<S> {
  start: () => S;
  step: (state: S, value: SQLOutputValue) => S;
  inverse?: (state: S, value: SQLOutputValue) => S;
  result: (state: S) => SQLInputValue;
}

function aggregate<S>(db: DatabaseSync, name: string, spec: AggregateSpec<S>): void {
  // node:sqlite keeps any JavaScript value as the state; its typings only admit SQL values.
  const options = { ...spec, deterministic: true } as unknown as AggregateOptions;
  db.aggregate(name, options);
}

function pickDec(values: unknown[], larger: boolean, fn: string): string | null {
  let best: Dec | null = null;
  let bestText: string | null = null;
  for (const v of values) {
    const d = N.toDec(v, fn);
    if (d === null) continue;
    if (best === null || (larger ? N.cmp(d, best) > 0 : N.cmp(d, best) < 0)) {
      best = d;
      bestText = N.formatDec(d);
    }
  }
  return bestText;
}

/**
 * Running NUMERIC sum. PostgreSQL's result scale is the largest input scale
 * in the current frame, so the state counts values per scale and a window
 * frame that drops the last value of the largest scale shrinks the scale.
 */
interface SumState {
  coef: bigint;
  scale: number;
  count: number;
  scales: Map<number, number>;
}

function startSum(): SumState {
  return { coef: 0n, scale: 0, count: 0, scales: new Map() };
}

function sumStep(state: SumState, value: unknown, fn: string, sign: 1n | -1n): SumState {
  const d = N.toDec(value, fn);
  if (d === null) return state;
  const scale = Math.max(state.scale, d.scale);
  const coef =
    state.coef * 10n ** BigInt(scale - state.scale) + sign * d.coef * 10n ** BigInt(scale - d.scale);
  const seen = (state.scales.get(d.scale) ?? 0) + (sign === 1n ? 1 : -1);
  if (seen === 0) state.scales.delete(d.scale);
  else state.scales.set(d.scale, seen);
  let result = { coef, scale, count: state.count + (sign === 1n ? 1 : -1), scales: state.scales };
  if (sign === -1n) {
    const top = Math.max(0, ...result.scales.keys());
    if (top < result.scale) {
      // Exact: every remaining value has at most `top` decimals.
      result = { ...result, coef: result.coef / 10n ** BigInt(result.scale - top), scale: top };
    }
  }
  return result;
}

function sumResult(state: SumState): Dec {
  return { coef: state.coef, scale: state.scale };
}

/**
 * Register Vision's SQL functions on a connection. `clock` must be the same
 * object the driver updates around statements and transactions.
 */
export function registerFunctions(db: DatabaseSync, clock: ConnectionClock): void {
  const det = { deterministic: true } as const;
  const detVar = { deterministic: true, varargs: true } as const;

  // ---- NUMERIC ----------------------------------------------------------
  db.function("dec", det, (a: unknown) => N.canonical(a));
  db.function("dec_add", detVar, (...args: unknown[]) => {
    let acc: Dec | null = null;
    for (const arg of args) {
      const d = N.toDec(arg, "dec_add");
      if (d === null) return null;
      acc = acc === null ? d : N.add(acc, d);
    }
    return decOut(acc);
  });
  db.function("dec_sub", det, binaryDec("dec_sub", N.sub));
  db.function("dec_mul", detVar, (...args: unknown[]) => {
    let acc: Dec | null = null;
    for (const arg of args) {
      const d = N.toDec(arg, "dec_mul");
      if (d === null) return null;
      acc = acc === null ? d : N.mul(acc, d);
    }
    return decOut(acc);
  });
  db.function("dec_div", det, binaryDec("dec_div", N.div));
  db.function("dec_mod", det, binaryDec("dec_mod", N.mod));
  db.function("dec_neg", det, (a: unknown) => {
    const d = N.toDec(a, "dec_neg");
    return d === null ? null : N.formatDec(N.neg(d));
  });
  db.function("dec_abs", det, (a: unknown) => {
    const d = N.toDec(a, "dec_abs");
    return d === null ? null : N.formatDec(N.absDec(d));
  });
  db.function("dec_round", detVar, (a: unknown, s: unknown = 0) => {
    const d = N.toDec(a, "dec_round");
    if (d === null || s === null) return null;
    return N.formatDec(N.roundTo(d, intArg(s, "dec_round")));
  });
  db.function("dec_trunc", detVar, (a: unknown, s: unknown = 0) => {
    const d = N.toDec(a, "dec_trunc");
    if (d === null || s === null) return null;
    return N.formatDec(N.truncTo(d, intArg(s, "dec_trunc")));
  });
  db.function("dec_floor", det, (a: unknown) => {
    const d = N.toDec(a, "dec_floor");
    return d === null ? null : N.formatDec(N.floorDec(d));
  });
  db.function("dec_ceil", det, (a: unknown) => {
    const d = N.toDec(a, "dec_ceil");
    return d === null ? null : N.formatDec(N.ceilDec(d));
  });
  db.function("dec_cmp", det, (a: unknown, b: unknown) => {
    const x = N.toDec(a, "dec_cmp");
    const y = N.toDec(b, "dec_cmp");
    return x === null || y === null ? null : int(N.cmp(x, y));
  });
  const comparison = (name: string, test: (c: number) => boolean) =>
    db.function(name, det, (a: unknown, b: unknown) => {
      const x = N.toDec(a, name);
      const y = N.toDec(b, name);
      return x === null || y === null ? null : bool(test(N.cmp(x, y)));
    });
  comparison("dec_eq", (c) => c === 0);
  comparison("dec_ne", (c) => c !== 0);
  comparison("dec_lt", (c) => c < 0);
  comparison("dec_le", (c) => c <= 0);
  comparison("dec_gt", (c) => c > 0);
  comparison("dec_ge", (c) => c >= 0);
  db.function("dec_sign", det, (a: unknown) => {
    const d = N.toDec(a, "dec_sign");
    return d === null ? null : int(N.sign(d));
  });
  db.function("dec_key", det, (a: unknown) => {
    const d = N.toDec(a, "dec_key");
    return d === null ? null : N.sortKey(d);
  });
  db.function("dec_int", det, (a: unknown) => {
    const d = N.toDec(a, "dec_int");
    return d === null ? null : N.toInteger(d);
  });
  db.function("dec_real", det, (a: unknown) => {
    const d = N.toDec(a, "dec_real");
    return d === null ? null : Number(N.formatDec(d));
  });
  db.function("dec_greatest", detVar, (...args: unknown[]) => pickDec(args, true, "dec_greatest"));
  db.function("dec_least", detVar, (...args: unknown[]) => pickDec(args, false, "dec_least"));
  /** NUMERIC(p, s) assignment cast: round half away from zero, refuse overflow. */
  db.function("vision_numeric", detVar, (a: unknown, p: unknown, s: unknown) => {
    const d = N.toDec(a, "vision_numeric");
    if (d === null) return null;
    if (p === null || p === undefined) return N.formatDec(d);
    return N.formatDec(N.coerceTypmod(d, intArg(p, "vision_numeric"), intArg(s ?? 0, "vision_numeric")));
  });
  /** CHECK helper: 1 when the stored text is exactly NUMERIC(p, s) output form. */
  db.function("vision_numeric_ok", detVar, (a: unknown, p: unknown, s: unknown) => {
    if (a === null || a === undefined) return null;
    if (typeof a !== "string") return 0;
    try {
      const d = N.parseDecimalText(a);
      if (p === null || p === undefined) return bool(N.formatDec(d) === a);
      const expected = N.formatDec(N.coerceTypmod(d, intArg(p, "vision_numeric_ok"), intArg(s ?? 0, "vision_numeric_ok")));
      return bool(expected === a);
    } catch {
      return 0;
    }
  });
  aggregate(db, "dec_sum", {
    start: startSum,
    step: (state, value) => sumStep(state, value, "dec_sum", 1n),
    inverse: (state, value) => sumStep(state, value, "dec_sum", -1n),
    result: (state) => (state.count === 0 ? null : N.formatDec(sumResult(state))),
  });
  aggregate(db, "dec_avg", {
    start: startSum,
    step: (state, value) => sumStep(state, value, "dec_avg", 1n),
    inverse: (state, value) => sumStep(state, value, "dec_avg", -1n),
    result: (state) =>
      state.count === 0
        ? null
        : N.formatDec(N.div(sumResult(state), { coef: BigInt(state.count), scale: 0 })),
  });
  const extreme = (name: string, larger: boolean) =>
    aggregate<{ best: Dec | null }>(db, name, {
      start: () => ({ best: null }),
      step: (state, value) => {
        const d = N.toDec(value, name);
        if (d === null) return state;
        if (state.best === null || (larger ? N.cmp(d, state.best) > 0 : N.cmp(d, state.best) < 0)) {
          return { best: d };
        }
        return state;
      },
      result: (state) => decOut(state.best),
    });
  extreme("dec_max", true);
  extreme("dec_min", false);

  // ---- dates and timestamps ----------------------------------------------
  const nowInstant = (): T.Instant =>
    clock.transactionStart ?? clock.statementStart ?? T.instantFromDate(new Date());
  db.function("now", {}, () => T.formatInstant(nowInstant()));
  db.function("today", {}, () => T.formatDate(T.localDateOf(nowInstant())));
  db.function("vision_ts", det, (a: unknown) => (a === null ? null : T.canonicalTimestamp(textArg(a, "vision_ts"))));
  db.function("vision_ts_ok", det, (a: unknown) => {
    if (a === null || a === undefined) return null;
    if (typeof a !== "string") return 0;
    try {
      return bool(T.isTimestampText(a) && T.canonicalTimestamp(a) === a);
    } catch {
      return 0;
    }
  });
  db.function("vision_date_ok", det, (a: unknown) => {
    if (a === null || a === undefined) return null;
    if (typeof a !== "string") return 0;
    try {
      return bool(T.formatDate(T.parseDate(a)) === a);
    } catch {
      return 0;
    }
  });
  /** PostgreSQL `x::date` (see dateInputText). */
  db.function("ts_date", det, (a: unknown) => {
    if (a === null || a === undefined) return null;
    return T.dateInputText(textArg(a, "ts_date"));
  });
  /** PostgreSQL `d::timestamptz`: local midnight of a date, or a timestamp as is. */
  db.function("date_ts", det, (a: unknown) => {
    if (a === null) return null;
    return T.formatInstant(T.parseInstant(textArg(a, "date_ts")));
  });
  db.function("date_trunc", det, (unit: unknown, a: unknown) => {
    const v = dateOrInstant(a, "date_trunc");
    if (v === null) return null;
    const u = textArg(unit, "date_trunc");
    return "ms" in v ? T.formatInstant(T.truncInstant(u, v)) : T.formatDate(T.truncDate(u, v));
  });
  db.function("add_months", det, (a: unknown, n: unknown) => {
    const v = dateOrInstant(a, "add_months");
    if (v === null || n === null) return null;
    const months = intArg(n, "add_months");
    return "ms" in v
      ? T.formatInstant(T.addIntervalToInstant(v, { months, days: 0, micros: 0 }))
      : T.formatDate(T.addMonthsToDate(v, months));
  });
  db.function("add_days", det, (a: unknown, n: unknown) => {
    const v = dateOrInstant(a, "add_days");
    if (v === null || n === null) return null;
    const days = intArg(n, "add_days");
    return "ms" in v
      ? T.formatInstant(T.addIntervalToInstant(v, { months: 0, days, micros: 0 }))
      : T.formatDate(T.addDaysToDate(v, days));
  });
  const intervalFn = (name: string, negate: boolean) =>
    db.function(name, det, (a: unknown, interval: unknown) => {
      const v = dateOrInstant(a, name);
      if (v === null || interval === null) return null;
      let parsed = T.parseInterval(textArg(interval, name));
      if (negate) parsed = T.negateInterval(parsed);
      return "ms" in v
        ? T.formatInstant(T.addIntervalToInstant(v, parsed))
        : T.formatDate(T.addIntervalToDate(v, parsed));
    });
  intervalFn("add_interval", false);
  intervalFn("sub_interval", true);
  db.function("month_end", det, (a: unknown) => {
    const v = dateOrInstant(a, "month_end");
    if (v === null) return null;
    const civil = "ms" in v ? T.localDateOf(v) : v;
    return T.formatDate({ ...civil, day: T.daysInMonth(civil.year, civil.month) });
  });
  /** PostgreSQL `a - b` on dates: whole days. Timestamps use their local dates. */
  db.function("date_diff_days", det, (a: unknown, b: unknown) => {
    const x = dateOrInstant(a, "date_diff_days");
    const y = dateOrInstant(b, "date_diff_days");
    if (x === null || y === null) return null;
    const cx = "ms" in x ? T.localDateOf(x) : x;
    const cy = "ms" in y ? T.localDateOf(y) : y;
    return int(T.diffDays(cx, cy));
  });
  db.function("make_date", det, (y: unknown, m: unknown, d: unknown) => {
    if (y === null || m === null || d === null) return null;
    const year = intArg(y, "make_date");
    const month = intArg(m, "make_date");
    const day = intArg(d, "make_date");
    const valid =
      year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= T.daysInMonth(year, month);
    if (!valid) {
      throw new T.TimeError(`date field value out of range: ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, "22008");
    }
    return T.formatDate({ year, month, day });
  });
  /** A whole result is an INTEGER (as EXTRACT prints it); a fraction stays REAL. */
  db.function("date_part", det, (field: unknown, a: unknown) => {
    const v = dateOrInstant(a, "date_part");
    if (v === null) return null;
    const part = T.datePart(textArg(field, "date_part"), v);
    return Number.isSafeInteger(part) ? int(part) : part;
  });
  db.function("to_char", det, (a: unknown, format: unknown) => {
    const v = dateOrInstant(a, "to_char");
    if (v === null) return null;
    return T.toChar(v, textArg(format, "to_char"));
  });
  /** Whole months between two dates' month starts: (a.year*12+a.month) - (b.year*12+b.month). */
  db.function("month_diff", det, (a: unknown, b: unknown) => {
    const x = dateOrInstant(a, "month_diff");
    const y = dateOrInstant(b, "month_diff");
    if (x === null || y === null) return null;
    const cx = "ms" in x ? T.localDateOf(x) : x;
    const cy = "ms" in y ? T.localDateOf(y) : y;
    return int(cx.year * 12 + cx.month - (cy.year * 12 + cy.month));
  });

  // ---- text ---------------------------------------------------------------
  // `X LIKE Y [ESCAPE Z]` calls like(Y, X[, Z]); PostgreSQL LIKE is
  // case-sensitive, `\` escapes by default and ESCAPE '' disables escaping.
  const textOf = (value: unknown): string => (typeof value === "string" ? value : String(value));
  // Fixed arities (not varargs) so these replace SQLite's built-in like().
  db.function("like", det, (pattern: unknown, value: unknown) => {
    if (pattern === null || value === null) return null;
    return bool(like(textOf(value), textOf(pattern)));
  });
  db.function("like", det, (pattern: unknown, value: unknown, escape: unknown) => {
    if (pattern === null || value === null || escape === null) return null;
    return bool(like(textOf(value), textOf(pattern), textOf(escape)));
  });
  db.function("ilike", detVar, (value: unknown, pattern: unknown, ...rest: unknown[]) => {
    const escape = rest.length > 0 ? rest[0] : "\\";
    if (pattern === null || value === null || escape === null) return null;
    return bool(ilike(textOf(value), textOf(pattern), textOf(escape)));
  });
  // `X REGEXP Y` calls regexp(Y, X).
  db.function("regexp", det, (pattern: unknown, value: unknown) => {
    if (pattern === null || value === null) return null;
    return bool(regexpMatch(textOf(pattern), textOf(value)));
  });
  db.function("regexp_i", det, (value: unknown, pattern: unknown) => {
    if (pattern === null || value === null) return null;
    return bool(regexpMatch(textOf(pattern), textOf(value), "i"));
  });
  db.function("similarity", det, (a: unknown, b: unknown) => {
    if (a === null || b === null) return null;
    return similarity(textOf(a), textOf(b));
  });
  db.function("json_contains", det, (a: unknown, b: unknown) => {
    if (a === null || b === null) return null;
    return bool(jsonContains(textArg(a, "json_contains"), textArg(b, "json_contains")));
  });
  // BigInt arguments keep an int8 beyond 2^53 exact.
  db.function("vision_jsonb", { deterministic: true, useBigIntArguments: true }, (a: unknown) => toJsonbText(a));
  /** CHECK helper: 1 when the stored text is exactly PostgreSQL's jsonb output. */
  db.function("vision_jsonb_ok", det, (a: unknown) => {
    if (a === null || a === undefined) return null;
    return bool(typeof a === "string" && isCanonicalJsonbText(a));
  });
  db.function("vision_uuid_ok", det, (a: unknown) => {
    if (a === null || a === undefined) return null;
    return bool(typeof a === "string" && UUID_TEXT.test(a));
  });
  db.function("vision_array_ok", det, (a: unknown) => {
    if (a === null || a === undefined) return null;
    return bool(typeof a === "string" && isCanonicalArrayText(a));
  });
  db.function("gen_random_uuid", {}, () => randomUUID());
  const greatestLeast = { deterministic: true, varargs: true, useBigIntArguments: true } as const;
  db.function("greatest", greatestLeast, (...args: unknown[]) => pick(args, true));
  db.function("least", greatestLeast, (...args: unknown[]) => pick(args, false));
  db.function("btrim", detVar, (value: unknown, chars: unknown = " ") => {
    if (value === null || chars === null) return null;
    const set = new Set(Array.from(textOf(chars)));
    const arr = Array.from(textOf(value));
    let start = 0;
    let end = arr.length;
    while (start < end && set.has(arr[start] ?? "")) start++;
    while (end > start && set.has(arr[end - 1] ?? "")) end--;
    return arr.slice(start, end).join("");
  });

  // ---- full-text search (to_tsvector('simple') @@ websearch_to_tsquery('simple')) --
  db.function("vision_fts_match", det, (document: unknown, query: unknown) => {
    if (document === null || query === null) return null;
    return bool(ftsMatch(textArg(document, "vision_fts_match"), textArg(query, "vision_fts_match")));
  });
  /** ts_rank_cd(..., 0) as a REAL. */
  db.function("vision_fts_rank", det, (document: unknown, query: unknown) => {
    if (document === null || query === null) return null;
    return ftsRank(textArg(document, "vision_fts_rank"), textArg(query, "vision_fts_rank"));
  });

  // ---- sequences --------------------------------------------------------------
  // The UPDATE runs inside the calling statement, so it joins its transaction.
  let advance: StatementSync | null = null;
  db.function("nextval", {}, (name: unknown) => {
    if (name === null) return null;
    const sequence = textArg(name, "nextval");
    if (advance === null) {
      advance = db.prepare("UPDATE vision_sequences SET last_value = last_value + 1 WHERE name = ? RETURNING last_value");
      advance.setReadBigInts(true);
    }
    const row = advance.get(sequence);
    if (row === undefined) {
      throw Object.assign(new Error(`sequence "${sequence}" does not exist`), { code: "42P01" });
    }
    return row.last_value as bigint;
  });

  // ---- math (SQLite's math functions are a compile option; macOS lacks them) --
  // An INTEGER argument keeps its type through floor/ceil/sign, as in SQLite's own.
  const mathOptions = { deterministic: true, useBigIntArguments: true } as const;
  const unaryMath = (name: string, fn: (x: number) => number, onInteger?: (x: bigint) => bigint) =>
    db.function(name, mathOptions, (x: unknown) => {
      if (x === null) return null;
      if (typeof x === "bigint" && onInteger !== undefined) return onInteger(x);
      const r = fn(Number(x));
      return Number.isFinite(r) ? r : null;
    });
  const same = (x: bigint): bigint => x;
  unaryMath("floor", Math.floor, same);
  unaryMath("ceil", Math.ceil, same);
  unaryMath("ceiling", Math.ceil, same);
  unaryMath("sqrt", Math.sqrt);
  unaryMath("ln", Math.log);
  unaryMath("exp", Math.exp);
  unaryMath("log10", Math.log10);
  unaryMath("sign", Math.sign, (x) => BigInt(sign(x)));
  db.function("power", det, (x: unknown, y: unknown) => {
    if (x === null || y === null) return null;
    const r = Math.pow(Number(x), Number(y));
    return Number.isFinite(r) ? r : null;
  });
  db.function("pow", det, (x: unknown, y: unknown) => {
    if (x === null || y === null) return null;
    const r = Math.pow(Number(x), Number(y));
    return Number.isFinite(r) ? r : null;
  });
}
