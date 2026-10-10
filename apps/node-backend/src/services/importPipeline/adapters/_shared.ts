/**
 * Shared helpers for bank CSV adapters.
 *
 * Pure utilities only — keep I/O to the CSV reader below. Everything here is
 * reused across multiple adapters; if a helper grows adapter-specific branches,
 * move it back into the adapter that needs it.
 */

import fs from "fs";
import { parse } from "csv-parse/sync";
import type { Options as CsvParseOptions } from "csv-parse/sync";
import { z } from "zod";
import { toDecimal } from "../../../lib/money.ts";
import { ValidationError } from "../../../middleware/errorHandler.ts";
import {
  normalizeCsvEncoding,
  normalizeCsvNumberFormat,
} from "../../../lib/csvFormatOptions.ts";

// The format options live in lib/ so lib/parserConfigSchema.ts can use them
// without importing a service; re-exported for the adapters' callers.
export {
  CSV_NUMBER_FORMATS,
  normalizeCsvEncoding,
  normalizeCsvNumberFormat,
} from "../../../lib/csvFormatOptions.ts";
export type { CsvNumberFormat } from "../../../lib/csvFormatOptions.ts";

/**
 * Decode CSV bytes once for all importers. Explicit Latin-1 keeps ISO byte
 * semantics; Windows-1252 maps its euro and punctuation bytes correctly.
 * UTF-8 retains the established Latin-1 fallback for invalid UTF-8 exports.
 */
export function decodeCsvBuffer(
  buffer: Buffer,
  encoding: unknown = "utf-8",
): string {
  const normalized = normalizeCsvEncoding(encoding);
  if (normalized === "windows-1252") {
    return new TextDecoder("windows-1252").decode(buffer);
  }
  const content = buffer.toString(normalized);
  return normalized === "utf-8" && content.includes("\uFFFD")
    ? buffer.toString("latin1")
    : content;
}

/**
 * The row shape every bank CSV adapter emits and `stage.js` persists into
 * `import_staging`. Adapters differ only in how they GET here; the shape itself
 * is a contract shared by the whole pipeline.
 */
export interface ParsedBankTransaction {
  /** UTC-midnight (see parseDateFlexibleUtc) — never a local-midnight Date. */
  date: Date;
  /** canonical IBAN ({@link canonicalIban}) or the bank literal when the export carries no account. */
  bankAccount: string;
  /** uppercased, cleaned counterparty name; 'UNKNOWN' when absent. */
  recipient: string;
  memo: string;
  /** signed — negative is an outflow. */
  amount: number;
  /** ISO-4217 ({@link normalizeIsoCurrency}); null when the CSV had none, and commit defaults it to EUR. */
  currency: string | null;
  /** the export's stamped running balance; null when the export carries none (ADR-094). */
  balance: number | null;
  recipientAccount: string | null;
  recipientAddress: string | null;
  recipientBankName: string | null;
  comment: string | null;
  /** the source line/record, kept for dedup + provenance. */
  rawData: string;
  /** immutable source transaction identifier when the export provides one. */
  sourceId?: string | null;
  /** belfius only: (statement no, transaction no); consumed and stripped by its applyRunningBalances. */
  _seq?: [number, number];
}

/**
 * A parsed transaction list carrying the adapter's own count of rows it could
 * not interpret. The counter rides on the array (rather than a wrapper object)
 * because that is the shape every adapter's `parse` has always returned.
 */
export type ParsedBankTransactions = ParsedBankTransaction[] & {
  skipped?: number;
};

