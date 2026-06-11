/**
 * Vision (self-import) CSV adapter — re-import Vision's own export format.
 */

import { cleanRecipientName, normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildOptionalComment, buildRawRowString, parseDecimalSafe } from './_shared.js';

const NAME = 'vision';
const BANK_LABEL = 'Vision';

function rowToTransaction(row) {
  const dateStr = (row['Date'] || '').trim();
  if (!dateStr) return null;

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;

  const amountStr = (row['Amount'] || '').replace(/[€$£,\s]/g, '').trim();
  const amount = parseDecimalSafe(amountStr);
  if (isNaN(amount)) return null;

  const bankAccount = normalizeToUppercase((row['Bank Account'] || 'VISION').trim());
  const recipientRaw = (row['Recipient'] || '').trim();
  const recipient = recipientRaw ? normalizeToUppercase(cleanRecipientName(recipientRaw)) : 'UNKNOWN';
  const memo = row['Memo'] ? normalizeToUppercase(row['Memo'].trim()) : '';
  const currency = (row['Currency'] || 'EUR').trim().toUpperCase();
  const balanceStr = (row['Balance'] || '').trim();
  const balance = balanceStr ? parseDecimalSafe(balanceStr) : null;
  const category = (row['Category'] || '').trim();
  const comment = (row['Comment'] || '').trim() || null;

  const commentParts = [];
  if (category) commentParts.push(`Imported Category: ${category}`);
  if (comment) commentParts.push(comment);

  return {
    date,
    bankAccount,
    recipient,
    memo,
    amount,
    currency,
    balance: balance !== null && !isNaN(balance) ? balance : null,
    recipientAccount: null,
    recipientAddress: null,
    recipientBankName: null,
    comment: buildOptionalComment(commentParts),
    rawData: buildRawRowString(row),
  };
}

export function detect(csvSample) {
  if (!csvSample) return false;
  const firstLine = (csvSample.split('\n')[0] || '').toLowerCase();
  return firstLine.includes('date')
    && firstLine.includes('amount')
    && firstLine.includes('bank account')
    && firstLine.includes('recipient');
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

  logger.info(`Vision CSV parsed: ${transactions.length} transactions, ${skipped} skipped`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
