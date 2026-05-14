/**
 * Revolut CSV adapter — english headers, comma-separated, COMPLETED-only rows.
 */

import { cleanRecipientName, normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildOptionalComment, parseDecimalSafe } from './_shared.js';

const NAME = 'revolut';
const BANK_LABEL = 'Revolut';
const MIN_FIELDS = 10;

function parseRevolutDate(completedDateStr) {
  for (const fmt of [
    /^(\d{4})-(\d{2})-(\d{2})\s/,
    /^(\d{4})-(\d{2})-(\d{2})$/,
  ]) {
    const m = completedDateStr.match(fmt);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}`);
  }
  const generic = new Date(completedDateStr);
  return isNaN(generic.getTime()) ? null : generic;
}

function buildBankAccount(product) {
  const upper = (product || '').toUpperCase();
  if (upper === 'SAVINGS') return 'REVOLUT SAVINGS';
  if (upper === 'CURRENT') return 'REVOLUT CURRENT';
  return `REVOLUT ${upper}`.trim();
}

function buildNormalizedRawData(parts, normalizedDate) {
  const normalized = [...parts];
  normalized[2] = normalizedDate;
  normalized[3] = normalizedDate;
  return normalized
    .map((f) => (f.includes(',') ? `"${f}"` : f))
    .join(',');
}

function parseRow(parts) {
  if (parts.length < MIN_FIELDS) return null;

  const transactionType = parts[0].trim();
  const product = parts[1].trim();
  const completedDateStr = parts[3].trim();
  const description = parts[4].trim();
  const amountStr = parts[5].trim();
  const feeStr = parts[6].trim();
  const currency = parts[7].trim();
  const state = parts[8].trim();
  const balanceStr = parts[9].trim();

  if (state.toUpperCase() !== 'COMPLETED') return null;
  if (!completedDateStr) return null;

  const date = parseRevolutDate(completedDateStr);
  if (!date) return null;

  const amount = parseDecimalSafe(amountStr);
  if (isNaN(amount)) return null;

  const fee = parseDecimalSafe(feeStr) || 0;
  const balance = balanceStr ? parseDecimalSafe(balanceStr) : null;

  const cleanedDescription = normalizeToUppercase(cleanRecipientName(description));
  const memo = normalizeToUppercase(`${transactionType} - ${product}`);

  const commentParts = [];
  if (transactionType) commentParts.push(`Type: ${transactionType}`);
  if (product) commentParts.push(`Product: ${product}`);
  if (fee > 0) commentParts.push(`Fee: ${fee.toFixed(2)} ${currency}`);
  if (state) commentParts.push(`State: ${state}`);

  const normalizedDate = date.toISOString().split('T')[0];
  const rawData = buildNormalizedRawData(parts, normalizedDate);

  return {
    date,
    bankAccount: buildBankAccount(product),
    recipient: cleanedDescription,
    memo,
    amount,
    currency,
    balance: balance !== null && !isNaN(balance) ? balance : null,
    recipientAccount: null,
    recipientAddress: null,
    recipientBankName: null,
    comment: buildOptionalComment(commentParts),
    rawData,
  };
}

export function detect(csvSample) {
  if (!csvSample) return false;
  const firstLine = csvSample.split('\n')[0] || '';
  const lower = firstLine.toLowerCase();
  return lower.startsWith('type,') && lower.includes('completed date') && lower.includes('state');
}

export async function parse(filePath) {
  const records = await parseCsvFile(filePath, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  const transactions = [];

  for (let i = 0; i < records.length; i++) {
    const parts = records[i];
    if (i === 0 && parts[0] && parts[0].trim() === 'Type') continue;
    const tx = parseRow(parts);
    if (tx) transactions.push(tx);
  }

  logger.info(`Revolut CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
