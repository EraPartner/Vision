/**
 * Vision (self-import) CSV adapter — re-import Vision's own export format.
 */

import { cleanRecipientName, normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildOptionalComment, buildRawRowString, parseAmountField, parseDateFlexibleUtc } from './_shared.js';

const NAME = 'vision';
const BANK_LABEL = 'Vision';

function rowToTransaction(row) {
  const dateStr = (row['Date'] || '').trim();
  if (!dateStr) return null;

  const date = parseDateFlexibleUtc(dateStr);
  if (!date) return null;

  // Strip a leading "'": older exports ran numeric cells through the CSV
  // formula-injection guard, which prepended "'" to negatives ("'-12.34").
  // Without this, every expense row NaN-drops on a Vision-export round-trip.
  // Amounts go through parseAmountField — this adapter's loose header
  // detection can catch non-Vision CSVs, and blindly deleting commas turned
  // an EU-decimal "12,34" into 1234 (a silent 100× error).
  const amountStr = (row['Amount'] || '').replace(/'/g, '').trim();
  const amount = parseAmountField(amountStr);
  if (isNaN(amount)) return null;

  const bankAccount = normalizeToUppercase((row['Bank Account'] || 'VISION').trim());
  const recipientRaw = (row['Recipient'] || '').trim();
  const recipient = recipientRaw ? normalizeToUppercase(cleanRecipientName(recipientRaw)) : 'UNKNOWN';
  const memo = row['Memo'] ? normalizeToUppercase(row['Memo'].trim()) : '';
  const currency = (row['Currency'] || 'EUR').trim().toUpperCase();
  // Same guard-apostrophe cleanup as Amount, so a negative Balance survives the
  // round-trip instead of being silently nulled.
  const balanceStr = (row['Balance'] || '').replace(/'/g, '').trim();
  const balance = balanceStr ? parseAmountField(balanceStr) : null;
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

// Vision's own export column order (transactionExport.js). Detection requires
// this exact ordered prefix — word-substring matching used to auto-route any
// unknown bank CSV whose header merely contained "date"/"amount"/"bank
// account"/"recipient" to this adapter. Columns after Currency (Balance,
// Category, Comment, Tags, Running Balance) are allowed to vary so older or
// extended exports still detect.
const EXPORT_HEADER_PREFIX = ['date', 'bank account', 'recipient', 'memo', 'amount', 'currency'];

export function detect(csvSample) {
  if (!csvSample) return false;
  // Strip a UTF-8 BOM — detect() receives raw file content, not the
  // BOM-stripped lines the parsers see.
  const firstLine = (csvSample.replace(/^\uFEFF/, '').split('\n')[0] || '').trim().toLowerCase();
  const cols = firstLine.split(',').map((c) => c.trim());
  return EXPORT_HEADER_PREFIX.every((name, i) => cols[i] === name);
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
