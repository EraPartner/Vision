/**
 * Exact decimal arithmetic with PostgreSQL NUMERIC semantics (ADR-263).
 *
 * SQLite has no decimal type, so Vision stores NUMERIC columns as text in
 * PostgreSQL's output form ("12.3400") and does every calculation on them
 * through the SQL functions registered in functions.ts, which call this
 * module. A value is a BigInt coefficient and a display scale: 12.3400 is
 * { coef: 123400n, scale: 4 }. Nothing here goes through a JavaScript number.
 *
 * The display scale follows PostgreSQL: addition and subtraction keep the
 * larger input scale, multiplication adds the scales, division picks
 * `select_div_scale()` (at least 16 significant digits), rounding is half away
 * from zero, and a value that does not fit NUMERIC(p,s) raises
 * "numeric field overflow" instead of being clamped.
 */

export interface Dec {
  readonly coef: bigint;
  readonly scale: number;
}

/** A decimal-shaped error carrying PostgreSQL's SQLSTATE for the same failure. */
export class NumericError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "NumericError";
    this.code = code;
  }
}

/** PostgreSQL's NUMERIC_MAX_DISPLAY_SCALE (the largest scale division picks). */
const MAX_DISPLAY_SCALE = 1000;
/** PostgreSQL's NUMERIC_DSCALE_MAX: the largest scale a value can carry. */
const DSCALE_MAX = 16383;
/** Integer digits a value may have: (NUMERIC_WEIGHT_MAX + 1) * DEC_DIGITS. */
const MAX_INTEGER_DIGITS = 131072;
/** PostgreSQL's NUMERIC_MAX_PRECISION (the typmod limits). */
const MAX_PRECISION = 1000;
/** PostgreSQL's NUMERIC_MIN_SIG_DIGITS. */
const MIN_SIG_DIGITS = 16;
/** PostgreSQL's DEC_DIGITS (decimal digits per NBASE digit). */
const DEC_DIGITS = 4;

const POW10_CACHE: bigint[] = [];
function pow10(n: number): bigint {
  if (n < 0) throw new RangeError(`negative power of ten: ${n}`);
  if (n < 64) {
    let cached = POW10_CACHE[n];
    if (cached === undefined) {
      cached = 10n ** BigInt(n);
      POW10_CACHE[n] = cached;
    }
    return cached;
  }
  return 10n ** BigInt(n);
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function invalidSyntax(value: unknown): NumericError {
  return new NumericError(
    `invalid input syntax for type numeric: "${String(value)}"`,
    "22P02",
  );
}

function formatOverflow(): NumericError {
  return new NumericError("value overflows numeric format", "22003");
}

/** Below this magnitude a coefficient cannot exceed MAX_INTEGER_DIGITS. */
const SMALL_COEF = 10n ** 1000n;

/**
 * PostgreSQL's make_result() range check: a value has at most 131072
 * integer digits and 16383 decimals, or it overflows the numeric format.
 */
function checked(value: Dec): Dec {
  if (value.scale > DSCALE_MAX) throw formatOverflow();
  const magnitude = abs(value.coef);
  if (magnitude >= SMALL_COEF && magnitude.toString().length - value.scale > MAX_INTEGER_DIGITS) {
    throw formatOverflow();
  }
  return value;
}

/** C isspace() in the C locale. */
function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";
}

function isDigit(c: string | undefined): c is string {
  return c !== undefined && c >= "0" && c <= "9";
}

const RADIX_DIGIT: Record<number, RegExp> = { 16: /^[0-9A-Fa-f]$/, 8: /^[0-7]$/, 2: /^[01]$/ };

/**
 * Parse text the way PostgreSQL 18's numeric_in does: surrounding C-locale
 * whitespace, an optional sign, digits with single `_` separators, an
 * optional point and exponent, or a `0x`/`0o`/`0b` integer. NaN and the
 * infinities are refused: no Vision value may hold them.
 */
