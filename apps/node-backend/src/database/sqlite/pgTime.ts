/**
 * Dates and timestamps with PostgreSQL semantics (ADR-263).
 *
 * Storage forms:
 *   - DATE        `YYYY-MM-DD`
 *   - TIMESTAMPTZ `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, microseconds kept)
 * Both sort correctly as text within their own kind.
 *
 * The "session time zone" is the backend process's local zone. That is the
 * zone Vision's PostgreSQL cluster used (initdb records the system zone and
 * Vision never overrode it), so `today()`, `ts_date()` and month steps on a
 * timestamp land on the same calendar days as before.
 *
 * Month arithmetic clamps to the last day of the target month, as PostgreSQL
 * does: 2026-01-31 + 1 month = 2026-02-28 (SQLite's `+1 month` modifier
 * would give 2026-03-03).
 *
 * A local wall-clock time that a DST change skips or repeats resolves as
 * PostgreSQL's DetermineTimeZoneOffset() does: to the later of the two
 * candidate instants. JavaScript's Date picks the earlier one for a repeated
 * hour, so local times are never resolved through the Date constructor.
 */

export class TimeError extends Error {
  readonly code: string;
  constructor(message: string, code = "22007") {
    super(message);
    this.name = "TimeError";
    this.code = code;
  }
}

/** An instant: epoch milliseconds plus the microseconds below them (0-999). */
export interface Instant {
  readonly ms: number;
  readonly us: number;
}

export interface CivilDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** One Gregorian 400-year cycle: the calendar repeats after it. */
const CYCLE_MS = 146_097 * DAY_MS;

/**
 * Epoch ms of a proleptic Gregorian wall-clock time read as UTC. Fields may
 * overflow (month 13, day 0, hour 24) as in Date.UTC, which maps years 0-99
 * to 1900-1999; those years are computed one cycle later instead.
 */
function wallMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  if (year >= 100) return Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return Date.UTC(year + 400, month - 1, day, hour, minute, second, ms) - CYCLE_MS;
}