/** True for a Date at exactly 00:00:00.000 UTC. */
export function isUtcMidnight(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

/**
 * Runtime contract for {@link ParsedBankTransaction} as an adapter returns it
 * (ADR-193). Adapters skip rows they cannot interpret, so a row breaking this
 * is an adapter bug; the registry (adapters/index.ts) checks every adapter's
 * output against it. Strict: `_seq` must already be stripped.
 */
export const parsedBankTransactionSchema = z.strictObject({
  date: z.date().refine(isUtcMidnight, "expected a UTC-midnight date"),
  bankAccount: z.string().min(1),
  recipient: z.string(),
  memo: z.string(),
  /** zod numbers reject NaN and ±Infinity. */
  amount: z.number(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  balance: z.number().nullable(),
  recipientAccount: z.string().nullable(),
  recipientAddress: z.string().nullable(),
  recipientBankName: z.string().nullable(),
  comment: z.string().nullable(),
  rawData: z.string(),
  sourceId: z.string().min(1).nullable().optional(),
}) satisfies z.ZodType<ParsedBankTransaction>;

/** An adapter's whole result: the rows plus the `skipped` counter riding on the array. */
export const parsedBankTransactionsSchema = z.object({
  rows: z.array(parsedBankTransactionSchema),
  skipped: z.number().int().nonnegative().optional(),
});

/**
 * Parse an already-cleaned numeric string into a number via the canonical
 * decimal path. Returns NaN for empty or non-numeric input. Use instead of
 * raw `parseFloat` so the imported amount has one well-defined interpretation.
 */
export function parseDecimalSafe(value: unknown): number {
  const s = String(value ?? "").trim();
  if (!s) return NaN;
  try {
    return toDecimal(s).toNumber();
  } catch {
    return NaN;
  }
}

/**
 * Normalize a CSV currency cell to an uppercase ISO-4217-shaped code, or null
 * when the cell doesn't hold one. transactions.currency is VARCHAR(3) with an
 * `^[A-Z]{3}$` CHECK (migration 0046), so a free-text cell ("euro", "US$")
 * forwarded raw failed the whole commit as a raw DB 500 mid-import; a null
 * falls back to the pipeline's EUR default at commit instead.
 */
export function normalizeIsoCurrency(value: unknown): string | null {
  const code = String(value ?? "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * Read a text file, decoding as UTF-8 but falling back to latin1 (ISO-8859-1)
 * when the bytes aren't valid UTF-8. Belgian bank exports are frequently
 * windows-1252/latin-1, where e.g. `é` is the single byte 0xE9 — decoding that
 * as UTF-8 yields the U+FFFD replacement char and corrupts recipient/memo text.
 * The replacement char never appears in a clean UTF-8 decode of latin-1 source,
 * so its presence is a reliable signal to re-decode as latin1.
 */
export async function readTextWithEncodingFallback(
  filePath: string,
): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  return decodeCsvBuffer(buffer);
}

/**
 * Cell `index` of a parsed tuple the caller has already checked holds at
 * least `index + 1` cells (each adapter's MIN_FIELDS guard). Throws rather
 * than returning undefined should that invariant ever break.
 */
export function cellAt(parts: readonly string[], index: number): string {
  const cell = parts[index];
  if (cell === undefined) {
    throw new Error(`CSV record has no field ${index}`);
  }
  return cell;
}

/**
 * Parse a `DD/MM/YYYY` cell into a UTC-midnight Date, rejecting out-of-range
 * components rather than letting Date.UTC roll them over.
 */
export function parseDayMonthYear(dateStr: string): Date | null {
  const dateParts = String(dateStr).split("/");
  const [dayStr, monthStr, yearStr] = dateParts;
  if (
    dateParts.length !== 3 ||
    dayStr === undefined ||
    monthStr === undefined ||
    yearStr === undefined
  )
    return null;
  const day = parseInt(dayStr, 10);
  const month = parseInt(monthStr, 10);
  const year = parseInt(yearStr, 10);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year)
  )
    return null;
  // UTC midnight to avoid TZ-induced day shifts when serialised back to YYYY-MM-DD.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(date.getTime())) return null;
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/;

/**
 * Parse a date string of unknown format into a UTC-midnight Date.
 *
 * ISO dates are constructed directly via Date.UTC. Anything else falls back to
 * the engine parser, then **rebuilds the parsed local calendar day at UTC
 * midnight** — `new Date(string)` alone yields local midnight for non-ISO
 * formats, which `toISOString()` in stage/dedup then shifts to the previous
 * day in UTC+ zones (and changes the dedup hash with it).
 *
 * @returns UTC-midnight Date, or null when unparseable
 */
export function parseDateFlexibleUtc(
  dateStr: string | null | undefined,
): Date | null {
  const s = String(dateStr ?? "").trim();
  if (!s) return null;
  const iso = ISO_DATE_RE.exec(s);
  if (iso) {
    const date = new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
    );
    return isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return null;
  return new Date(
    Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()),
  );
}

// Date formats offered by the import UI and used by the custom-config adapters
// (generic.js transactions + portfolioGenericAdapter.js). Single source of
// truth so the two adapters can't drift. Each is parsed via Date.UTC so a row
// never shifts a calendar day under a server TZ east of UTC; callers reject an
// unsupported format up front rather than silently importing zero rows.
export const SUPPORTED_DATE_FORMATS = [
  "%Y-%m-%d",
  "%d/%m/%Y",
  "%m/%d/%Y",
  "%d-%m-%Y",
  "%Y-%m-%d %H:%M:%S",
];

/**
 * Parse a date string against one of SUPPORTED_DATE_FORMATS into a UTC-midnight
 * Date. Unknown tokens fall back to parseDateFlexibleUtc.
 */
export function parseDateWithFormat(dateStr: string, fmt: string): Date | null {
  // Round-trip guard: Date.UTC silently rolls over out-of-range components
  // (Date.UTC(2024, 24, 12) → 2026-01-12 for a MM/DD file parsed as %d/%m/%Y),
  // and a 2-digit year like "24" becomes 1924. Reject instead of importing a
  // wrong day — matches parseDayMonthYear's validation.
  /** @param m 1-based month */
  // A part the separator split did not produce is undefined: no date.
  const build = (
    y: number | undefined,
    m: number | undefined,
    d: number | undefined,
  ): Date | null => {
    if (y === undefined || m === undefined || d === undefined) return null;
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d))
      return null;
    if (y < 100) return null; // 2-digit-year misparse (e.g. "24" → 1924)
    const date = new Date(Date.UTC(y, m - 1, d));
    if (isNaN(date.getTime())) return null;
    if (
      date.getUTCFullYear() !== y ||
      date.getUTCMonth() !== m - 1 ||
      date.getUTCDate() !== d
    ) {
      return null;
    }
    return date;
  };
  if (fmt.includes("%d/%m/%Y")) {
    const [d, m, y] = dateStr.split("/").map((s) => parseInt(s, 10));
    return build(y, m, d);
  }
  if (fmt.includes("%m/%d/%Y")) {
    const [m, d, y] = dateStr.split("/").map((s) => parseInt(s, 10));
    return build(y, m, d);
  }
  if (fmt.includes("%d-%m-%Y")) {
    const [d, m, y] = dateStr.split("-").map((s) => parseInt(s, 10));
    return build(y, m, d);
  }
  if (fmt.includes("%Y-%m-%d")) {
    // Covers both '%Y-%m-%d' and '%Y-%m-%d %H:%M:%S' — parse the date part only,
    // as UTC, so an early-morning timestamp can't roll back a day.
    const [y, m, d] = dateStr
      .slice(0, 10)
      .split("-")
      .map((s) => parseInt(s, 10));
    return build(y, m, d);
  }
  // Unknown format token: shared parser rebuilds the parsed calendar day at
  // UTC midnight (plain new Date() was local → day-shift on serialization).
  return parseDateFlexibleUtc(dateStr);
}