export function parseDecimalText(text: string): Dec {
  let i = 0;
  const at = (k: number): string | undefined => (k < text.length ? text[k] : undefined);
  while (isSpace(at(i))) i++;
  let negative = false;
  if (at(i) === "+") i++;
  else if (at(i) === "-") {
    negative = true;
    i++;
  }
  if (!isDigit(at(i)) && at(i) !== ".") {
    if (/^(nan|[+-]?(inf|infinity))\s*$/i.test(text.trim())) {
      throw new NumericError(`NaN and infinite values are not supported: "${text}"`, "22P02");
    }
    throw invalidSyntax(text);
  }
  let digits: string;
  let fracLength: number;
  let exponent = 0;
  const radixMark = at(i) === "0" ? at(i + 1) : undefined;
  const radix =
    radixMark === "x" || radixMark === "X" ? 16 : radixMark === "o" || radixMark === "O" ? 8 : radixMark === "b" || radixMark === "B" ? 2 : 10;
  if (radix !== 10) {
    const digitRe = RADIX_DIGIT[radix] ?? /^$/;
    i += 2;
    let raw = "";
    for (;;) {
      const c = at(i);
      if (c !== undefined && digitRe.test(c)) {
        raw += c;
        i++;
      } else if (c === "_") {
        i++;
        const next = at(i);
        if (next === undefined || !digitRe.test(next)) throw invalidSyntax(text);
      } else break;
    }
    if (raw.length === 0) throw invalidSyntax(text);
    const prefix = radix === 16 ? "0x" : radix === 8 ? "0o" : "0b";
    digits = BigInt(`${prefix}${raw}`).toString();
    fracLength = 0;
  } else {
    let haveDot = false;
    if (at(i) === ".") {
      haveDot = true;
      i++;
    }
    if (!isDigit(at(i))) throw invalidSyntax(text);
    let intPart = "";
    let fracPart = "";
    for (;;) {
      const c = at(i) ?? "";
      if (isDigit(c)) {
        if (haveDot) fracPart += c;
        else intPart += c;
        i++;
      } else if (c === ".") {
        if (haveDot) throw invalidSyntax(text);
        haveDot = true;
        i++;
        if (at(i) === "_") throw invalidSyntax(text);
      } else if (c === "_") {
        i++;
        if (!isDigit(at(i))) throw invalidSyntax(text);
      } else break;
    }
    if (at(i) === "e" || at(i) === "E") {
      i++;
      let expNegative = false;
      if (at(i) === "+") i++;
      else if (at(i) === "-") {
        expNegative = true;
        i++;
      }
      if (!isDigit(at(i))) throw invalidSyntax(text);
      for (;;) {
        const c = at(i) ?? "";
        if (isDigit(c)) {
          exponent = exponent * 10 + Number(c);
          if (exponent > 1_073_741_823) throw formatOverflow(); // PG_INT32_MAX / 2
          i++;
        } else if (c === "_") {
          i++;
          if (!isDigit(at(i))) throw invalidSyntax(text);
        } else break;
      }
      if (expNegative) exponent = -exponent;
    }
    digits = intPart + fracPart;
    fracLength = fracPart.length;
  }
  while (isSpace(at(i))) i++;
  if (i < text.length) throw invalidSyntax(text);

  // value = digits * 10^(exponent - fracLength), display scale max(0, fracLength - exponent)
  const scale = Math.max(0, fracLength - exponent);
  if (scale > DSCALE_MAX) throw formatOverflow();
  const significant = digits.replace(/^0+/, "");
  if (significant.length === 0) return { coef: 0n, scale };
  if (significant.length + exponent - fracLength > MAX_INTEGER_DIGITS) throw formatOverflow();
  const magnitude = BigInt(significant) * pow10(scale - fracLength + exponent);
  return { coef: negative ? -magnitude : magnitude, scale };
}

