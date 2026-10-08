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

import { logger } from "../../config/logger.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";
import {
  parseCsvFile,
  rawDataForCsvRecord,
  parseCustomAmount,
  normalizeCsvNumberFormat,
  SUPPORTED_DATE_FORMATS,
  parseDateWithFormat,
} from "../importPipeline/adapters/_shared.js";
import { parseIbkrTransactionHistory } from "./ibkrTransactionHistoryAdapter.js";
import { parseKinesisTransactionHistory } from "./kinesisTransactionHistoryAdapter.js";
import { parseNexoTransactionHistory } from "./nexoTransactionHistoryAdapter.js";
import { parseNexoProSpotHistory } from "./nexoProTransactionHistoryAdapter.js";
import { parseSaxoTransactionHistory } from "./saxoTransactionHistoryAdapter.js";
import { verifyKinesisNetworkReceipt } from "../portfolioKinesisNetworkProof.js";
import { parsedDateToYmd } from "../../lib/importDates.ts";

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
 * @property {string|null} [sourceAccountIdentity]
 * @property {string|null} [sourceId]
 * @property {{ direction: 'in'|'out'|'internal', basisStatus: 'carried'|'unresolved'|'not_applicable', feeUnits?: string, receivedUnits?: string }} [assetTransfer]
 * @property {{ kind: 'yield_acquisition'|'yield_reversal'|'asset_fee', basisPolicy: 'zero'|'zero_yield_only'|'carried', accountId?: number, eligibleSourceRecordHashes?: string[] }} [assetAdjustment]
 */

/**
 * A parsed row list carrying the adapter's count of rows it could not
 * interpret (the counter rides on the array, matching the transaction
 * adapters' contract).
 *
 * @typedef {ParsedPortfolioRow[] & { skipped?: number, sourceColumns?: string[] }} ParsedPortfolioRows
 */

/**
 * The custom-parser definition a portfolio import runs on. It comes from the
 * upload route or a saved `custom_parser_configs.config_json` row. The generic
 * path validates the date format and numeric convention, and the shared
 * decoder validates encoding. Other fields beyond `column_mapping` are optional.
 *
 * @typedef {object} PortfolioParserConfig
 * @property {string} [date_format] must be one of SUPPORTED_DATE_FORMATS
 * @property {string} [separator] CSV delimiter; defaults to ','
 * @property {number} [skip_rows]
 * @property {string} [encoding] defaults to 'utf-8'; validated by the shared CSV decoder
 * @property {'auto'|'decimal_dot'|'decimal_comma'} [number_format] defaults to auto; ambiguous auto cells reject the import
 * @property {Record<string, string>} [type_mapping] raw type label → canonical portfolio_txn_type (read by validate.js)
 * @property {'ibkr_transaction_history'|'kinesis_transaction_history'|'nexo_transaction_history'|'nexo_pro_spot_history'|'saxo_transaction_history'} [format] specialized statement format
 * @property {number} [transfer_destination_account_id] destination resolved from import custody intent
 * @property {number} [transfer_origin_account_id] origin resolved from import custody intent
 * @property {string[]} [included_symbols] explicit asset scope; unselected source records remain outside this batch
 * @property {'zero'} [yield_basis_policy] explicit known-zero yield basis interpretation
 * @property {{ date?: string, type?: string, symbol?: string, name?: string, units?: string, price?: string, amount?: string, fees?: string, taxes?: string, currency?: string, fx_rate?: string, note?: string, source_account?: string, source_id?: string }} [column_mapping] source column NAMES, not indices
 */

/**
 * Absolute magnitude of a numeric cell, or null when blank/unparseable.
 *
 * @param {unknown} raw
 * @param {unknown} numberFormat
 * @param {{ rowNumber: number, column: string }} context
 * @returns {number|null}
 */
function parseMagnitude(raw, numberFormat, context) {
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return null;
  const n = parseCustomAmount(raw, numberFormat, context);
  if (isNaN(n)) return null;
  return Math.abs(n);
}

/**
 * @param {Record<string, string>} row a `columns: true` csv-parse record
 * @param {string|undefined} key the mapped source column name; '' when unmapped
 * @returns {string} trimmed cell value, '' when the column is unmapped or absent
 */
function cell(row, key) {
  if (!key) return "";
  return String(row[key] ?? "").trim();
}

/**
 * @param {Record<string, string>} row a `columns: true` csv-parse record
 * @param {PortfolioParserConfig} config
 * @param {number} rowNumber data-row ordinal, excluding metadata and the header
 * @returns {ParsedPortfolioRow|null} null when the mapped date cell is missing or unparseable
 */