/**
 * Parse an EU-formatted decimal cell ("1.234,56"). A dot-decimal cell without a
 * comma is left untouched.
 *
 * @returns NaN when the cell isn't numeric
 */
export function parseCommaDecimal(value: unknown): number {
  const s = String(value).replace(/\s/g, "");
  // EU format: comma is the decimal separator and dots are thousands separators.
  // "1.234,56" must become "1234.56" — the old code only swapped the comma,
  // leaving "1.234.56" which Decimal rejects (NaN), silently dropping the row.
  // Only strip dots when a comma is present so a dot-decimal "12.5" is untouched.
  if (s.includes(",")) {
    return parseDecimalSafe(s.replace(/\./g, "").replace(",", "."));
  }
  return parseDecimalSafe(s);
}

/**
 * Robust amount parser that handles both EU (1.234,56) and US (1,234.56)
 * formats, currency symbols, parenthetical negatives, and leading sign.
 *
 * @returns NaN when the cell isn't numeric
 */
export function parseAmountField(raw: unknown): number {
  let s = String(raw || "").trim();
  if (!s) return NaN;
  s = s.replace(/\s/g, "");
  s = s.replace(/[$€£¥]/g, "");
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    const tail = s.length - lastComma - 1;
    if (tail === 3 && s.indexOf(",") !== lastComma) {
      s = s.replace(/,/g, "");
    } else {
      s = s.replace(",", ".");
    }
  }
  const n = parseDecimalSafe(s);
  if (isNaN(n)) return NaN;
  return negative ? -n : n;
}

