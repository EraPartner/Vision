/**
 * Shared helpers for bank CSV adapters.
 *
 * Pure utilities only — keep I/O to the CSV reader below. Everything here is
 * reused across multiple adapters; if a helper grows adapter-specific branches,
 * move it back into the adapter that needs it.
 */

import fs from 'fs';
import { parse } from 'csv-parse/sync';

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
  return parseFloat(String(value).replace(/\s/g, '').replace(',', '.'));
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
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return negative ? -n : n;
}

export function splitCsvLines(content) {
  return String(content).split(/\r\n|\r|\n/);
}

export function buildOptionalComment(commentParts) {
  return commentParts.length ? commentParts.join(' | ') : null;
}

export async function parseCsvFile(filePath, options, encoding = 'utf-8') {
  const content = await fs.promises.readFile(filePath, encoding);
  return parse(content, options);
}

export function buildRawRowString(row) {
  return Object.values(row).join('|');
}
