/**
 * Generic (custom-config) CSV adapter. Used when the user provides their own
 * column mapping / date format / separator.
 */

import { logger } from '../../../config/logger.js';
import { normalizeToUppercase } from '../../../lib/textNormalization.js';
import { parseCsvFile, buildRawRowString, parseAmountField, SUPPORTED_DATE_FORMATS, parseDateWithFormat, normalizeIsoCurrency } from './_shared.js';

/**
 * @typedef {import('./_shared.js').ParsedBankTransaction} ParsedBankTransaction
 * @typedef {import('./_shared.js').ParsedBankTransactions} ParsedBankTransactions
 */

/**
 * The custom-parser definition a `generic` import runs on.
 *
 * It arrives either from POST /api/import/csv (which builds it from form
 * fields, so only bank_name/date_format and the date/recipient/amount column
 * names are guaranteed) or from a saved `custom_parser_configs.config_json`
 * row, which is free-form JSONB. Nothing re-validates it here, so every field
 * beyond `column_mapping` is optional.
 *
 * @typedef {object} CustomTransactionParserConfig
 * @property {string} [bank_name] defaults to 'CUSTOM'
 * @property {string} [account_type] appended to the bank name to form the ADR-088 account label
 * @property {string} [date_format] must be one of SUPPORTED_DATE_FORMATS
 * @property {string} [separator] CSV delimiter; defaults to ','
 * @property {number} [skip_rows] leading rows to drop before the header
 * @property {BufferEncoding} [encoding] defaults to 'utf-8'
 * @property {{ date: string, recipient: string, amount: string, memo?: string, currency?: string, balance?: string }} column_mapping source column NAMES, not indices
 */

const NAME = 'generic';
const BANK_LABEL = 'Generic';

// Normalize to UPPER+trim so the custom/generic adapter matches every built-in adapter and the
// manual-entry path (transactionRepository.create uppercases bank_account) — otherwise the same
// bank reached two ways resolves to two different accounts (ADR-088 account identity).
/**
 * @param {CustomTransactionParserConfig} config
 * @returns {string}
 */
function buildBankAccount(config) {
  const bankName = config.bank_name || 'CUSTOM';
  const accountType = config.account_type;
  const label = accountType ? `${bankName} ${accountType.toUpperCase()}` : bankName;
  return normalizeToUppercase(label);
}

/**
 * @param {Record<string, string>} row a `columns: true` csv-parse record
 * @param {CustomTransactionParserConfig} config
 * @returns {ParsedBankTransaction|null} null when the mapped date or amount is unusable
 */
function rowToTransaction(row, config) {
  const colMap = config.column_mapping;
  const dateStr = String(row[colMap.date] || '').trim();
  if (!dateStr) return null;

  const date = parseDateWithFormat(dateStr, config.date_format || '');
  if (!date || isNaN(date.getTime())) return null;

  const amount = parseAmountField(row[colMap.amount]);
  if (isNaN(amount)) return null;

  const recipient = String(row[colMap.recipient] || '').trim();
  const memo = colMap.memo ? String(row[colMap.memo] || '').trim() : '';

  // ISO-shape normalize (uppercase) or null → commit's EUR default; a raw
  // free-text cell failed the whole commit at the 0046 currency CHECK (500).
  let currency = null;
  if (colMap.currency) currency = normalizeIsoCurrency(row[colMap.currency]);

  let balance = null;
  if (colMap.balance) {
    const bv = parseAmountField(row[colMap.balance]);
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
    rawData: buildRawRowString(row),
  };
}

/**
 * @param {string} filePath
 * @param {CustomTransactionParserConfig} config
 * @returns {Promise<ParsedBankTransactions>}
 * @throws {Error} when `date_format` is not one of SUPPORTED_DATE_FORMATS
 */
export async function parseWithConfig(filePath, config) {
  const dateFormat = config.date_format || '';
  if (!SUPPORTED_DATE_FORMATS.includes(dateFormat)) {
    // Fail fast and loudly: a chosen-but-unimplemented format previously fell
    // through to `new Date(string)`, producing Invalid Date for every row and a
    // silent zero-row "successful" import.
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

  const transactions = /** @type {ParsedBankTransactions} */ ([]);
  let skipped = 0;
  for (const row of records) {
    try {
      const tx = rowToTransaction(row, config);
      if (tx) transactions.push(tx);
      else skipped++;
    } catch {
      skipped++;
    }
  }

  // Surface unparseable rows instead of silently dropping them (an all-rows-
  // skipped import otherwise "succeeds" with 0 transactions and no signal).
  transactions.skipped = skipped;
  logger.info(`Generic CSV parsed: ${transactions.length} transactions, ${skipped} skipped`);
  return transactions;
}

/**
 * @returns {boolean} always false — the generic adapter is the explicit fallback
 */
export function detect() {
  // Generic adapter is the fallback; never auto-detected.
  return false;
}

/**
 * @param {string} filePath
 * @param {CustomTransactionParserConfig} [config] required — the generic adapter has no built-in mapping
 * @returns {Promise<ParsedBankTransactions>}
 */
export async function parse(filePath, config) {
  if (!config) {
    throw new Error('Generic adapter requires a customConfig');
  }
  return parseWithConfig(filePath, config);
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse, parseWithConfig };