/**
 * Parse a custom-mapped numeric cell without guessing between grouping and
 * decimals. Provider-specific adapters keep their existing parseAmountField.
 * @returns NaN for non-numeric cells; ambiguity is a validation error.
 */
export function parseCustomAmount(
  raw: unknown,
  format: unknown = "auto",
  context: { rowNumber?: number; column?: string } = {},
): number {
  const numberFormat = normalizeCsvNumberFormat(format);
  let text = String(raw ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace(/[$€£¥]/g, "");
  if (!text) return NaN;
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith("-") || text.startsWith("+")) {
    if (text.startsWith("-")) negative = true;
    text = text.slice(1);
  }

  // Validate the mantissa separately: an exponent must not erase an
  // ambiguous grouping/decimal choice through floating-point underflow.
  const scientific = /^(.*?)([eE][+-]?\d+)$/.exec(text);
  const mantissa = scientific?.[1] ?? text;
  const exponent = scientific?.[2] ?? "";
  const dot = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?$|^\.\d+$/;
  const comma = /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d*)?$|^,\d+$/;
  const validDot = dot.test(mantissa);
  const validComma = comma.test(mantissa);
  const dotText = mantissa.replace(/,/g, "");
  const commaText = mantissa.replace(/\./g, "").replace(",", ".");
  const dotValue = validDot ? parseDecimalSafe(dotText + exponent) : NaN;
  const commaValue = validComma ? parseDecimalSafe(commaText + exponent) : NaN;
  let result: number;
  if (numberFormat === "decimal_dot") result = dotValue;
  else if (numberFormat === "decimal_comma") result = commaValue;
  else {
    if (
      validDot &&
      validComma &&
      !toDecimal(dotText).eq(toDecimal(commaText))
    ) {
      const row =
        context.rowNumber === undefined
          ? ""
          : ` at CSV data row ${context.rowNumber}`;
      const column =
        context.column === undefined ? "" : `, column "${context.column}"`;
      throw new ValidationError(
        `Ambiguous number${row}${column}. Select decimal_dot or decimal_comma number_format.`,
      );
    }
    result = Number.isFinite(dotValue) ? dotValue : commaValue;
  }
  if (!Number.isFinite(result)) return NaN;
  return negative ? -result : result;
}

const UTF8_BOM_RE = /^\uFEFF/;

/**
 * Split file content into physical lines, stripping a leading UTF-8 BOM.
 */
export function splitCsvLines(content: unknown): string[] {
  // Strip the UTF-8 BOM (U+FEFF) that Excel and several Windows tools
  // prepend to exported CSVs. Without this, the first header byte leaks
  // into the first field and breaks every column-name lookup downstream.
  return String(content)
    .replace(UTF8_BOM_RE, "")
    .split(/\r\n|\r|\n/);
}

/**
 * Split one delimited CSV record into fields, honouring RFC-4180 quoting.
 *
 * The Belgian bank adapters used to `line.split(';')`, so a quoted field
 * containing the delimiter (`"Factuur 123; klant 456"`) shifted every later
 * column — dates/amounts misread and rows silently skipped, or worse, a
 * shifted numeric field parsed as the amount. Delegates to csv-parse so
 * quoted delimiters and doubled quotes ("") are handled like the record-based
 * adapters already do. Returns null for an unparseable line (caller counts it
 * as skipped).
 *
 * @param line - a single physical CSV line (no embedded newlines)
 */