function civilOfWall(wall: number): CivilDate {
  const d = new Date(wall);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The session zone's UTC offset at an instant, in ms east of UTC. */
function offsetAt(ms: number): number {
  return -new Date(ms).getTimezoneOffset() * 60_000;
}

/**
 * The instant of a session-zone wall-clock time (given as UTC-read ms).
 * Outside a DST change the one valid reading wins; inside a skipped or
 * repeated hour PostgreSQL takes the later candidate.
 */
function instantOfWall(wall: number): number {
  const before = offsetAt(wall - DAY_MS);
  const after = offsetAt(wall + DAY_MS);
  const tBefore = wall - before;
  if (before === after) {
    // No change within a day on either side: one offset applies.
    const own = offsetAt(tBefore);
    return own === before ? tBefore : wall - own;
  }
  const tAfter = wall - after;
  const beforeValid = offsetAt(tBefore) === before;
  const afterValid = offsetAt(tAfter) === after;
  if (beforeValid && !afterValid) return tBefore;
  if (afterValid && !beforeValid) return tAfter;
  return Math.max(tBefore, tAfter);
}

/** The session-zone wall clock of an instant, as UTC-read ms. */
function wallOfInstant(ms: number): number {
  return ms + offsetAt(ms);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(wallMs(year, month + 1, 0)).getUTCDate();
}

function validCivil(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export function formatDate(date: CivilDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** Parse `YYYY-MM-DD`; anything else is refused. */
export function parseDate(text: string): CivilDate {
  const m = DATE_RE.exec(text.trim());
  if (!m) throw new TimeError(`invalid input syntax for type date: "${text}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!validCivil(year, month, day)) {
    throw new TimeError(`date/time field value out of range: "${text}"`, "22008");
  }
  return { year, month, day };
}

export function isDateText(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

/** Epoch ms of local midnight of a civil date in the session zone. */
function localMidnight(date: CivilDate): number {
  return instantOfWall(wallMs(date.year, date.month, date.day));
}

/** Canonical TIMESTAMPTZ text. */
export function formatInstant(instant: Instant): string {
  const d = new Date(instant.ms);
  if (Number.isNaN(d.getTime())) throw new TimeError("timestamp out of range", "22008");
  const year = d.getUTCFullYear();
  if (year < 1 || year > 9999) throw new TimeError("timestamp out of range", "22008");
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  return `${iso.slice(0, 23)}${pad(instant.us, 3)}Z`;
}

export function instantFromDate(date: Date): Instant {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new TimeError("invalid Date value");
  return { ms, us: 0 };
}

/** C rint(): round half to even, as PostgreSQL rounds fractional seconds. */
function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Add whole microseconds to an instant. */
function addMicros(instant: Instant, micros: number): Instant {
  const totalUs = instant.us + micros;
  const carryMs = Math.floor(totalUs / 1000);
  return { ms: instant.ms + carryMs, us: totalUs - carryMs * 1000 };
}

/**
 * Parse a timestamp. With an offset or `Z` the instant is exact; without one
 * the wall-clock time is read in the session zone, and a bare date means
 * local midnight, as PostgreSQL's timestamptz input does. Fractional seconds
 * round to microseconds; `24:00:00` and a leap second `:60` roll over.
 */
export function parseInstant(text: string): Instant {
  const trimmed = text.trim();
  const dateOnly = DATE_RE.exec(trimmed);
  if (dateOnly) return { ms: localMidnight(parseDate(trimmed)), us: 0 };
  const m = TIMESTAMP_RE.exec(trimmed);
  if (!m) throw new TimeError(`invalid input syntax for type timestamp with time zone: "${text}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const fsec = m[7] === undefined ? 0 : rint(Number(`0.${m[7]}`) * 1_000_000);
  const outOfRange =
    !validCivil(year, month, day) ||
    hour > 24 ||
    minute > 59 ||
    second > 60 ||
    (hour === 24 && (minute !== 0 || second !== 0 || fsec !== 0));
  if (outOfRange) throw new TimeError(`date/time field value out of range: "${text}"`, "22008");
  const wall = wallMs(year, month, day, hour, minute, second);
  const zone = m[8];
  let ms: number;
  if (zone === undefined) {
    ms = instantOfWall(wall);
  } else {
    let offsetMinutes = 0;
    if (zone !== "Z" && zone !== "z") {
      const sign = zone.startsWith("-") ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      const hh = Number(digits.slice(0, 2));
      const mm = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
      offsetMinutes = sign * (hh * 60 + mm);
    }
    ms = wall - offsetMinutes * 60_000;
  }
  return addMicros({ ms, us: 0 }, fsec);
}

/** Coerce any accepted timestamp input (text, Date) to an instant. */
export function toInstant(value: unknown): Instant | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return instantFromDate(value);
  if (typeof value === "string") return parseInstant(value);
  throw new TimeError(`invalid timestamp value: ${String(value)}`);
}

export function canonicalTimestamp(value: unknown): string | null {
  const instant = toInstant(value);
  return instant === null ? null : formatInstant(instant);
}

/** The session-zone calendar date of an instant (PostgreSQL `ts::date`). */
export function localDateOf(instant: Instant): CivilDate {
  return civilOfWall(wallOfInstant(instant.ms));
}

/** Today in the session zone. */
export function today(now: Date = new Date()): string {
  return formatDate(localDateOf(instantFromDate(now)));
}

export function addMonthsToDate(date: CivilDate, months: number): CivilDate {
  if (!Number.isInteger(months)) throw new TimeError(`month count must be whole: ${months}`, "22023");
  const zeroBased = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(zeroBased / 12);
  const month = zeroBased - year * 12 + 1;
  if (year < 1 || year > 9999) throw new TimeError("date out of range", "22008");
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

export function addDaysToDate(date: CivilDate, days: number): CivilDate {
  if (!Number.isInteger(days)) throw new TimeError(`day count must be whole: ${days}`, "22023");
  const out = civilOfWall(wallMs(date.year, date.month, date.day) + days * DAY_MS);
  if (out.year < 1 || out.year > 9999) throw new TimeError("date out of range", "22008");
  return out;
}

/** Whole days from b to a (PostgreSQL `date - date`). */
export function diffDays(a: CivilDate, b: CivilDate): number {
  return Math.round((wallMs(a.year, a.month, a.day) - wallMs(b.year, b.month, b.day)) / DAY_MS);
}

export interface Interval {
  readonly months: number;
  readonly days: number;
  /** Microseconds of clock time. */
  readonly micros: number;
}

type IntervalUnit =
  | "microsecond" | "millisecond" | "second" | "minute" | "hour" | "day" | "week"
  | "month" | "year" | "decade" | "century" | "millennium";

/** PostgreSQL's interval unit spellings (datetime.c deltatktbl). */
const UNIT_ALIASES: Record<string, IntervalUnit> = {
  us: "microsecond", usec: "microsecond", usecs: "microsecond", useconds: "microsecond",
  microsecon: "microsecond", microsecond: "microsecond", microseconds: "microsecond",
  ms: "millisecond", msec: "millisecond", msecs: "millisecond", mseconds: "millisecond",
  millisecon: "millisecond", millisecond: "millisecond", milliseconds: "millisecond",
  s: "second", sec: "second", secs: "second", second: "second", seconds: "second",
  m: "minute", min: "minute", mins: "minute", minute: "minute", minutes: "minute",
  h: "hour", hr: "hour", hrs: "hour", hour: "hour", hours: "hour",
  d: "day", day: "day", days: "day",
  w: "week", week: "week", weeks: "week",
  mon: "month", mons: "month", month: "month", months: "month",
  y: "year", yr: "year", yrs: "year", year: "year", years: "year",
  dec: "decade", decs: "decade", decade: "decade", decades: "decade",
  c: "century", cent: "century", century: "century", centuries: "century",
  mil: "millennium", mils: "millennium", millennium: "millennium", millennia: "millennium",
};

const MICROS: Record<"second" | "minute" | "hour" | "day", number> = {
  second: 1_000_000,
  minute: 60_000_000,
  hour: 3_600_000_000,
  day: 86_400_000_000,
};

function badInterval(text: string): TimeError {
  return new TimeError(`invalid input syntax for type interval: "${text}"`);
}

type IntervalField =
  | { kind: "number"; text: string }
  | { kind: "time"; text: string }
  | { kind: "word"; text: string };

/** Split interval text into fields as PostgreSQL's ParseDateTime() does. */
function intervalFields(text: string): IntervalField[] {
  const fields: IntervalField[] = [];
  let i = 0;
  const s = text.toLowerCase();
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  const isAlpha = (c: string | undefined) => c !== undefined && c >= "a" && c <= "z";
  const readNumber = (start: number, prefix: string): void => {
    let j = start;
    while (isDigit(s[j]) || s[j] === "." || s[j] === ":") j++;
    const body = prefix + s.slice(start, j);
    fields.push({ kind: body.includes(":") ? "time" : "number", text: body });
    i = j;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f") {
      i++;
    } else if (isDigit(c) || c === ".") {
      readNumber(i, "");
    } else if (c === "+" || c === "-") {
      let j = i + 1;
      while (s[j] === " " || s[j] === "\t") j++;
      if (!isDigit(s[j]) && s[j] !== ".") throw badInterval(text);
      readNumber(j, c);
    } else if (isAlpha(c)) {
      let j = i;
      while (isAlpha(s[j])) j++;
      fields.push({ kind: "word", text: s.slice(i, j) });
      i = j;
    } else if (c === "@") {
      i++;
    } else {
      throw badInterval(text);
    }
  }
  return fields;
}

/**
 * Parse interval text the way PostgreSQL's DecodeInterval() reads the
 * spellings Vision's SQL used: `'3 months'`, `'1 month - 1 day'`, `'-1 day'`,
 * `'2 weeks'`, `'1 day 02:00:00'`, `'@ 1 day ago'`, `'1.5 days'`. Fields are
 * read right to left; a number takes the unit after it, and a trailing bare
 * number is seconds. Fractions cascade down as PostgreSQL does: a month is
 * 30 days, a day 24 hours, a year's fraction rounds to whole months.
 */
export function parseInterval(text: string): Interval {
  const fields = intervalFields(text);
  if (fields.length === 0) throw badInterval(text);
  let months = 0;
  let days = 0;
  let micros = 0;
  let unit: IntervalUnit = "second";
  let ago = false;
  let sawValue = false;
  const fractDays = (frac: number, perUnit: number): void => {
    const extra = frac * perUnit;
    const whole = Math.trunc(extra);
    days += whole;
    micros += rint((extra - whole) * MICROS.day);
  };
  for (let k = fields.length - 1; k >= 0; k--) {
    const field = fields[k];
    if (field === undefined) continue;
    if (field.kind === "word") {
      if (field.text === "ago") {
        if (ago) throw badInterval(text);
        ago = true;
        continue;
      }
      const u = UNIT_ALIASES[field.text];
      if (u === undefined) throw badInterval(text);
      unit = u;
      continue;
    }
    sawValue = true;
    if (field.kind === "time") {
      const m = /^([+-]?)(\d+):(\d{1,2})(?::(\d{1,2})(\.\d*)?)?$/.exec(field.text);
      if (!m) throw badInterval(text);
      const sign = m[1] === "-" ? -1 : 1;
      const minutes = Number(m[3]);
      const seconds = m[4] === undefined ? 0 : Number(m[4]);
      if (minutes > 59 || seconds > 59) throw new TimeError(`interval field value out of range: "${text}"`, "22015");
      const frac = m[5] === undefined || m[5] === "." ? 0 : rint(Number(`0${m[5]}`) * 1_000_000);
      micros += sign * (Number(m[2]) * MICROS.hour + minutes * MICROS.minute + seconds * MICROS.second + frac);
      unit = "second";
      continue;
    }
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(field.text)) throw badInterval(text);
    const value = Number(field.text);
    const whole = Math.trunc(value);
    const frac = value - whole;
    switch (unit) {
      case "microsecond":
        micros += rint(value);
        break;
      case "millisecond":
        micros += rint(value * 1000);
        break;
      case "second":
        micros += whole * MICROS.second + rint(frac * MICROS.second);
        break;
      case "minute":
        micros += whole * MICROS.minute + rint(frac * MICROS.minute);
        break;
      case "hour":
        micros += whole * MICROS.hour + rint(frac * MICROS.hour);
        break;
      case "day":
        days += whole;
        micros += rint(frac * MICROS.day);
        break;
      case "week":
        days += whole * 7;
        fractDays(frac, 7);
        break;
      case "month":
        months += whole;
        fractDays(frac, 30);
        break;
      case "year":
        months += whole * 12 + rint(frac * 12);
        break;
      case "decade":
        months += whole * 120 + rint(frac * 120);
        break;
      case "century":
        months += whole * 1200 + rint(frac * 1200);
        break;
      case "millennium":
        months += whole * 12000 + rint(frac * 12000);
        break;
    }
    unit = "second";
  }
  if (!sawValue) throw badInterval(text);
  const sign = ago ? -1 : 1;
  // `|| 0` turns a negated zero into 0.
  return { months: sign * months || 0, days: sign * days || 0, micros: sign * micros || 0 };
}

export function negateInterval(i: Interval): Interval {
  return { months: -i.months, days: -i.days, micros: -i.micros };
}

/**
 * date + interval. PostgreSQL computes a timestamp without time zone; Vision
 * keeps a date, so clock time that is not a whole number of days is refused.
 */
export function addIntervalToDate(date: CivilDate, interval: Interval): CivilDate {
  if (interval.micros % MICROS.day !== 0) {
    throw new TimeError(
      "a date plus an interval with hours, minutes or seconds is a timestamp; convert the date first",
      "22023",
    );
  }
  const shifted = addMonthsToDate(date, interval.months);
  return addDaysToDate(shifted, interval.days + interval.micros / MICROS.day);
}

/**
 * timestamptz + interval as PostgreSQL's timestamptz_pl_interval() computes
 * it in the session zone: months on the local calendar (clamped) and
 * resolved, then days on the local calendar and resolved again (so a day
 * across a DST change keeps the wall-clock time), then clock time as an
 * exact duration.
 */
export function addIntervalToInstant(instant: Instant, interval: Interval): Instant {
  let ms = instant.ms;
  const step = (shift: (date: CivilDate) => CivilDate): void => {
    const wall = wallOfInstant(ms);
    const timeOfDay = wall - Math.floor(wall / DAY_MS) * DAY_MS;
    const civil = shift(civilOfWall(wall));
    ms = instantOfWall(wallMs(civil.year, civil.month, civil.day) + timeOfDay);
  };
  if (interval.months !== 0) step((date) => addMonthsToDate(date, interval.months));
  if (interval.days !== 0) step((date) => addDaysToDate(date, interval.days));
  return addMicros({ ms, us: instant.us }, interval.micros);
}

export type TruncUnit =
  | "millennium" | "century" | "decade" | "year" | "quarter" | "month" | "week" | "day"
  | "hour" | "minute" | "second" | "milliseconds" | "microseconds";

const TRUNC_UNITS: Record<string, TruncUnit> = {
  millennium: "millennium", millennia: "millennium", mil: "millennium", mils: "millennium",
  century: "century", centuries: "century", c: "century", cent: "century",
  decade: "decade", decades: "decade", dec: "decade", decs: "decade",
  year: "year", years: "year", y: "year", yr: "year", yrs: "year",
  quarter: "quarter", qtr: "quarter",
  month: "month", months: "month", mon: "month", mons: "month",
  week: "week", weeks: "week", w: "week",
  day: "day", days: "day", d: "day",
  hour: "hour", hours: "hour", h: "hour", hr: "hour", hrs: "hour",
  minute: "minute", minutes: "minute", m: "minute", min: "minute", mins: "minute",
  second: "second", seconds: "second", s: "second", sec: "second", secs: "second",
  milliseconds: "milliseconds", millisecond: "milliseconds", ms: "milliseconds", msec: "milliseconds", msecs: "milliseconds",
  microseconds: "microseconds", microsecond: "microseconds", us: "microseconds", usec: "microseconds", usecs: "microseconds",
};

function truncUnit(unit: string): TruncUnit {
  const u = TRUNC_UNITS[unit.trim().toLowerCase()];
  if (u === undefined) throw new TimeError(`unit "${unit}" not recognized for date_trunc`, "22023");
  return u;
}

/** Monday of the ISO week containing a date. */
function isoWeekStart(date: CivilDate): CivilDate {
  const dow = new Date(wallMs(date.year, date.month, date.day)).getUTCDay();
  return addDaysToDate(date, -((dow + 6) % 7));
}

function truncCivil(unit: TruncUnit, date: CivilDate): CivilDate {
  switch (unit) {
    case "millennium":
      return { year: Math.floor((date.year + 999) / 1000) * 1000 - 999, month: 1, day: 1 };
    case "century":
      return { year: Math.floor((date.year + 99) / 100) * 100 - 99, month: 1, day: 1 };
    case "decade":
      return { year: Math.floor(date.year / 10) * 10, month: 1, day: 1 };
    case "year":
      return { year: date.year, month: 1, day: 1 };
    case "quarter":
      return { year: date.year, month: Math.floor((date.month - 1) / 3) * 3 + 1, day: 1 };
    case "month":
      return { year: date.year, month: date.month, day: 1 };
    case "week":
      return isoWeekStart(date);
    default:
      return date;
  }
}

/** date_trunc on a date; the result stays a date. */
export function truncDate(unit: string, date: CivilDate): CivilDate {
  const out = truncCivil(truncUnit(unit), date);
  if (out.year < 1) throw new TimeError("date out of range", "22008");
  return out;
}

/**
 * date_trunc on a timestamptz in the session zone. Day and larger units
 * land on local midnight; hour, minute and second keep the instant's own UTC
 * offset, so truncating inside a repeated hour stays in that hour, as
 * PostgreSQL's timestamptz_trunc does.
 */
export function truncInstant(unit: string, instant: Instant): Instant {
  const u = truncUnit(unit);
  switch (u) {
    case "microseconds":
      return instant;
    case "milliseconds":
      return { ms: instant.ms, us: 0 };
    case "second":
    case "minute":
    case "hour": {
      const offset = offsetAt(instant.ms);
      const size = u === "second" ? 1000 : u === "minute" ? 60_000 : 3_600_000;
      const wall = instant.ms + offset;
      return { ms: Math.floor(wall / size) * size - offset, us: 0 };
    }
    default: {
      const civil = truncCivil(u, localDateOf(instant));
      if (civil.year < 1) throw new TimeError("timestamp out of range", "22008");
      return { ms: localMidnight(civil), us: 0 };
    }
  }
}

/** Julian day number of a proleptic Gregorian date (PostgreSQL date2j). */
function julianDay(date: CivilDate): number {
  return Math.round(wallMs(date.year, date.month, date.day) / DAY_MS) + 2_440_588;
}

/** ISO 8601 week number and week-numbering year. */
function isoWeek(date: CivilDate): { week: number; year: number } {
  const monday = isoWeekStart(date);
  const thursday = addDaysToDate(monday, 3);
  const firstThursdayYearStart = wallMs(thursday.year, 1, 1);
  const week = Math.floor((wallMs(thursday.year, thursday.month, thursday.day) - firstThursdayYearStart) / (7 * DAY_MS)) + 1;
  return { week, year: thursday.year };
}

const PART_FIELDS: Record<string, string> = {
  year: "year", years: "year", y: "year", yr: "year", yrs: "year",
  month: "month", months: "month", mon: "month", mons: "month",
  day: "day", days: "day", d: "day",
  hour: "hour", hours: "hour", h: "hour", hr: "hour", hrs: "hour",
  minute: "minute", minutes: "minute", m: "minute", min: "minute", mins: "minute",
  second: "second", seconds: "second", s: "second", sec: "second", secs: "second",
  milliseconds: "milliseconds", millisecond: "milliseconds", ms: "milliseconds", msec: "milliseconds", msecs: "milliseconds",
  microseconds: "microseconds", microsecond: "microseconds", us: "microseconds", usec: "microseconds", usecs: "microseconds",
  quarter: "quarter", qtr: "quarter",
  week: "week", weeks: "week", w: "week",
  dow: "dow", isodow: "isodow", doy: "doy", isoyear: "isoyear", epoch: "epoch", julian: "julian", j: "julian",
  decade: "decade", decades: "decade", dec: "decade", decs: "decade",
  century: "century", centuries: "century", c: "century", cent: "century",
  millennium: "millennium", millennia: "millennium", mil: "millennium", mils: "millennium",
  timezone: "timezone", timezone_hour: "timezone_hour", timezone_m: "timezone_minute", timezone_minute: "timezone_minute",
};

/**
 * PostgreSQL date_part(field, x) as float8. A timestamp is read in the
 * session zone. A date behaves as a timestamp without time zone at
 * midnight: its epoch counts from 1970-01-01 without a zone, and the time
 * zone fields are refused (0A000).
 */
export function datePart(field: string, value: CivilDate | Instant): number {
  const f = PART_FIELDS[field.trim().toLowerCase()];
  if (f === undefined) throw new TimeError(`unit "${field}" not recognized for date_part`, "22023");
  const isInstant = "ms" in value;
  const wall = isInstant ? wallOfInstant(value.ms) : wallMs(value.year, value.month, value.day);
  const civil = civilOfWall(wall);
  const msOfDay = wall - Math.floor(wall / DAY_MS) * DAY_MS;
  const us = isInstant ? value.us : 0;
  const hour = Math.floor(msOfDay / 3_600_000);
  const minute = Math.floor(msOfDay / 60_000) % 60;
  const second = Math.floor(msOfDay / 1000) % 60;
  const fsec = (msOfDay % 1000) * 1000 + us;
  switch (f) {
    case "year":
      return civil.year;
    case "quarter":
      return Math.floor((civil.month - 1) / 3) + 1;
    case "month":
      return civil.month;
    case "day":
      return civil.day;
    case "dow":
      return new Date(wall).getUTCDay();
    case "isodow": {
      const dow = new Date(wall).getUTCDay();
      return dow === 0 ? 7 : dow;
    }
    case "doy":
      return diffDays(civil, { year: civil.year, month: 1, day: 1 }) + 1;
    case "week":
      return isoWeek(civil).week;
    case "isoyear":
      return isoWeek(civil).year;
    case "decade":
      return Math.floor(civil.year / 10);
    case "century":
      return Math.floor((civil.year + 99) / 100);
    case "millennium":
      return Math.floor((civil.year + 999) / 1000);
    case "hour":
      return hour;
    case "minute":
      return minute;
    case "second":
      return second + fsec / 1_000_000;
    case "milliseconds":
      return second * 1000 + fsec / 1000;
    case "microseconds":
      return second * 1_000_000 + fsec;
    case "julian":
      return julianDay(civil) + (hour * 3600 + minute * 60 + second + fsec / 1_000_000) / 86_400;
    case "epoch":
      return isInstant ? (value.ms * 1000 + value.us) / 1_000_000 : wall / 1000;
    default: {
      if (!isInstant) {
        throw new TimeError(`unit "${field}" not supported for type timestamp without time zone`, "0A000");
      }
      const offsetSeconds = offsetAt(value.ms) / 1000;
      if (f === "timezone") return offsetSeconds;
      if (f === "timezone_hour") return Math.trunc(offsetSeconds / 3600);
      return Math.trunc(offsetSeconds / 60) % 60;
    }
  }
}

/** to_char for the patterns Vision uses; a timestamp formats its session-zone date. */
export function toChar(value: CivilDate | Instant, format: string): string {
  const civil: CivilDate = "ms" in value ? localDateOf(value) : value;
  switch (format) {
    case "YYYY-MM-DD":
      return formatDate(civil);
    case "YYYY-MM":
      return `${pad(civil.year, 4)}-${pad(civil.month, 2)}`;
    case "YYYY":
      return pad(civil.year, 4);
    case "MM":
      return pad(civil.month, 2);
    case "DD":
      return pad(civil.day, 2);
    default:
      throw new TimeError(`to_char format "${format}" is not supported`, "22023");
  }
}

/** A value is a timestamp (not a bare date) when it has a time part. */
export function isTimestampText(value: string): boolean {
  return !DATE_RE.test(value.trim());
}
