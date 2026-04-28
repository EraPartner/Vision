/**
 * Belfius CSV adapter — Dutch-language Belgian bank statements.
 * Statement-export format: 13 header lines, then ';'-delimited transactions.
 */

import fs from 'fs';
import { cleanRecipientName, normalizeToUppercase } from '../../textNormalization.js';
import { logger } from '../../../config/logger.js';
import { parseDayMonthYear, parseCommaDecimal, buildOptionalComment, splitCsvLines } from './_shared.js';

const NAME = 'belfius';
const BANK_LABEL = 'Belfius';
const HEADER_ROWS = 13;
const BALANCE_LINE_INDEX = 9;
const MIN_FIELDS = 12;

function parseLastBalance(line) {
  if (!line.includes('Laatste saldo;')) return null;
  const parts = line.split(';');
  if (parts.length < 2) return null;
  const balStr = parts[1].replace(' EUR', '').replace(',', '.').trim();
  const val = parseFloat(balStr);
  return isNaN(val) ? null : val;
}

function applyRunningBalances(transactions, lastBalance) {
  if (lastBalance === null || transactions.length === 0) return;
  let bal = lastBalance;
  const isDescending = transactions[0].date >= transactions[transactions.length - 1].date;
  const indices = isDescending
    ? Array.from({ length: transactions.length }, (_, i) => i)
    : Array.from({ length: transactions.length }, (_, i) => transactions.length - 1 - i);

  for (const i of indices) {
    transactions[i].balance = Math.round(bal * 100) / 100;
    bal -= transactions[i].amount;
  }
}

function parseTransactionLine(line) {
  const parts = line.split(';');
  if (parts.length < MIN_FIELDS) return null;

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
    bankAccount: 'BELFIUS',
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
    _accountNumber: accountNumber,
  };
}

export function detect(csvSample) {
  if (!csvSample) return false;
  const lines = splitCsvLines(csvSample).slice(0, 15);
  return lines.some((line) => line.includes('Laatste saldo;'))
    || lines.some((line) => /^BE\d{2}/.test(line.trim()) && line.split(';').length >= MIN_FIELDS);
}

export async function parse(filePath) {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  const lines = splitCsvLines(content);
  const transactions = [];
  const lastBalance = lines.length > BALANCE_LINE_INDEX
    ? parseLastBalance(lines[BALANCE_LINE_INDEX].trim())
    : null;

  for (let i = HEADER_ROWS; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const tx = parseTransactionLine(line);
    if (tx) {
      delete tx._accountNumber;
      transactions.push(tx);
    }
  }

  applyRunningBalances(transactions, lastBalance);
  logger.info(`Belfius CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
