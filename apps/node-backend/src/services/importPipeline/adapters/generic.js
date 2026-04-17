/**
 * Generic (custom-config) CSV adapter. Used when the user provides their own
 * column mapping / date format / separator.
 */

import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildRawRowString } from './_shared.js';

const NAME = 'generic';
const BANK_LABEL = 'Generic';

function parseDate(dateStr, fmt) {
  if (fmt.includes('%d/%m/%Y') || fmt === '%d/%m/%Y') {
    const p = dateStr.split('/');
    return new Date(`${p[2]}-${p[1]}-${p[0]}`);
  }
  if (fmt.includes('%m/%d/%Y') || fmt === '%m/%d/%Y') {
    const p = dateStr.split('/');
    return new Date(`${p[2]}-${p[0]}-${p[1]}`);
  }
  return new Date(dateStr);
}

function parseAmountField(raw) {
  const amountStr = String(raw || '').replace(/[$€£,]/g, '').trim();
  let cleaned = amountStr;
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }
  return parseFloat(cleaned);
}

function buildBankAccount(config) {
  const bankName = config.bank_name || 'CUSTOM';
  const accountType = config.account_type;
  return accountType ? `${bankName} ${accountType.toUpperCase()}` : bankName;
}

function rowToTransaction(row, config) {
  const colMap = config.column_mapping;
  const dateStr = String(row[colMap.date] || '').trim();
  if (!dateStr) return null;

  const date = parseDate(dateStr, config.date_format || '');
  if (isNaN(date.getTime())) return null;

  const amount = parseAmountField(row[colMap.amount]);
  if (isNaN(amount)) return null;

  const recipient = String(row[colMap.recipient] || '').trim();
  const memo = colMap.memo ? String(row[colMap.memo] || '').trim() : '';

  let currency = null;
  if (colMap.currency) currency = String(row[colMap.currency] || '').trim() || null;

  let balance = null;
  if (colMap.balance) {
    const bv = parseFloat(String(row[colMap.balance] || ''));
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

export function parseWithConfig(filePath, config) {
  const records = parseCsvFile(
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

  const transactions = [];
  for (const row of records) {
    try {
      const tx = rowToTransaction(row, config);
      if (tx) transactions.push(tx);
    } catch {
      continue;
    }
  }

  logger.info(`Generic CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

export function detect() {
  // Generic adapter is the fallback; never auto-detected.
  return false;
}

export function parse(filePath, config) {
  if (!config) {
    throw new Error('Generic adapter requires a customConfig');
  }
  return parseWithConfig(filePath, config);
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse, parseWithConfig };
