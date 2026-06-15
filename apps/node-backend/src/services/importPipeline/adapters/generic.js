/**
 * Generic (custom-config) CSV adapter. Used when the user provides their own
 * column mapping / date format / separator.
 */

import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildRawRowString, parseAmountField, SUPPORTED_DATE_FORMATS, parseDateWithFormat } from './_shared.js';

const NAME = 'generic';
const BANK_LABEL = 'Generic';

function buildBankAccount(config) {
  const bankName = config.bank_name || 'CUSTOM';
  const accountType = config.account_type;
  return accountType ? `${bankName} ${accountType.toUpperCase()}` : bankName;
}

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

  let currency = null;
  if (colMap.currency) currency = String(row[colMap.currency] || '').trim() || null;

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

  const transactions = /** @type {any[] & { skipped?: number }} */ ([]);
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

export function detect() {
  // Generic adapter is the fallback; never auto-detected.
  return false;
}

export async function parse(filePath, config) {
  if (!config) {
    throw new Error('Generic adapter requires a customConfig');
  }
  return parseWithConfig(filePath, config);
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse, parseWithConfig };
