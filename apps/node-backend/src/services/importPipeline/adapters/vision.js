/**
 * Vision (self-import) CSV adapter — re-import Vision's own export format.
 */

import { cleanRecipientName, normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildOptionalComment, buildRawRowString, parseDecimalSafe, parseDateFlexibleUtc } from './_shared.js';

const NAME = 'vision';
const BANK_LABEL = 'Vision';

function rowToTransaction(row) {
  const dateStr = (row['Date'] || '').trim();
  if (!dateStr) return null;

  const date = parseDateFlexibleUtc(dateStr);
  if (!date) return null;

  // Strip a leading formula-guard apostrophe defensively: older Vision exports
  // prefixed numeric cells with "'" (e.g. "'-12.34"), which otherwise NaN-drops
  // the row. Current exports no longer do this, but round-tripping an old file
  // must still work.
  const amountStr = (row['Amount'] || '').replace(/^'/, '').replace(/[€$£,\s]/g, '').trim();
  const amount = parseDecimalSafe(amountStr);
  if (isNaN(amount)) return null;

  const bankAccount = normalizeToUppercase((row['Bank Account'] || 'VISION').trim());
  const recipientRaw = (row['Recipient'] || '').trim();
  const recipient = recipientRaw ? normalizeToUppercase(cleanRecipientName(recipientRaw)) : 'UNKNOWN';
  const memo = row['Memo'] ? normalizeToUppercase(row['Memo'].trim()) : '';
  const currency = (row['Currency'] || 'EUR').trim().toUpperCase();
  // Same guard-apostrophe cleanup as Amount, so a negative Balance survives the
  // round-trip instead of being silently nulled.
  const balanceStr = (row['Balance'] || '').replace(/^'/, '').replace(/[€$£,\s]/g, '').trim();
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

  const transactions = /** @type {any[] & { skipped?: number }} */ ([]);
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
