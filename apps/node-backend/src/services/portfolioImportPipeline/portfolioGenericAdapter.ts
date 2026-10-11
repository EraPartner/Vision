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

import { z } from "zod";
import { logger } from "../../config/logger.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";
import { checkDataContract } from "../../lib/dataContract.ts";
import {
  isUtcMidnight,
  parseCsvFile,
  rawDataForCsvRecord,
  parseCustomAmount,
  normalizeCsvNumberFormat,
  SUPPORTED_DATE_FORMATS,
  parseDateWithFormat,
} from "../importPipeline/adapters/_shared.ts";
import { parseIbkrTransactionHistory } from "./ibkrTransactionHistoryAdapter.ts";
import { parseIbkrFundingHistory } from "./ibkrFundingHistoryAdapter.ts";
import { parseKinesisTransactionHistory } from "./kinesisTransactionHistoryAdapter.ts";
import { parseNexoTransactionHistory } from "./nexoTransactionHistoryAdapter.ts";
import { parseNexoProSpotHistory } from "./nexoProTransactionHistoryAdapter.ts";
import { parseSaxoTransactionHistory } from "./saxoTransactionHistoryAdapter.ts";
import { verifyKinesisNetworkReceipt } from "../portfolioKinesisNetworkProof.ts";
import { parsedDateToYmd } from "../../lib/importDates.ts";
import type { KinesisNetworkReceipt } from "../portfolioKinesisNetworkProof.ts";
import type { IbkrSourceContext } from "../portfolioIbkrPrimaryProof.ts";
import type { IbkrFundingSourceContext } from "./ibkrFundingHistoryAdapter.ts";

/**
 * One raw row as this adapter extracts it — field names are the staging
 * columns' camelCase equivalents, and every numeric is stored as an ABSOLUTE
 * magnitude (direction is carried by the later-normalized type).
 */
export interface ParsedPortfolioRow {
  /**
   * UTC-midnight (see parseDateWithFormat). null when the source date cell
   * could not be parsed; validate then rejects the staged row as "missing date".
   */
  date: Date | null;
  /** the CSV's own type label; '' when unmapped. */
  typeRaw: string;
  symbolRaw: string;
  nameRaw: string;
  units: number | null;
  pricePerUnit: number | null;
  amount: number | null;
  fees: number | null;
  taxes: number | null;
  currency: string | null;
  fxRateToEur: number | null;
  note: string;
  /** source record, kept for dedup + provenance. */
  rawData: string;
  sourceAccountIdentity?: string | null;
  sourceId?: string | null;
  assetTransfer?: {
    direction: "in" | "out" | "internal";
    basisStatus: "carried" | "unresolved" | "not_applicable";
    feeUnits?: string;
    receivedUnits?: string;
    networkReceipt?: unknown;
  };
  assetAdjustment?: {
    kind: "yield_acquisition" | "yield_reversal" | "asset_fee";
    basisPolicy: "zero" | "zero_yield_only" | "carried";
    accountId?: number;
    eligibleSourceRecordHashes?: string[];
    networkReceipt?: unknown;
  };
}

const nullableNumber = z.number().nullable();

/**
 * Runtime contract for {@link ParsedPortfolioRow} as every portfolio format
 * returns it (ADR-193), checked once in {@link parseWithConfig}. A null date
 * is part of the contract (validate rejects it as a row error); NaN, a
 * non-midnight date or an unknown key is an adapter bug.
 */
export const parsedPortfolioRowSchema = z.strictObject({
  date: z
    .date()
    .refine(isUtcMidnight, "expected a UTC-midnight date")
    .nullable(),
  typeRaw: z.string(),
  symbolRaw: z.string(),
  nameRaw: z.string(),
  units: nullableNumber,
  pricePerUnit: nullableNumber,
  amount: nullableNumber,
  fees: nullableNumber,
  taxes: nullableNumber,
  currency: z.string().nullable(),
  fxRateToEur: nullableNumber,
  note: z.string(),
  rawData: z.string(),
  sourceAccountIdentity: z.string().nullable().optional(),
  sourceId: z.string().nullable().optional(),
  assetTransfer: z
    .strictObject({
      direction: z.enum(["in", "out", "internal"]),
      basisStatus: z.enum(["carried", "unresolved", "not_applicable"]),
      feeUnits: z.string().optional(),
      receivedUnits: z.string().optional(),
      networkReceipt: z.unknown().optional(),
    })
    .optional(),
  assetAdjustment: z
    .strictObject({
      kind: z.enum(["yield_acquisition", "yield_reversal", "asset_fee"]),
      basisPolicy: z.enum(["zero", "zero_yield_only", "carried"]),
      accountId: z.number().int().positive().optional(),
      eligibleSourceRecordHashes: z.array(z.string()).optional(),
      networkReceipt: z.unknown().optional(),
    })
    .optional(),
}) satisfies z.ZodType<ParsedPortfolioRow>;

/** A format's whole result: the rows plus the counters riding on the array. */
export const parsedPortfolioRowsSchema = z.object({
  rows: z.array(parsedPortfolioRowSchema),
  skipped: z.number().int().nonnegative().optional(),
  sourceColumns: z.array(z.string()).optional(),
});

/**
 * A parsed row list carrying the adapter's count of rows it could not
 * interpret (the counter rides on the array, matching the transaction
 * adapters' contract).
 */