/**
 * Turn a SQLite value into a decimal. Text and integers are exact. A REAL
 * that is not a whole number is refused: it means a NUMERIC value already went
 * through floating point (a native `+`, `SUM` or a bare `0.5` literal), and
 * accepting it would hide that loss. Write decimal literals as text: `'0.5'`.
 */
export function toDec(value: unknown, fn = "decimal"): Dec | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return parseDecimalText(value);
  if (typeof value === "bigint") return { coef: value, scale: 0 };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidSyntax(value);
    if (Number.isInteger(value)) {
      if (Number.isSafeInteger(value)) return { coef: BigInt(value), scale: 0 };
      throw new NumericError(
        `${fn}: integer ${value} is outside the exact range; pass it as text`,
        "22003",
      );
    }
    throw new NumericError(
      `${fn}: floating-point input ${String(value)} refused; NUMERIC values must stay decimal text (write literals as '${String(value)}')`,
      "42804",
    );
  }
  if (typeof value === "boolean") return { coef: value ? 1n : 0n, scale: 0 };
  throw invalidSyntax(value);
}

/** Like {@link toDec} but for a value that may not be NULL. */
function need(value: unknown, fn: string): Dec {
  const parsed = toDec(value, fn);
  if (parsed === null) throw new TypeError(`${fn}: NULL is not a decimal`);
  return parsed;
}

/** Rescale exactly to a larger or equal scale. */
function upscale(value: Dec, scale: number): bigint {
  if (scale < value.scale) throw new RangeError("upscale to a smaller scale");
  return value.coef * pow10(scale - value.scale);
}

/** Integer division of n by d rounded half away from zero (d > 0). */
function divRoundHalfAway(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  return 2n * abs(r) >= d ? q + (n < 0n ? -1n : 1n) : q;
}

/** The scale bounds numeric_round() and numeric_trunc() clamp to. */
const MIN_ROUND_SCALE = -MAX_INTEGER_DIGITS - 1;

function clampRoundScale(scale: number): number {
  return Math.min(Math.max(scale, MIN_ROUND_SCALE), DSCALE_MAX);
}

/** Round to `scale` digits after the point, half away from zero (PostgreSQL round(x, s)). */
export function roundTo(value: Dec, requestedScale: number): Dec {
  return checked(roundUnchecked(value, clampRoundScale(requestedScale)));
}

function roundUnchecked(value: Dec, scale: number): Dec {
  if (scale >= value.scale) return { coef: upscale(value, scale), scale };
  if (scale >= 0) {
    return {
      coef: divRoundHalfAway(value.coef, pow10(value.scale - scale)),
      scale,
    };
  }
  // Negative scale rounds to tens, hundreds, ... and displays no decimals.
  const unit = pow10(value.scale - scale);
  const rounded = divRoundHalfAway(value.coef, unit) * pow10(-scale);
  return { coef: rounded, scale: 0 };
}

/** Truncate toward zero to `scale` digits after the point (PostgreSQL trunc(x, s)). */
export function truncTo(value: Dec, requestedScale: number): Dec {
  const scale = clampRoundScale(requestedScale);
  if (scale >= value.scale) return { coef: upscale(value, scale), scale };
  if (scale >= 0) {
    return { coef: value.coef / pow10(value.scale - scale), scale };
  }
  const unit = pow10(value.scale - scale);
  return { coef: (value.coef / unit) * pow10(-scale), scale: 0 };
}

