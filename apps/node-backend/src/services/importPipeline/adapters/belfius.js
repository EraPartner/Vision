/**
 * Belfius CSV adapter — Dutch-language Belgian bank statements.
 * Statement-export format: 13 header lines, then ';'-delimited transactions.
 */

import { cleanRecipientName, normalizeToUppercase } from '../../../lib/textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseDayMonthYear, parseCommaDecimal, buildOptionalComment, splitCsvLines, splitDelimitedRecord, canonicalIban, readTextWithEncodingFallback } from './_shared.js';
import { toDecimal, roundMoney } from '../../../lib/money.js';

/**
 * @typedef {import('./_shared.js').ParsedBankTransaction} ParsedBankTransaction
 * @typedef {import('./_shared.js').ParsedBankTransactions} ParsedBankTransactions
 */

const NAME = 'belfius';
const BANK_LABEL = 'Belfius';
const HEADER_ROWS = 13;
const BALANCE_LINE_INDEX = 9;
const MIN_FIELDS = 12;

/**
 * @param {string} line the statement's "Laatste saldo;" header line
 * @returns {number|null}
 */
function parseLastBalance(line) {
  if (!line.includes('Laatste saldo;')) return null;
  const parts = line.split(';');
  if (parts.length < 2) return null;
  // "12.345,67 EUR" — a bare comma swap left "12.345.67" (NaN), so running
  // balances silently never applied for balances ≥ €1000.
  const balStr = parts[1].replace(' EUR', '').trim();
  const val = parseCommaDecimal(balStr);
  return isNaN(val) ? null : val;
}

/**
 * Walk the statement's closing balance backwards over the rows, stamping each
 * one's `balance`. Mutates `transactions` in place.
 *
 * @param {ParsedBankTransaction[]} transactions
 * @param {number|null} lastBalance
 * @returns {void}
 */
function applyRunningBalances(transactions, lastBalance) {
  if (lastBalance === null || transactions.length === 0) return;

  // Order by the statement/transaction numbers — the export's own sequence.
  // Guessing direction from first-vs-last date treated a single-day statement
  // as descending; if it was actually ascending, every row was assigned a
  // balance walked from the wrong end. Date heuristic kept only as a fallback
  // for rows without parseable sequence numbers.
  const haveSeq = transactions.every(
    (tx) => Number.isFinite(tx._seq[0]) && Number.isFinite(tx._seq[1]),
  );
  let newestToOldest;
  if (haveSeq) {
    newestToOldest = [...transactions].sort(
      (a, b) => (b._seq[0] - a._seq[0]) || (b._seq[1] - a._seq[1]),
    );
  } else {
    const isDescending = transactions[0].date >= transactions[transactions.length - 1].date;
    newestToOldest = isDescending ? [...transactions] : [...transactions].reverse();
  }

  // Accumulate as Decimal — rounding the float `bal` every row let drift
  // compound backwards across the whole statement.
  let bal = toDecimal(lastBalance);
  for (const tx of newestToOldest) {
    tx.balance = roundMoney(bal);
    bal = bal.minus(toDecimal(tx.amount));
  }
}

/**
 * @param {string} line one ';'-delimited statement record
 * @returns {ParsedBankTransaction|null} null when the line is too short or unparseable
 */
function parseTransactionLine(line) {
  const parts = splitDelimitedRecord(line);
  if (!parts || parts.length < MIN_FIELDS) return null;

  const accountNumber = parts[0].trim();
  const transactionDateStr = parts[1].trim();
  const statementNumber = parts[2].trim();
  const transactionNumber = parts[3].trim();
  const recipientAccount = parts[4].trim();
  const recipientName = parts[5].trim();
  const street = parts[6].trim();
  const location = parts[7].trim();
  const transactionDescription = parts[8].trim();
  const amountStr = parts[10].trim();
  const currency = parts[11].trim();
  const bicCode = parts[12] ? parts[12].trim() : '';
  const countryCode = parts[13] ? parts[13].trim() : '';
  const additionalMessage = parts[14] ? parts[14].trim() : '';

  const date = parseDayMonthYear(transactionDateStr);
  if (!date) return null;

  const amount = parseCommaDecimal(amountStr);
  if (isNaN(amount)) return null;

  const baseRecipient = recipientName || transactionDescription;
  const fullRecipient = normalizeToUppercase(cleanRecipientName(baseRecipient));

  const addressParts = [street, location].filter(Boolean);
  const recipientFullAddress = addressParts.length ? addressParts.join(', ') : null;
  const memo = transactionDescription ? normalizeToUppercase(transactionDescription) : '';

  const commentParts = [];
  if (statementNumber) commentParts.push(`Statement: ${statementNumber}`);
  if (transactionNumber) commentParts.push(`Transaction: ${transactionNumber}`);
  if (bicCode) commentParts.push(`BIC: ${bicCode}`);
  if (countryCode) commentParts.push(`Country: ${countryCode}`);
  if (additionalMessage) commentParts.push(additionalMessage);

  return {
    date,
    bankAccount: canonicalIban(accountNumber) || 'BELFIUS',
    recipient: fullRecipient,
    memo,
    amount,
    currency,
    balance: null,
    recipientAccount: recipientAccount || null,
    recipientAddress: recipientFullAddress,
    recipientBankName: recipientAccount ? 'BELFIUS' : null,
    comment: buildOptionalComment(commentParts),
    rawData: line,
    // Statement + transaction number: the export's own ordering, used (and
    // stripped again) by applyRunningBalances.
    _seq: [Number.parseInt(statementNumber, 10), Number.parseInt(transactionNumber, 10)],
  };
}

/**
 * @param {string|null|undefined} csvSample raw head of the uploaded file
 * @returns {boolean}
 */
export function detect(csvSample) {
  if (!csvSample) return false;
  const lines = splitCsvLines(csvSample).slice(0, 15);
  return lines.some((line) => line.includes('Laatste saldo;'))
    || lines.some((line) => /^BE\d{2}/.test(line.trim()) && line.split(';').length >= MIN_FIELDS);
}

/**
 * @param {string} filePath
 * @returns {Promise<ParsedBankTransactions>}
 */
export async function parse(filePath) {
  const content = await readTextWithEncodingFallback(filePath);
  const lines = splitCsvLines(content);
  const transactions = /** @type {ParsedBankTransactions} */ ([]);
  const lastBalance = lines.length > BALANCE_LINE_INDEX
    ? parseLastBalance(lines[BALANCE_LINE_INDEX].trim())
    : null;

  let skipped = 0;
  for (let i = HEADER_ROWS; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const tx = parseTransactionLine(line);
    if (tx) {
      transactions.push(tx);
    } else {
      skipped++;
    }
  }

  applyRunningBalances(transactions, lastBalance);
  for (const tx of transactions) delete tx._seq;
  transactions.skipped = skipped;
  logger.info(`Belfius CSV parsed: ${transactions.length} transactions, ${skipped} skipped`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
