/**
 * Wise CSV adapter — multi-currency transfer history.
 */

import { cleanRecipientName, normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildOptionalComment, buildRawRowString } from './_shared.js';

const NAME = 'wise';
const BANK_LABEL = 'Wise';

function resolveAmount(amountStr, direction) {
  const parsed = parseFloat(amountStr);
  if (isNaN(parsed)) return null;
  if (direction === 'OUT') return -Math.abs(parsed);
  if (direction === 'IN') return Math.abs(parsed);
  return parsed;
}

function buildWiseComment(row, direction, sourceAmountStr, targetAmountStr, sourceCurrency, targetCurrency) {
  const sourceFee = (row['Source fee amount'] || '').trim();
  const sourceFeeCurrency = (row['Source fee currency'] || '').trim();
  const exchangeRate = (row['Exchange rate'] || '').trim();
  const transactionId = (row['ID'] || '').trim();
  const batch = (row['Batch'] || '').trim();

  const commentParts = [];
  if (transactionId) commentParts.push(`ID: ${transactionId}`);
  if (direction) commentParts.push(`Direction: ${direction}`);
  if (sourceFee && parseFloat(sourceFee) > 0) commentParts.push(`Fee: ${sourceFee} ${sourceFeeCurrency}`);
  if (exchangeRate && parseFloat(exchangeRate) > 0) commentParts.push(`Rate: ${exchangeRate}`);
  if (sourceCurrency !== targetCurrency && sourceCurrency && targetCurrency) {
    commentParts.push(`${sourceAmountStr} ${sourceCurrency} → ${targetAmountStr} ${targetCurrency}`);
  }
  if (batch) commentParts.push(`Batch: ${batch}`);
  return buildOptionalComment(commentParts);
}

function rowToTransaction(row) {
  const status = (row['Status'] || '').trim().toUpperCase();
  if (status !== 'COMPLETED') return null;

  const dateStr = (row['Finished on'] || row['Created on'] || '').trim();
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;

  const direction = (row['Direction'] || '').trim().toUpperCase();

  const targetAmountStr = (row['Target amount (after fees)'] || '').trim();
  const sourceAmountStr = (row['Source amount (after fees)'] || '').trim();
  const amountStr = targetAmountStr || sourceAmountStr;
  if (!amountStr) return null;
  const amount = resolveAmount(amountStr, direction);
  if (amount === null) return null;

  const targetCurrency = (row['Target currency'] || '').trim().toUpperCase();
  const sourceCurrency = (row['Source currency'] || '').trim().toUpperCase();
  const currency = targetCurrency || sourceCurrency || 'USD';

  const targetName = (row['Target name'] || '').trim();
  const sourceName = (row['Source name'] || '').trim();
  const recipientRaw = direction === 'IN' ? (sourceName || targetName) : (targetName || sourceName);
  const recipient = recipientRaw ? normalizeToUppercase(cleanRecipientName(recipientRaw)) : 'UNKNOWN';

  const reference = (row['Reference'] || '').trim();
  const category = (row['Category'] || '').trim();
  const note = (row['Note'] || '').trim();
  const memo = normalizeToUppercase([reference, category, note].filter(Boolean).join(' - ') || 'WISE TRANSFER');

  return {
    date,
    bankAccount: `WISE ${currency}`,
    recipient,
    memo,
    amount,
    currency,
    balance: null,
    recipientAccount: null,
    recipientAddress: null,
    recipientBankName: null,
    comment: buildWiseComment(row, direction, sourceAmountStr, targetAmountStr, sourceCurrency, targetCurrency),
    rawData: buildRawRowString(row),
  };
}

export function detect(csvSample) {
  if (!csvSample) return false;
  const firstLine = (csvSample.split('\n')[0] || '').toLowerCase();
  return firstLine.includes('direction')
    && firstLine.includes('target amount')
    && firstLine.includes('source amount');
}

export function parse(filePath) {
  const records = parseCsvFile(filePath, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const transactions = [];
  for (const row of records) {
    try {
      const tx = rowToTransaction(row);
      if (tx) transactions.push(tx);
    } catch {
      continue;
    }
  }

  logger.info(`Wise CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