/** PostgreSQL's text output for a numeric with its display scale. */
export function formatDec(value: Dec): string {
  const negative = value.coef < 0n;
  const digits = abs(value.coef).toString();
  if (value.scale === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(value.scale + 1, "0");
  const intPart = padded.slice(0, padded.length - value.scale);
  const fracPart = padded.slice(padded.length - value.scale);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

export function add(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return checked({ coef: upscale(a, scale) + upscale(b, scale), scale });
}

export function sub(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return checked({ coef: upscale(a, scale) - upscale(b, scale), scale });
}

/** Exact product; a scale above the storable 16383 is rounded to it, as PostgreSQL does. */
export function mul(a: Dec, b: Dec): Dec {
  const scale = a.scale + b.scale;
  if (scale <= DSCALE_MAX) return checked({ coef: a.coef * b.coef, scale });
  return roundTo({ coef: a.coef * b.coef, scale }, DSCALE_MAX);
}

export function neg(a: Dec): Dec {
  return { coef: -a.coef, scale: a.scale };
}

export function absDec(a: Dec): Dec {
  return { coef: abs(a.coef), scale: a.scale };
}

export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const x = upscale(a, scale);
  const y = upscale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function sign(a: Dec): -1 | 0 | 1 {
  return a.coef < 0n ? -1 : a.coef > 0n ? 1 : 0;
}

/**
 * Weight and first digit of |value| in PostgreSQL's base-10000 form: the
 * index of the most significant base-10000 group (0 = units, -1 = the first
 * four decimals) and that group's value. Zero reports (0, 0) like PostgreSQL.
 */
function nbaseLead(value: Dec): { weight: number; first: number } {
  const coef = abs(value.coef);
  if (coef === 0n) return { weight: 0, first: 0 };
  // Decimal exponent of the leading digit: |value| in [10^e, 10^(e+1)).
  const e = coef.toString().length - 1 - value.scale;
  const weight = Math.floor(e / DEC_DIGITS);
  // first = floor(|value| / 10000^weight), in [1, 9999].
  const shift = value.scale + weight * DEC_DIGITS; // |value| / 10^(w*4) = coef / 10^shift
  const first = shift >= 0 ? coef / pow10(shift) : coef * pow10(-shift);
  return { weight, first: Number(first % 10000n) };
}

/** PostgreSQL's select_div_scale(): the display scale of a quotient. */
export function divScale(a: Dec, b: Dec): number {
  const lead1 = nbaseLead(a);
  const lead2 = nbaseLead(b);
  let qweight = lead1.weight - lead2.weight;
  if (lead1.first <= lead2.first) qweight -= 1;
  let rscale = MIN_SIG_DIGITS - qweight * DEC_DIGITS;
  rscale = Math.max(rscale, a.scale, b.scale, 0);
  return Math.min(rscale, MAX_DISPLAY_SCALE);
}

function divisionByZero(): NumericError {
  return new NumericError("division by zero", "22012");
}

/** a / b at `scale` decimals, rounded half away from zero. */
export function divAt(a: Dec, b: Dec, scale: number): Dec {
  if (b.coef === 0n) throw divisionByZero();
  // a/b * 10^scale = (A * 10^(b.scale + scale)) / (B * 10^a.scale)
  const exponent = b.scale + scale - a.scale;
  let numerator = a.coef;
  let denominator = b.coef;
  if (exponent >= 0) numerator *= pow10(exponent);
  else denominator *= pow10(-exponent);
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  return { coef: divRoundHalfAway(numerator, denominator), scale };
}

export function div(a: Dec, b: Dec): Dec {
  if (b.coef === 0n) throw divisionByZero();
  return divAt(a, b, divScale(a, b));
}

/** PostgreSQL's numeric modulo: sign of the dividend, scale of the wider input. */
export function mod(a: Dec, b: Dec): Dec {
  if (b.coef === 0n) throw divisionByZero();
  const scale = Math.max(a.scale, b.scale);
  const x = upscale(a, scale);
  const y = upscale(b, scale);
  return { coef: x % y, scale };
}

export function floorDec(a: Dec): Dec {
  const t = truncTo(a, 0);
  if (a.coef < 0n && cmp(t, a) !== 0) return { coef: t.coef - 1n, scale: 0 };
  return t;
}

export function ceilDec(a: Dec): Dec {
  const t = truncTo(a, 0);
  if (a.coef > 0n && cmp(t, a) !== 0) return { coef: t.coef + 1n, scale: 0 };
  return t;
}

/**
 * Decimal position of the leading digit: |value| in [10^(n-1), 10^n) gives
 * n, so 123.4 is 3 and 0.00012 is -3. Zero has none (null).
 */
function leadingDigitPosition(value: Dec): number | null {
  if (value.coef === 0n) return null;
  return abs(value.coef).toString().length - value.scale;
}

/** Number of digits before the decimal point (0 for |value| < 1). */
function integerDigits(value: Dec): number {
  return Math.max(0, leadingDigitPosition(value) ?? 0);
}

/** PostgreSQL's numeric typmod limits (numerictypmodin), SQLSTATE 22023. */
export function checkTypmod(precision: number, scale: number): void {
  if (!Number.isInteger(precision) || precision < 1 || precision > MAX_PRECISION) {
    throw new NumericError(`NUMERIC precision ${precision} must be between 1 and ${MAX_PRECISION}`, "22023");
  }
  if (!Number.isInteger(scale) || scale < -MAX_PRECISION || scale > MAX_PRECISION) {
    throw new NumericError(`NUMERIC scale ${scale} must be between ${-MAX_PRECISION} and ${MAX_PRECISION}`, "22023");
  }
}

/**
 * Coerce to NUMERIC(precision, scale) exactly as PostgreSQL's apply_typmod
 * does: round half away from zero to `scale` (a negative scale rounds to
 * tens, hundreds, ... and displays no decimals), then refuse a nonzero value
 * whose leading digit lies above precision - scale (which may be negative
 * when scale > precision).
 */
export function coerceTypmod(value: Dec, precision: number, scale: number): Dec {
  checkTypmod(precision, scale);
  const rounded = roundTo(value, scale);
  const maxDigits = precision - scale;
  const position = leadingDigitPosition(rounded);
  if (position !== null && position > maxDigits) {
    throw new NumericError(
      `numeric field overflow: a field with precision ${precision}, scale ${scale} must round to an absolute value less than ${maxDigits === 0 ? "1" : `10^${maxDigits}`}`,
      "22003",
    );
  }
  return rounded;
}

const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

/**
 * numeric::bigint: round half away from zero; outside the int8 range (a
 * SQLite INTEGER) raises 22003.
 */
export function toInteger(value: Dec): bigint {
  const rounded = roundTo(value, 0).coef;
  if (rounded < INT8_MIN || rounded > INT8_MAX) {
    throw new NumericError("bigint out of range", "22003");
  }
  return rounded;
}

/**
 * Text key that sorts like the number: `ORDER BY dec_key(amount)`.
 * Layout: class digit (0 negative, 1 zero, 2 positive), then a fixed-width
 * exponent, then the significant digits; negative values complement both so
 * that a larger magnitude sorts first.
 */
export function sortKey(value: Dec): string {
  if (value.coef === 0n) return "1";
  const digits = abs(value.coef).toString().replace(/0+$/, "");
  const exponent = abs(value.coef).toString().length - 1 - value.scale;
  const biased = exponent + 500_000; // keeps the exponent field non-negative
  const exponentField = String(biased).padStart(7, "0");
  if (value.coef > 0n) return `2${exponentField}${digits}`;
  const complement = (s: string) =>
    s.replace(/\d/g, (d) => String(9 - Number(d)));
  // A terminator larger than any complemented digit keeps "-1" < "-1.5"
  // ordered: the longer complement of a larger magnitude sorts first.
  return `0${complement(exponentField)}${complement(digits)}~`;
}

/** Canonical text of a parsed value with its own display scale. */
export function canonical(value: unknown): string | null {
  const parsed = toDec(value);
  return parsed === null ? null : formatDec(parsed);
}

/** Exported for the aggregate implementations and tests. */
export const internal = { need, upscale, integerDigits, nbaseLead, checked };
