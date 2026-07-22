/**
 * KBC CSV adapter — Belgian bank, ';'-separated with 15+ columns.
 */

import { cleanKbcRecipientName, normalizeToUppercase } from '../../../lib/textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseDayMonthYear, parseCommaDecimal, buildOptionalComment, splitCsvLines, splitDelimitedRecord, canonicalIban, readTextWithEncodingFallback } from './_shared.js';

const NAME = 'kbc';
const BANK_LABEL = 'KBC';
const MIN_FIELDS = 15;

function classifyTransactionType(creditStr, debitStr) {
  if (creditStr && creditStr.trim()) {
    const cv = parseCommaDecimal(creditStr);
    if (!isNaN(cv) && Math.abs(cv) > 0) return 'CREDIT';
  }
  if (debitStr && debitStr.trim()) {
    const dv = parseCommaDecimal(debitStr);
    if (!isNaN(dv) && Math.abs(dv) > 0) return 'DEBIT';
  }
  return null;
}

function parseLine(line) {
  const parts = splitDelimitedRecord(line);
  if (!parts || parts.length < MIN_FIELDS) return null;

  const ownAccount = parts[0].trim(); // "Rekeningnummer" — the account holder's own IBAN
  const currency = parts[3].trim();
  const statementNumber = parts[4].trim();
  const transactionDateStr = parts[5].trim();
  const description = parts[6].trim();
  const amountStr = parts[8].trim();
  const balanceStr = parts[9].trim();
  const creditStr = parts[10].trim();
  const debitStr = parts[11].trim();
  const counterpartyAccount = parts[12].trim();
  const counterpartyBic = parts[13].trim();
  const counterpartyName = parts[14].trim();
  const counterpartyAddress = parts[15] ? parts[15].trim() : '';
  const structuredCommunication = parts[16] ? parts[16].trim() : '';
  const freeCommunication = parts[17] ? parts[17].trim() : '';

  const date = parseDayMonthYear(transactionDateStr);
  if (!date) return null;

  const amount = parseCommaDecimal(amountStr);
  if (isNaN(amount)) return null;

  const balance = balanceStr ? parseCommaDecimal(balanceStr) : null;
  const transactionType = classifyTransactionType(creditStr, debitStr);

  let fullRecipient = counterpartyName || description;
  if (!counterpartyName) fullRecipient = cleanKbcRecipientName(fullRecipient);
  fullRecipient = normalizeToUppercase(fullRecipient);

  const memo = description ? normalizeToUppercase(description) : '';

  const commentParts = [];
  if (statementNumber) commentParts.push(`Statement: ${statementNumber.trim()}`);
  if (transactionType) commentParts.push(`Type: ${transactionType}`);
  if (counterpartyBic) commentParts.push(`BIC: ${counterpartyBic}`);
  if (structuredCommunication) commentParts.push(`Structured: ${structuredCommunication}`);
  if (freeCommunication) commentParts.push(`Free: ${freeCommunication}`);

  return {
    date,
    bankAccount: canonicalIban(ownAccount) || 'KBC',
    recipient: fullRecipient,
    memo,
    amount,
    currency,
    balance: balance !== null && !isNaN(balance) ? balance : null,
    recipientAccount: counterpartyAccount || null,
    recipientAddress: counterpartyAddress || null,
    recipientBankName: counterpartyAccount ? 'KBC' : null,
    comment: buildOptionalComment(commentParts),
    rawData: line,
  };
}

function isNonDataLine(line) {
  return line.startsWith('Rekeningnummer')
    || line.includes('Vrije Mededeling')
    || line.startsWith(',,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,');
}

export function detect(csvSample) {
  if (!csvSample) return false;
  const lines = splitCsvLines(csvSample).slice(0, 5);
  return lines.some((line) => line.startsWith('Rekeningnummer'))
    || lines.some((line) => line.includes('Vrije Mededeling'));
}

export async function parse(filePath) {
  const content = await readTextWithEncodingFallback(filePath);
  const lines = splitCsvLines(content);
  const transactions = /** @type {any[] & { skipped?: number }} */ ([]);
  let skipped = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isNonDataLine(line)) continue;
    const tx = parseLine(line);
    if (tx) transactions.push(tx);
    else skipped++;
  }

  transactions.skipped = skipped;
  logger.info(`KBC CSV parsed: ${transactions.length} transactions, ${skipped} skipped`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