function splitDelimitedRecord(line: string, delimiter = ";"): string[] | null {
  try {
    // relax_quotes: bank exports occasionally leave a stray quote mid-field;
    // treat it as literal text instead of failing the whole row.
    const rows = parse(line, {
      delimiter,
      relax_column_count: true,
      relax_quotes: true,
    });
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Join the adapter's collected comment fragments, or null when there are none.
 */
export function buildOptionalComment(commentParts: string[]): string | null {
  return commentParts.length ? commentParts.join(" | ") : null;
}

/**
 * Canonicalize an account identifier (IBAN/account number) for use as the
 * account label: strip all whitespace and uppercase, so the same account never
 * splits on spacing/case across imports or a manual entry (ADR-088). Empty in →
 * empty out (callers fall back to the bank literal). Belgian IBANs arrive
 * space-grouped (e.g. "BE81 0637 5694 4024") → "BE81063756944024".
 */
export function canonicalIban(value: string | null | undefined): string {
  if (!value) return "";
  return String(value).replace(/\s+/g, "").toUpperCase();
}

/**
 * One csv-parse record: an object keyed by column name when `columns` is set
 * (`true`, a header list or a header function), otherwise a tuple of cells.
 */
export type CsvRecord = Record<string, string> | string[];

/**
 * Read and parse a CSV file with csv-parse.
 *
 * The element type genuinely depends on `options`: with `columns` (what every
 * record-based adapter passes) csv-parse yields `Record<string, string>`
 * objects, otherwise `string[]` tuples. csv-parse's own signature only models
 * the tuple case, so the caller names the shape it asked for through `T`
 * (inferred from an annotated result); it defaults to the object form.
 */
export async function parseCsvFile<
  T extends CsvRecord = Record<string, string>,
>(
  filePath: string,
  options: CsvParseOptions,
  encoding: unknown = "utf-8",
): Promise<T[]> {
  const buffer = await fs.promises.readFile(filePath);
  const content = decodeCsvBuffer(buffer, encoding);
  return parseCsvText<T>(content, options);
}

const RAW_CSV_RECORD = Symbol("vision.rawCsvRecord");

/** csv-parse's per-row shape when `info` and `raw` are enabled. */
interface CsvParseInfoEntry {
  record?: unknown;
  raw?: unknown;
}

/** A parsed CSV tuple/object, optionally carrying its literal source record. */
export type CsvSourceRecord = (Record<string, unknown> | unknown[]) & {
  [RAW_CSV_RECORD]?: string;
};

/**
 * Remove only the record delimiter reported by csv-parse. All other bytes in
 * the decoded record, including quoting, embedded newlines and surrounding
 * field whitespace, remain provenance.
 */
export function stripTerminalRecordDelimiter(raw: unknown): string {
  return String(raw ?? "").replace(/(?:\r\n|\r|\n)$/, "");
}

/**
 * Parse decoded CSV text and attach its literal source record to each parsed
 * tuple/object without changing the public record shape adapters consume.
 * `T` names the record shape `options` asks for, as for parseCsvFile.
 */
export function parseCsvText<T extends CsvRecord = Record<string, string>>(
  content: string,
  options: CsvParseOptions,
): T[] {
  const parsed: unknown[] = parse(String(content).replace(UTF8_BOM_RE, ""), {
    ...options,
    info: true,
    raw: true,
  });
  return parsed.map((entry) => {
    const info = entry as CsvParseInfoEntry | null | undefined;
    const record = info?.record ?? entry;
    if (
      info?.raw !== undefined &&
      record &&
      (typeof record === "object" || typeof record === "function")
    ) {
      Object.defineProperty(record, RAW_CSV_RECORD, {
        configurable: false,
        enumerable: false,
        value: stripTerminalRecordDelimiter(info?.raw),
        writable: false,
      });
    }
    // csv-parse produced the shape `options` asked for; see CsvRecord.
    return record as T;
  });
}

/**
 * Return the exact decoded CSV record attached by parseCsvFile/parseCsvText.
 * The reconstruction fallback keeps unit-test stubs and non-CSV callers
 * compatible, but production adapters all receive literal records.
 */
export function rawDataForCsvRecord(record: CsvSourceRecord): string {
  return record?.[RAW_CSV_RECORD] ?? buildRawRowString(record);
}

/**
 * Flatten a parsed CSV record into the `rawData` provenance string.
 *
 * @param row a `columns: true` csv-parse record
 */
export function buildRawRowString(
  row: Record<string, unknown> | unknown[],
): string {
  return Object.values(row).join("|");
}

export { splitDelimitedRecord as __splitDelimitedRecord };
