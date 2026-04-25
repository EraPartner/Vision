/**
 * SABB (Saudi British Bank) CSV adapter.
 */

import { cleanRecipientName, normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseCsvFile, buildOptionalComment, buildRawRowString } from './_shared.js';

const NAME = 'sabb';
const BANK_LABEL = 'SABB';

function rowToTransaction(row) {
  const dateStr = (row['Transaction date'] || '').trim();
  if (!dateStr) return null;

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;

  const amountRaw = (row['Amount(SAR)'] || '').trim();
  if (!amountRaw) return null;
  const amountStr = amountRaw.replace(/[A-Za-z\s]/g, '').trim();
  const amount = parseFloat(amountStr);
  if (isNaN(amount)) return null;

  const descriptionRaw = (row['Description'] || '').trim();
  const descCleaned = descriptionRaw.replace(/^\d{16}/, '').trim();
  const recipient = descCleaned ? normalizeToUppercase(cleanRecipientName(descCleaned)) : 'UNKNOWN';
  const memo = descriptionRaw ? normalizeToUppercase(descriptionRaw) : '';

  const status = (row['Status'] || '').trim();
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

  const transactions = [];
  for (const row of records) {
    try {
      const tx = rowToTransaction(row);
      if (tx) transactions.push(tx);
    } catch {
      continue;
    }
  }

  logger.info(`SABB CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
