/**
 * SABB (Saudi British Bank) CSV adapter.
 */

import { cleanRecipientName, normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildOptionalComment, buildRawRowString, parseAmountField, parseDayMonthYear, parseDateFlexibleUtc } from './_shared.js';

const NAME = 'sabb';
const BANK_LABEL = 'SABB';

// Non-completed rows (pending authorisations, declines, reversals) haven't
// settled — importing them corrupts balances, the same class of bug the
// Revolut/Wise adapters already guard against by skipping non-COMPLETED rows.
// Denylist rather than "keep only Completed": SABB's status vocabulary isn't
// pinned against a real export, so an unknown status keeps the row instead of
// silently dropping a settled transaction.
const NON_COMPLETED_STATUS_RE = /pending|declin|reject|refus|revers|fail|cancel/i;

function rowToTransaction(row) {
  const status = (row['Status'] || '').trim();
  if (NON_COMPLETED_STATUS_RE.test(status)) return null;

  const dateStr = (row['Transaction date'] || '').trim();
  if (!dateStr) return null;

  // The SABB export's date format isn't pinned, so parse DD/MM/YYYY explicitly
  // (V8's new Date() would read DD/MM as MM/DD → silent month/day swap, or
  // Invalid Date for days > 12); everything else goes through the shared
  // UTC-normalizing parser.
  let date;
  if (/^\d{2}\/\d{2}\/\d{4}/.test(dateStr)) {
    date = parseDayMonthYear(dateStr.slice(0, 10));
  } else {
    date = parseDateFlexibleUtc(dateStr);
  }
  if (!date) return null;

  const amountRaw = (row['Amount(SAR)'] || '').trim();
  if (!amountRaw) return null;
  const amountStr = amountRaw.replace(/[A-Za-z\s]/g, '').trim();
  const amount = parseAmountField(amountStr);
  if (isNaN(amount)) return null;

  const descriptionRaw = (row['Description'] || '').trim();
  const descCleaned = descriptionRaw.replace(/^\d{16}/, '').trim();
  const recipient = descCleaned ? normalizeToUppercase(cleanRecipientName(descCleaned)) : 'UNKNOWN';
  const memo = descriptionRaw ? normalizeToUppercase(descriptionRaw) : '';

  const postingDate = (row['Posting date'] || '').trim();
  const otherCurrency = (row['Amount(Other Currency)'] || '').trim();

  const commentParts = [];
  if (status) commentParts.push(`Status: ${status}`);
  if (postingDate) commentParts.push(`Posting Date: ${postingDate}`);
  if (otherCurrency) commentParts.push(`Other Currency: ${otherCurrency}`);

  const currencyMatch = amountRaw.match(/[A-Z]{3}/);
  const currency = currencyMatch ? currencyMatch[0] : 'SAR';

  return {
    date,
    bankAccount: 'SABB',
    recipient,
    memo,
    amount,
    currency,
    balance: null,
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
  return firstLine.includes('transaction date') && firstLine.includes('amount(sar)');
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

  logger.info(`SABB CSV parsed: ${transactions.length} transactions, ${skipped} skipped`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
