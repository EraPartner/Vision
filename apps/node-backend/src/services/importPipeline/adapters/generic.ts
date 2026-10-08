/**
 * Generic (custom-config) CSV adapter. Used when the user provides their own
 * column mapping / date format / separator.
 */

import { logger } from "../../../config/logger.ts";
import { normalizeToUppercase } from "../../../lib/textNormalization.ts";
import { ValidationError } from "../../../middleware/errorHandler.ts";
import {
  parseCsvFile,
  rawDataForCsvRecord,
  parseCustomAmount,
  normalizeCsvNumberFormat,
  SUPPORTED_DATE_FORMATS,
  parseDateWithFormat,
  normalizeIsoCurrency,
} from "./_shared.ts";
import type {
  CsvNumberFormat,
  ParsedBankTransaction,
  ParsedBankTransactions,
} from "./_shared.ts";

/**
 * The custom-parser definition a `generic` import runs on.
 *
 * It arrives either from POST /api/import/csv (which builds it from form
 * fields, so only bank_name/date_format and the date/recipient/amount column
 * names are guaranteed) or from a saved `custom_parser_configs.config_json`
 * row, which is free-form JSONB. The adapter validates the date format and
 * numeric convention, and the shared decoder validates encoding. Other fields
 * beyond `column_mapping` remain optional.
 */
export interface CustomTransactionParserConfig {
  /** defaults to 'CUSTOM' */
  bank_name?: string;
  /** appended to the bank name to form the ADR-088 account label */
  account_type?: string;
  /** must be one of SUPPORTED_DATE_FORMATS */
  date_format?: string;
  /** CSV delimiter; defaults to ',' */
  separator?: string;
  /** leading rows to drop before the header */
  skip_rows?: number;
  /** defaults to 'utf-8'; validated by the shared CSV decoder */
  encoding?: string;
  /** defaults to auto; ambiguous auto cells reject the import */
  number_format?: CsvNumberFormat;
  /** source column NAMES, not indices */
  column_mapping: {
    date: string;
    recipient: string;
    amount: string;
    memo?: string;
    currency?: string;
    balance?: string;
    source_id?: string;
  };
}

const NAME = "generic";
const BANK_LABEL = "Generic";

// Normalize to UPPER+trim so the custom/generic adapter matches every built-in adapter and the
// manual-entry path (transactionRepository.create uppercases bank_account) — otherwise the same
// bank reached two ways resolves to two different accounts (ADR-088 account identity).
function buildBankAccount(config: CustomTransactionParserConfig): string {
  const bankName = config.bank_name || "CUSTOM";
  const accountType = config.account_type;
  const label = accountType
    ? `${bankName} ${accountType.toUpperCase()}`
    : bankName;
  return normalizeToUppercase(label);
}

/**
 * @param row a `columns: true` csv-parse record
 * @param rowNumber data-row ordinal, excluding metadata and the header
 * @returns null when the mapped date or amount is unusable
 */
function rowToTransaction(
  row: Record<string, string>,
  config: CustomTransactionParserConfig,
  rowNumber: number,
): ParsedBankTransaction | null {
  const colMap = config.column_mapping;
  const dateStr = String(row[colMap.date] || "").trim();
  if (!dateStr) return null;

  const date = parseDateWithFormat(dateStr, config.date_format || "");
  if (!date || isNaN(date.getTime())) return null;

  const amount = parseCustomAmount(row[colMap.amount], config.number_format, {
    rowNumber,
    column: colMap.amount,
  });
  if (isNaN(amount)) return null;

  const recipient = String(row[colMap.recipient] || "").trim();
  const memo = colMap.memo ? String(row[colMap.memo] || "").trim() : "";

  // ISO-shape normalize (uppercase) or null → commit's EUR default; a raw
  // free-text cell failed the whole commit at the 0046 currency CHECK (500).
  let currency = null;
  if (colMap.currency) currency = normalizeIsoCurrency(row[colMap.currency]);

  let balance = null;
  if (colMap.balance) {
    const bv = parseCustomAmount(row[colMap.balance], config.number_format, {
      rowNumber,
      column: colMap.balance,
    });
    if (!isNaN(bv)) balance = bv;
  }

  return {
    date,
    bankAccount: buildBankAccount(config),
    recipient,
    memo,
    amount,
    currency,
    balance,
    recipientAccount: null,
    recipientAddress: null,
    recipientBankName: null,
    comment: null,
    rawData: rawDataForCsvRecord(row),
    sourceId: colMap.source_id
      ? String(row[colMap.source_id] || "").trim() || null
      : null,
  };
}

/**
 * @throws {Error} when `date_format` is not one of SUPPORTED_DATE_FORMATS
 */
export async function parseWithConfig(
  filePath: string,
  config: CustomTransactionParserConfig,
): Promise<ParsedBankTransactions> {
  normalizeCsvNumberFormat(config.number_format);
  const dateFormat = config.date_format || "";
  if (!SUPPORTED_DATE_FORMATS.includes(dateFormat)) {
    // Fail fast and loudly: a chosen-but-unimplemented format previously fell
    // through to `new Date(string)`, producing Invalid Date for every row and a
    // silent zero-row "successful" import.
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

  const transactions: ParsedBankTransactions = [];
  let skipped = 0;
  for (const [index, row] of records.entries()) {
    try {
      const tx = rowToTransaction(row, config, index + 1);
      if (tx) transactions.push(tx);
      else skipped++;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      skipped++;
    }
  }

  // Surface unparseable rows instead of silently dropping them (an all-rows-
  // skipped import otherwise "succeeds" with 0 transactions and no signal).
  transactions.skipped = skipped;
  logger.info(
    `Generic CSV parsed: ${transactions.length} transactions, ${skipped} skipped`,
  );
  return transactions;
}

/**
 * @returns always false — the generic adapter is the explicit fallback
 */
export function detect(): boolean {
  // Generic adapter is the fallback; never auto-detected.
  return false;
}

/**
 * @param config required — the generic adapter has no built-in mapping
 */
export async function parse(
  filePath: string,
  config?: CustomTransactionParserConfig,
): Promise<ParsedBankTransactions> {
  if (!config) {
    throw new Error("Generic adapter requires a customConfig");
  }
  return parseWithConfig(filePath, config);
}

export default {
  name: NAME,
  bankName: BANK_LABEL,
  detect,
  parse,
  parseWithConfig,
};
