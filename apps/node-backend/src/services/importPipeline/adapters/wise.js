/**
 * Wise CSV adapter — multi-currency transfer history.
 */

import { cleanRecipientName, normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildOptionalComment, buildRawRowString, parseAmountField, parseDateFlexibleUtc } from './_shared.js';

const NAME = 'wise';
const BANK_LABEL = 'Wise';

function resolveAmount(amountStr, direction) {
  const parsed = parseAmountField(amountStr);
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
  // Wise exports "YYYY-MM-DD HH:MM:SS"; parseDateFlexibleUtc reads the ISO date
  // part as UTC and rebuilds any other shape at UTC midnight so toISOString in
  // stage/dedup can't shift the day.
  const date = parseDateFlexibleUtc(dateStr);
  if (!date) return null;

  const direction = (row['Direction'] || '').trim().toUpperCase();

  const targetAmountStr = (row['Target amount (after fees)'] || '').trim();
  const sourceAmountStr = (row['Source amount (after fees)'] || '').trim();
  const targetCurrency = (row['Target currency'] || '').trim().toUpperCase();
  const sourceCurrency = (row['Source currency'] || '').trim().toUpperCase();

  // The transfer always has a source side and a target side. For an OUT
  // transfer YOUR account is the source (you send 100 EUR → recipient gets
  // 108 USD), so book the source amount/currency; for IN your account is the
  // target. Booking the recipient's side put the wrong amount on the wrong
  // per-account balance. Fall back to the other side when the preferred one is
  // blank (same-currency transfers populate both identically).
  const preferSource = direction === 'OUT';
  const amountStr = preferSource
    ? (sourceAmountStr || targetAmountStr)
    : (targetAmountStr || sourceAmountStr);
  if (!amountStr) return null;
  const amount = resolveAmount(amountStr, direction);
  if (amount === null) return null;

  const currency =
    (preferSource ? (sourceCurrency || targetCurrency) : (targetCurrency || sourceCurrency)) || 'USD';

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

export async function parse(filePath) {
  const records = await parseCsvFile(filePath, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const transactions = [];
  let skipped = 0;
  for (const row of records) {
    try {
      const tx = rowToTransaction(row);
      if (tx) transactions.push(tx);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  transactions.skipped = skipped;

  logger.info(`Wise CSV parsed: ${transactions.length} transactions, ${skipped} skipped`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
