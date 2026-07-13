/**
 * Shared helpers for bank CSV adapters.
 *
 * Pure utilities only — keep I/O to the CSV reader below. Everything here is
 * reused across multiple adapters; if a helper grows adapter-specific branches,
 * move it back into the adapter that needs it.
 */

import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { toDecimal } from '../../../lib/money.js';

/**
 * Parse an already-cleaned numeric string into a number via the canonical
 * decimal path. Returns NaN for empty or non-numeric input. Use instead of
 * raw `parseFloat` so the imported amount has one well-defined interpretation.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function parseDecimalSafe(value) {
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  try {
    return toDecimal(s).toNumber();
  } catch {
    return NaN;
  }
}

/**
 * @param {string} filePath
 * @param {BufferEncoding} [encoding]
 */
export async function readFileAsync(filePath, encoding = 'utf-8') {
  return fs.promises.readFile(filePath, encoding);
}

export function parseDayMonthYear(dateStr) {
  const dateParts = String(dateStr).split('/');
  if (dateParts.length !== 3) return null;
  const day = parseInt(dateParts[0], 10);
  const month = parseInt(dateParts[1], 10);
  const year = parseInt(dateParts[2], 10);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;
  // UTC midnight to avoid TZ-induced day shifts when serialised back to YYYY-MM-DD.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
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
 * @param {string} dateStr
 * @returns {Date|null} UTC-midnight Date, or null when unparseable
 */
export function parseDateFlexibleUtc(dateStr) {
  const s = String(dateStr ?? '').trim();
  if (!s) return null;
  const iso = ISO_DATE_RE.exec(s);
  if (iso) {
    const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
}

// Date formats offered by the import UI and used by the custom-config adapters
// (generic.js transactions + portfolioGenericAdapter.js). Single source of
// truth so the two adapters can't drift. Each is parsed via Date.UTC so a row
// never shifts a calendar day under a server TZ east of UTC; callers reject an
// unsupported format up front rather than silently importing zero rows.
export const SUPPORTED_DATE_FORMATS = ['%Y-%m-%d', '%d/%m/%Y', '%m/%d/%Y', '%d-%m-%Y', '%Y-%m-%d %H:%M:%S'];

/**
 * Parse a date string against one of SUPPORTED_DATE_FORMATS into a UTC-midnight
 * Date. Unknown tokens fall back to parseDateFlexibleUtc.
 *
 * @param {string} dateStr
 * @param {string} fmt
 * @returns {Date|null}
 */
export function parseDateWithFormat(dateStr, fmt) {
  // Round-trip guard: Date.UTC silently rolls over out-of-range components
  // (Date.UTC(2024, 24, 12) → 2026-01-12 for a MM/DD file parsed as %d/%m/%Y),
  // and a 2-digit year like "24" becomes 1924. Reject instead of importing a
  // wrong day — matches parseDayMonthYear's validation.
  const build = (y, m, d) => {
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    if (y < 100) return null; // 2-digit-year misparse (e.g. "24" → 1924)
    const date = new Date(Date.UTC(y, m - 1, d));
    if (isNaN(date.getTime())) return null;
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
      return null;
    }
    return date;
  };
  if (fmt.includes('%d/%m/%Y')) {
    const [d, m, y] = dateStr.split('/').map((s) => parseInt(s, 10));
    return build(y, m, d);
  }
  if (fmt.includes('%m/%d/%Y')) {
    const [m, d, y] = dateStr.split('/').map((s) => parseInt(s, 10));
    return build(y, m, d);
  }
  if (fmt.includes('%d-%m-%Y')) {
    const [d, m, y] = dateStr.split('-').map((s) => parseInt(s, 10));
    return build(y, m, d);
  }
  if (fmt.includes('%Y-%m-%d')) {
    // Covers both '%Y-%m-%d' and '%Y-%m-%d %H:%M:%S' — parse the date part only,
    // as UTC, so an early-morning timestamp can't roll back a day.
    const [y, m, d] = dateStr.slice(0, 10).split('-').map((s) => parseInt(s, 10));
    return build(y, m, d);
  }
  // Unknown format token: shared parser rebuilds the parsed calendar day at
  // UTC midnight (plain new Date() was local → day-shift on serialization).
  return parseDateFlexibleUtc(dateStr);
}

export function parseCommaDecimal(value) {
  const s = String(value).replace(/\s/g, '');
  // EU format: comma is the decimal separator and dots are thousands separators.
  // "1.234,56" must become "1234.56" — the old code only swapped the comma,
  // leaving "1.234.56" which Decimal rejects (NaN), silently dropping the row.
  // Only strip dots when a comma is present so a dot-decimal "12.5" is untouched.
  if (s.includes(',')) {
    return parseDecimalSafe(s.replace(/\./g, '').replace(',', '.'));
  }
  return parseDecimalSafe(s);
}

/**
 * Robust amount parser that handles both EU (1.234,56) and US (1,234.56)
 * formats, currency symbols, parenthetical negatives, and leading sign.
 */
export function parseAmountField(raw) {
  let s = String(raw || '').trim();
  if (!s) return NaN;
  s = s.replace(/\s/g, '');
  s = s.replace(/[$€£¥]/g, '');
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    const tail = s.length - lastComma - 1;
    if (tail === 3 && s.indexOf(',') !== lastComma) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(',', '.');
    }
  }
  const n = parseDecimalSafe(s);
  if (isNaN(n)) return NaN;
  return negative ? -n : n;
}

const UTF8_BOM_RE = /^\uFEFF/;

export function splitCsvLines(content) {
  // Strip the UTF-8 BOM (U+FEFF) that Excel and several Windows tools
  // prepend to exported CSVs. Without this, the first header byte leaks
  // into the first field and breaks every column-name lookup downstream.
  return String(content).replace(UTF8_BOM_RE, '').split(/\r\n|\r|\n/);
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
 * @param {string} line - a single physical CSV line (no embedded newlines)
 * @param {string} [delimiter]
 * @returns {string[]|null}
 */
export function splitDelimitedRecord(line, delimiter = ';') {
  try {
    // relax_quotes: bank exports occasionally leave a stray quote mid-field;
    // treat it as literal text instead of failing the whole row.
    const rows = parse(line, { delimiter, relax_column_count: true, relax_quotes: true });
    return rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

export function buildOptionalComment(commentParts) {
  return commentParts.length ? commentParts.join(' | ') : null;
}

/**
 * Canonicalize an account identifier (IBAN/account number) for use as the
 * account label: strip all whitespace and uppercase, so the same account never
 * splits on spacing/case across imports or a manual entry (ADR-088). Empty in →
 * empty out (callers fall back to the bank literal). Belgian IBANs arrive
 * space-grouped (e.g. "BE81 0637 5694 4024") → "BE81063756944024".
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function canonicalIban(value) {
  if (!value) return '';
  return String(value).replace(/\s+/g, '').toUpperCase();
}

/**
 * @param {string} filePath
 * @param {object} options
 * @param {BufferEncoding} [encoding]
 */
export async function parseCsvFile(filePath, options, encoding = 'utf-8') {
  const content = await fs.promises.readFile(filePath, encoding);
  return parse(content, options);
}

export function buildRawRowString(row) {
  return Object.values(row).join('|');
}