function rowToParsed(row, config, rowNumber) {
  const colMap = config.column_mapping || {};
  const dateStr = cell(row, colMap.date);
  if (!dateStr) return null;
  const date = parseDateWithFormat(dateStr, config.date_format || "");
  if (!date || isNaN(date.getTime())) return null;

  /** @param {string|undefined} key */
  function magnitude(key) {
    return key
      ? parseMagnitude(row[key], config.number_format, {
          rowNumber,
          column: key,
        })
      : null;
  }
  const currency = colMap.currency ? cell(row, colMap.currency) || null : null;
  const fxRaw = magnitude(colMap.fx_rate);

  const parsed = {
    date,
    typeRaw: cell(row, colMap.type),
    symbolRaw: cell(row, colMap.symbol),
    nameRaw: cell(row, colMap.name),
    units: magnitude(colMap.units),
    pricePerUnit: magnitude(colMap.price),
    amount: magnitude(colMap.amount),
    fees: magnitude(colMap.fees),
    taxes: magnitude(colMap.taxes),
    currency,
    fxRateToEur: fxRaw,
    note: colMap.note ? cell(row, colMap.note) : "",
    rawData: rawDataForCsvRecord(row),
    sourceAccountIdentity: cell(row, colMap.source_account) || null,
    sourceId: cell(row, colMap.source_id) || null,
  };
  if (["asset_fee", "asset_transfer_witness"].includes(parsed.typeRaw)) {
    try {
      const receipt = JSON.parse(row.Receipt_JSON);
      const proof = verifyKinesisNetworkReceipt(receipt, parsed.typeRaw);
      if (
        parsed.currency !== proof.asset ||
        parsedDateToYmd(parsed.date) !== proof.date ||
        parsed.symbolRaw !== proof.asset ||
        parsed.sourceId !== proof.hash ||
        parsed.sourceAccountIdentity !== proof.sourceAddress ||
        Number(parsed.units) !== Number(proof.units) ||
        [
          parsed.amount,
          parsed.pricePerUnit,
          parsed.fees,
          parsed.taxes,
          parsed.fxRateToEur,
        ].some((value) => value != null && value !== 0)
      )
        throw new Error("network source fields");
      if (parsed.typeRaw === "asset_fee") {
        parsed.typeRaw = "AssetAdjustment";
        parsed.assetAdjustment = {
          kind: "asset_fee",
          basisPolicy: "carried",
          networkReceipt: receipt,
        };
      } else {
        parsed.typeRaw = "InternalMovement";
        parsed.assetTransfer = {
          direction: "internal",
          basisStatus: "not_applicable",
          networkReceipt: receipt,
        };
      }
    } catch {
      throw new ValidationError(
        "Native wallet receipt or mapped source fields could not be verified",
      );
    }
  }
  return parsed;
}

/**
 * @param {string} filePath
 * @param {PortfolioParserConfig} config
 * @returns {Promise<ParsedPortfolioRows>}
 * @throws {Error} when `date_format` is not one of SUPPORTED_DATE_FORMATS
 */
export async function parseWithConfig(filePath, config) {
  if (config.format === "ibkr_transaction_history") {
    return parseIbkrTransactionHistory(filePath, config);
  }
  if (config.format === "kinesis_transaction_history") {
    return parseKinesisTransactionHistory(filePath, config);
  }
  if (config.format === "nexo_transaction_history") {
    return parseNexoTransactionHistory(filePath, config);
  }
  if (config.format === "nexo_pro_spot_history") {
    return parseNexoProSpotHistory(filePath, config);
  }
  if (config.format === "saxo_transaction_history") {
    return parseSaxoTransactionHistory(filePath, config);
  }
  normalizeCsvNumberFormat(config.number_format);
  const dateFormat = config.date_format || "";
  if (!SUPPORTED_DATE_FORMATS.includes(dateFormat)) {
    throw new Error(
      `Unsupported date_format "${dateFormat}". Supported: ${SUPPORTED_DATE_FORMATS.join(", ")}`,
    );
  }

  const records = await parseCsvFile(
    filePath,
    {
      columns: true,
      skip_empty_lines: true,
      delimiter: config.separator || ",",
      from_line: (config.skip_rows || 0) + 1,
      relax_column_count: true,
    },
    config.encoding || "utf-8",
  );

  const rows = /** @type {ParsedPortfolioRows} */ ([]);
  let skipped = 0;
  for (const [index, record] of records.entries()) {
    try {
      const parsed = rowToParsed(record, config, index + 1);
      if (parsed) rows.push(parsed);
      else skipped++;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      skipped++;
    }
  }

  rows.skipped = skipped;
  rows.sourceColumns = Object.keys(records[0] ?? {});
  logger.info(`Portfolio CSV parsed: ${rows.length} rows, ${skipped} skipped`);
  return rows;
}

export default { name: "portfolio_generic", parseWithConfig };
