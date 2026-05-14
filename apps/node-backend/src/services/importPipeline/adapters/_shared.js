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

export function parseCommaDecimal(value) {
  return parseDecimalSafe(String(value).replace(/\s/g, '').replace(',', '.'));
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

export function buildOptionalComment(commentParts) {
  return commentParts.length ? commentParts.join(' | ') : null;
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
