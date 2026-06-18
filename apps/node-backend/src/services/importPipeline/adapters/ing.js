/**
 * ING CSV adapter — Dutch-language ING bank statements.
 * Semicolon-delimited with a single header row.
 *
 * Columns (0-based):
 *   0  Rekeningnummer       own account IBAN
 *   1  Naam van de rekening own account name
 *   2  Rekening tegenpartij counterparty IBAN
 *   3  Omzetnummer          transaction reference number
 *   4  Boekingsdatum        booking date   DD/MM/YYYY
 *   5  Valutadatum          value date     DD/MM/YYYY
 *   6  Bedrag               amount         EU decimal (comma separator)
 *   7  Munteenheid          currency code
 *   8  Omschrijving         transaction type / category label
 *   9  Detail van de omzet  counterparty name / merchant
 *  10  Bericht              free-text message from sender
 */

import fs from 'fs';
import { normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseDayMonthYear, parseCommaDecimal, buildOptionalComment, splitCsvLines, canonicalIban } from './_shared.js';

const NAME = 'ing';
const BANK_LABEL = 'ING';
const MIN_FIELDS = 9;

function isHeaderLine(line) {
  return line.includes('Omzetnummer') && line.includes('Boekingsdatum');
}

function parseLine(line) {
  const parts = line.split(';');
  if (parts.length < MIN_FIELDS) return null;

  const accountNumber = parts[0].trim();
  const counterpartyAccount = parts[2].trim();
  const transactionNumber = parts[3].trim();
  const bookingDateStr = parts[4].trim();
  const amountStr = parts[6].trim();
  const currency = parts[7].trim();
  const description = parts[8].trim();
  const detail = parts[9] ? parts[9].trim() : '';
  const message = parts[10] ? parts[10].trim() : '';

  const date = parseDayMonthYear(bookingDateStr);
  if (!date) return null;

  const amount = parseCommaDecimal(amountStr);
  if (isNaN(amount)) return null;

  const recipientRaw = detail || description;
  const recipient = normalizeToUppercase(recipientRaw);
  const memo = normalizeToUppercase(description);

  const commentParts = [];
  if (transactionNumber) commentParts.push(`Transaction: ${transactionNumber}`);
  if (message) commentParts.push(`Message: ${message}`);

  return {
    date,
    bankAccount: canonicalIban(accountNumber) || 'ING',
    recipient,
    memo,
    amount,
    currency: currency || null,
    balance: null,
    recipientAccount: counterpartyAccount || null,
    recipientAddress: null,
    recipientBankName: counterpartyAccount ? 'ING' : null,
    comment: buildOptionalComment(commentParts),
    rawData: line,
  };
}

export function detect(csvSample) {
  if (!csvSample) return false;
  const lines = splitCsvLines(csvSample).slice(0, 3);
  return lines.some(
    (line) => line.includes('Omzetnummer') && line.includes('Detail van de omzet'),
  );
}

export async function parse(filePath) {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  const lines = splitCsvLines(content);
  const transactions = /** @type {any[] & { skipped?: number }} */ ([]);
  let skipped = 0;
  let headerSeen = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isHeaderLine(line)) {
      headerSeen = true;
      continue;
    }
    if (!headerSeen) continue;
    const tx = parseLine(line);
    if (tx) transactions.push(tx);
    else skipped++;
  }

  transactions.skipped = skipped;
  logger.info(`ING CSV parsed: ${transactions.length} transactions, ${skipped} skipped`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