export type ParsedPortfolioRows = ParsedPortfolioRow[] & {
  skipped?: number;
  sourceColumns?: string[];
  /** literal statement context the IBKR adapter attaches for primary proof */
  ibkrSourceContext?: IbkrSourceContext;
  /** retained workbook context the IBKR funding adapter attaches */
  ibkrFundingSourceContext?: IbkrFundingSourceContext;
};

/**
 * The custom-parser definition a portfolio import runs on. It comes from the
 * upload route or a saved `custom_parser_configs.config_json` row. The generic
 * path validates the date format and numeric convention, and the shared
 * decoder validates encoding. Other fields beyond `column_mapping` are optional.
 */
export interface PortfolioParserConfig {
  /** must be one of SUPPORTED_DATE_FORMATS */
  date_format?: string;
  /** CSV delimiter; defaults to ',' */
  separator?: string;
  skip_rows?: number;
  /** defaults to 'utf-8'; validated by the shared CSV decoder */
  encoding?: string;
  /**
   * 'auto' | 'decimal_dot' | 'decimal_comma', validated by
   * normalizeCsvNumberFormat; defaults to auto; ambiguous auto cells reject
   * the import
   */
  number_format?: string;
  /** raw type label → canonical portfolio_txn_type (read by validate.js) */
  type_mapping?: Record<string, string>;
  /** specialized statement format */
  format?:
    | "ibkr_transaction_history"
    | "ibkr_funding_history"
    | "kinesis_transaction_history"
    | "nexo_transaction_history"
    | "nexo_pro_spot_history"
    | "saxo_transaction_history";
  /** destination resolved from import custody intent */
  transfer_destination_account_id?: number;
  /** origin resolved from import custody intent */
  transfer_origin_account_id?: number;
  /** explicit asset scope; unselected source records remain outside this batch */
  included_symbols?: string[];
  /** explicit known-zero yield basis interpretation */
  yield_basis_policy?: "zero";
  /** source column NAMES, not indices */
  column_mapping?: {
    date?: string;
    type?: string;
    symbol?: string;
    name?: string;
    units?: string;
    price?: string;
    amount?: string;
    fees?: string;
    taxes?: string;
    currency?: string;
    fx_rate?: string;
    note?: string;
    source_account?: string;
    source_id?: string;
  };
}

/**
 * Absolute magnitude of a numeric cell, or null when blank/unparseable.
 */
function parseMagnitude(
  raw: unknown,
  numberFormat: unknown,
  context: { rowNumber: number; column: string },
): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return null;
  const n = parseCustomAmount(raw, numberFormat, context);
  if (isNaN(n)) return null;
  return Math.abs(n);
}

/**
 * @param row a `columns: true` csv-parse record
 * @param key the mapped source column name; '' when unmapped
 * @returns trimmed cell value, '' when the column is unmapped or absent
 */
function cell(row: Record<string, string>, key: string | undefined): string {
  if (!key) return "";
  return String(row[key] ?? "").trim();
}

/**
 * @param row a `columns: true` csv-parse record
 * @param rowNumber data-row ordinal, excluding metadata and the header
 * @returns null when the mapped date cell is missing or unparseable
 */
function rowToParsed(
  row: Record<string, string>,
  config: PortfolioParserConfig,
  rowNumber: number,
): ParsedPortfolioRow | null {
  const colMap = config.column_mapping || {};
  const dateStr = cell(row, colMap.date);
  if (!dateStr) return null;
  const date = parseDateWithFormat(dateStr, config.date_format || "");
  if (!date || isNaN(date.getTime())) return null;

  function magnitude(key: string | undefined) {
    return key
      ? parseMagnitude(row[key], config.number_format, {
          rowNumber,
          column: key,
        })
      : null;
  }
  const currency = colMap.currency ? cell(row, colMap.currency) || null : null;
  const fxRaw = magnitude(colMap.fx_rate);

  const parsed: ParsedPortfolioRow = {
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
      const receiptJson = row.Receipt_JSON;
      // An absent cell fails like unparseable JSON (reported below).
      if (receiptJson === undefined) throw new Error("missing receipt");
      const receipt = JSON.parse(receiptJson) as KinesisNetworkReceipt;
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
 * Parse with the config's format (or the generic column mapping) and check
 * the result against {@link parsedPortfolioRowsSchema}. Formats turn rows they
 * cannot read into `skipped`, so a contract break is an adapter bug and
 * follows data-contract mode (lib/dataContract.ts).
 *
 * @throws {Error} when `date_format` is not one of SUPPORTED_DATE_FORMATS
 */
export async function parseWithConfig(
  filePath: string,
  config: PortfolioParserConfig,
): Promise<ParsedPortfolioRows> {
  const rows = await parseFormat(filePath, config);
  checkDataContract(
    parsedPortfolioRowsSchema,
    { rows, skipped: rows.skipped, sourceColumns: rows.sourceColumns },
    `portfolio adapter "${config.format ?? "portfolio_generic"}" output`,
  );
  return rows;
}

async function parseFormat(
  filePath: string,
  config: PortfolioParserConfig,
): Promise<ParsedPortfolioRows> {
  if (config.format === "ibkr_funding_history") {
    return parseIbkrFundingHistory(filePath);
  }
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

  const rows: ParsedPortfolioRows = [];
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
