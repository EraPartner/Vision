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
