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

/**
 * One raw row as this adapter extracts it — field names are the staging
 * columns' camelCase equivalents, and every numeric is stored as an ABSOLUTE
 * magnitude (direction is carried by the later-normalized type).
 *
 * @typedef {object} ParsedPortfolioRow
 * @property {Date} date UTC-midnight (see parseDateWithFormat).
 * @property {string} typeRaw the CSV's own type label; '' when unmapped.
 * @property {string} symbolRaw
 * @property {string} nameRaw
 * @property {number|null} units
 * @property {number|null} pricePerUnit
 * @property {number|null} amount
 * @property {number|null} fees
 * @property {number|null} taxes
 * @property {string|null} currency
 * @property {number|null} fxRateToEur
 * @property {string} note
 * @property {string} rawData source record, kept for dedup + provenance.
 */

/**
 * A parsed row list carrying the adapter's count of rows it could not
 * interpret (the counter rides on the array, matching the transaction
 * adapters' contract).
 *
 * @typedef {ParsedPortfolioRow[] & { skipped?: number }} ParsedPortfolioRows
 */

/**
 * The custom-parser definition a portfolio import runs on. It comes from the
 * upload route or a saved `custom_parser_configs.config_json` row and is not
 * re-validated here, so everything beyond `column_mapping` is optional.
 *
 * @typedef {object} PortfolioParserConfig
 * @property {string} [date_format] must be one of SUPPORTED_DATE_FORMATS
 * @property {string} [separator] CSV delimiter; defaults to ','
 * @property {number} [skip_rows]
 * @property {BufferEncoding} [encoding] defaults to 'utf-8'
 * @property {Record<string, string>} [type_mapping] raw type label → canonical portfolio_txn_type (read by validate.js)
 * @property {{ date?: string, type?: string, symbol?: string, name?: string, units?: string, price?: string, amount?: string, fees?: string, taxes?: string, currency?: string, fx_rate?: string, note?: string }} [column_mapping] source column NAMES, not indices
 */

/**
 * Absolute magnitude of a numeric cell, or null when blank/unparseable.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseMagnitude(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseAmountField(raw);
  if (isNaN(n)) return null;
  return Math.abs(n);
}

/**
 * @param {Record<string, string>} row a `columns: true` csv-parse record
 * @param {string|undefined} key the mapped source column name; '' when unmapped
 * @returns {string} trimmed cell value, '' when the column is unmapped or absent
 */
function cell(row, key) {
  if (!key) return '';
  return String(row[key] ?? '').trim();
}

/**
 * @param {Record<string, string>} row a `columns: true` csv-parse record
 * @param {PortfolioParserConfig} config
 * @returns {ParsedPortfolioRow|null} null when the mapped date cell is missing or unparseable
 */
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

/**
 * @param {string} filePath
 * @param {PortfolioParserConfig} config
 * @returns {Promise<ParsedPortfolioRows>}
 * @throws {Error} when `date_format` is not one of SUPPORTED_DATE_FORMATS
 */
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

  const rows = /** @type {ParsedPortfolioRows} */ ([]);
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
