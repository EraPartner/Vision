/**
 * Shared helpers for bank CSV adapters.
 *
 * Pure utilities only — keep I/O to the CSV reader below. Everything here is
 * reused across multiple adapters; if a helper grows adapter-specific branches,
 * move it back into the adapter that needs it.
 */

import fs from 'fs';
import { parse } from 'csv-parse/sync';

export function parseDayMonthYear(dateStr) {
  const dateParts = dateStr.split('/');
  if (dateParts.length !== 3) return null;

  const date = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`);
  return isNaN(date.getTime()) ? null : date;
}

export function parseCommaDecimal(value) {
  return parseFloat(String(value).replace(',', '.'));
}

export function buildOptionalComment(commentParts) {
  return commentParts.length ? commentParts.join(' | ') : null;
}

export function parseCsvFile(filePath, options, encoding = 'utf-8') {
  const content = fs.readFileSync(filePath, encoding);
  return parse(content, options);
}

export function buildRawRowString(row) {
  return Object.values(row).join('|');
}
