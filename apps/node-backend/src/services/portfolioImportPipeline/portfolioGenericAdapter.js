/**
 * Portfolio generic (custom-config) CSV adapter.
 *
 * Parses a brokerage/exchange CSV into raw staged rows using a user-supplied
 * column mapping. Type normalization, instrument matching, and validation
 * happen in later pipeline phases — this phase only extracts and shapes the
 * fields. Numeric magnitudes are stored absolute; transaction direction is
 * carried by the (later normalized) type, matching the portfolio repo which
 * requires positive amount/units/price for buy/sell.
 */

import { logger } from '../../config/logger.js';
import { parseCsvFile, buildRawRowString, parseAmountField, SUPPORTED_DATE_FORMATS, parseDateWithFormat } from '../importPipeline/adapters/_shared.js';

// Absolute magnitude of a numeric cell, or null when blank/unparseable.
function parseMagnitude(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseAmountField(raw);
  if (isNaN(n)) return null;
  return Math.abs(n);
}

function cell(row, key) {
  if (!key) return '';
  return String(row[key] ?? '').trim();
}

function rowToParsed(row, config) {
  const colMap = config.column_mapping || {};
  const dateStr = cell(row, colMap.date);
  if (!dateStr) return null;
  const date = parseDateWithFormat(dateStr, config.date_format || '');
  if (!date || isNaN(date.getTime())) return null;

  const currency = colMap.currency ? (cell(row, colMap.currency) || null) : null;
  const fxRaw = colMap.fx_rate ? parseMagnitude(row[colMap.fx_rate]) : null;

  return {
    date,
    typeRaw: cell(row, colMap.type),
    symbolRaw: cell(row, colMap.symbol),
    nameRaw: cell(row, colMap.name),
    units: colMap.units ? parseMagnitude(row[colMap.units]) : null,
    pricePerUnit: colMap.price ? parseMagnitude(row[colMap.price]) : null,
    amount: colMap.amount ? parseMagnitude(row[colMap.amount]) : null,
    fees: colMap.fees ? parseMagnitude(row[colMap.fees]) : null,
    taxes: colMap.taxes ? parseMagnitude(row[colMap.taxes]) : null,
    currency,
    fxRateToEur: fxRaw,
    note: colMap.note ? cell(row, colMap.note) : '',
    rawData: buildRawRowString(row),
  };
}

export async function parseWithConfig(filePath, config) {
  const dateFormat = config.date_format || '';
  if (!SUPPORTED_DATE_FORMATS.includes(dateFormat)) {
    throw new Error(
      `Unsupported date_format "${dateFormat}". Supported: ${SUPPORTED_DATE_FORMATS.join(', ')}`,
    );
  }

  const records = await parseCsvFile(
    filePath,
    {
      columns: true,
      skip_empty_lines: true,
      delimiter: config.separator || ',',
      from: (config.skip_rows || 0) + 1,
      relax_column_count: true,
    },
    config.encoding || 'utf-8',
  );

  const rows = /** @type {any[] & { skipped?: number }} */ ([]);
  let skipped = 0;
  for (const record of records) {
    try {
      const parsed = rowToParsed(record, config);
      if (parsed) rows.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }

  rows.skipped = skipped;
  logger.info(`Portfolio CSV parsed: ${rows.length} rows, ${skipped} skipped`);
  return rows;
}

export default { name: 'portfolio_generic', parseWithConfig };
