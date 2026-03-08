/**
 * Bank CSV Adapters
 * Mirrors: apps/backend/services/bank_adapters.py
 *
 * Supports: Belfius, Revolut, KBC, and Generic CSV formats.
 */

import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { cleanRecipientName, cleanKbcRecipientName, normalizeToUppercase } from './textNormalization.js';
import { logger } from '../config/logger.js';

// ─── Transaction Data Structure ───

/**
 * @typedef {Object} TransactionData
 * @property {Date} date
 * @property {string} bankAccount
 * @property {string} recipient
 * @property {string|null} memo
 * @property {number} amount
 * @property {string|null} currency
 * @property {number|null} balance
 * @property {string|null} recipientAccount
 * @property {string|null} recipientAddress
 * @property {string|null} recipientBankName
 * @property {string|null} comment
 * @property {string} rawData
 */

// ─── Belfius Adapter ───

function parseBelfius(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const transactions = [];
  let lastBalance = null;

  // Extract last balance from line 10 (index 9)
  if (lines.length > 9) {
    const balanceLine = lines[9].trim();
    if (balanceLine.includes('Laatste saldo;')) {
      const parts = balanceLine.split(';');
      if (parts.length >= 2) {
        const balStr = parts[1].replace(' EUR', '').replace(',', '.').trim();
        const val = parseFloat(balStr);
        if (!isNaN(val)) lastBalance = val;
      }
    }
  }

  // Data starts at line 14 (index 13), after 12 metadata + 1 header line
  for (let i = 13; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(';');
    if (parts.length < 12) continue;

    const accountNumber = parts[0].trim();
    const transactionDateStr = parts[1].trim();
    const statementNumber = parts[2].trim();
    const transactionNumber = parts[3].trim();
    const recipientAccount = parts[4].trim();
    const recipientName = parts[5].trim();
    const street = parts[6].trim();
    const location = parts[7].trim();
    const transactionDescription = parts[8].trim();
    const valueDateStr = parts[9].trim();
    const amountStr = parts[10].trim();
    const currency = parts[11].trim();
    const bicCode = parts[12] ? parts[12].trim() : '';
    const countryCode = parts[13] ? parts[13].trim() : '';
    const additionalMessage = parts[14] ? parts[14].trim() : '';

    // Parse date DD/MM/YYYY
    const dateParts = transactionDateStr.split('/');
    if (dateParts.length !== 3) continue;
    const date = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`);
    if (isNaN(date.getTime())) continue;

    const amount = parseFloat(amountStr.replace(',', '.'));
    if (isNaN(amount)) continue;

    let fullRecipient = recipientName || transactionDescription;
    fullRecipient = cleanRecipientName(fullRecipient);
    fullRecipient = normalizeToUppercase(fullRecipient);

    let recipientFullAddress = null;
    const addressParts = [street, location].filter(p => p);
    if (addressParts.length) recipientFullAddress = addressParts.join(', ');

    const memo = transactionDescription ? normalizeToUppercase(transactionDescription) : '';

    const commentParts = [];
    if (statementNumber) commentParts.push(`Statement: ${statementNumber}`);
    if (transactionNumber) commentParts.push(`Transaction: ${transactionNumber}`);
    if (bicCode) commentParts.push(`BIC: ${bicCode}`);
    if (countryCode) commentParts.push(`Country: ${countryCode}`);
    if (additionalMessage) commentParts.push(additionalMessage);
    const comment = commentParts.length ? commentParts.join(' | ') : null;

    transactions.push({
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
      comment,
      rawData: line,
    });
  }

  // Calculate running balances if lastBalance available
  if (lastBalance !== null && transactions.length > 0) {
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

  logger.info(`Belfius CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

// ─── Revolut Adapter ───

function parseRevolut(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, { columns: false, skip_empty_lines: true, relax_column_count: true });
  const transactions = [];

  for (let i = 0; i < records.length; i++) {
    const parts = records[i];
    if (i === 0 && parts[0] && parts[0].trim() === 'Type') continue;
    if (parts.length < 10) continue;

    const transactionType = parts[0].trim();
    const product = parts[1].trim();
    const completedDateStr = parts[3].trim();
    const description = parts[4].trim();
    const amountStr = parts[5].trim();
    const feeStr = parts[6].trim();
    const currency = parts[7].trim();
    const state = parts[8].trim();
    const balanceStr = parts[9].trim();

    if (state.toUpperCase() !== 'COMPLETED') continue;
    if (!completedDateStr) continue;

    // Parse date - try multiple formats
    let date = null;
    for (const fmt of [
      /^(\d{4})-(\d{2})-(\d{2})\s/,
      /^(\d{4})-(\d{2})-(\d{2})$/,
    ]) {
      const m = completedDateStr.match(fmt);
      if (m) { date = new Date(`${m[1]}-${m[2]}-${m[3]}`); break; }
    }
    if (!date || isNaN(date.getTime())) {
      // Try generic parse
      date = new Date(completedDateStr);
      if (isNaN(date.getTime())) continue;
    }

    const amount = parseFloat(amountStr);
    if (isNaN(amount)) continue;

    const fee = parseFloat(feeStr) || 0;
    const balance = balanceStr ? parseFloat(balanceStr) : null;

    const cleanedDescription = normalizeToUppercase(cleanRecipientName(description));
    const memo = normalizeToUppercase(`${transactionType} - ${product}`);

    const commentParts = [];
    if (transactionType) commentParts.push(`Type: ${transactionType}`);
    if (product) commentParts.push(`Product: ${product}`);
    if (fee > 0) commentParts.push(`Fee: ${fee.toFixed(2)} ${currency}`);
    if (state) commentParts.push(`State: ${state}`);
    const comment = commentParts.length ? commentParts.join(' | ') : null;

    // Build raw data with normalized date for consistent hashing
    const normalizedDate = date.toISOString().split('T')[0];
    const normalizedParts = [...parts];
    normalizedParts[2] = normalizedDate;
    normalizedParts[3] = normalizedDate;
    const rawData = normalizedParts.map(f => f.includes(',') ? `"${f}"` : f).join(',');

    const bankAccount = product.toUpperCase() === 'SAVINGS'
      ? 'REVOLUT SAVINGS'
      : product.toUpperCase() === 'CURRENT'
        ? 'REVOLUT CURRENT'
        : `REVOLUT ${product.toUpperCase() || ''}`.trim();

    transactions.push({
      date,
      bankAccount,
      recipient: cleanedDescription,
      memo,
      amount,
      currency,
      balance: balance !== null && !isNaN(balance) ? balance : null,
      recipientAccount: null,
      recipientAddress: null,
      recipientBankName: null,
      comment,
      rawData,
    });
  }

  logger.info(`Revolut CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

// ─── KBC Adapter ───

function parseKBC(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const transactions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('Rekeningnummer') || line.includes('Vrije Mededeling')) continue;
    if (line.startsWith(',,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,')) continue;

    const parts = line.split(';');
    if (parts.length < 15) continue;

    const accountNumber = parts[0].trim();
    const currency = parts[3].trim();
    const statementNumber = parts[4].trim();
    const transactionDateStr = parts[5].trim();
    const description = parts[6].trim();
    const valueDateStr = parts[7].trim();
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

    // Parse date DD/MM/YYYY
    const dateParts = transactionDateStr.split('/');
    if (dateParts.length !== 3) continue;
    const date = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`);
    if (isNaN(date.getTime())) continue;

    const amount = parseFloat(amountStr.replace(',', '.'));
    if (isNaN(amount)) continue;

    const balance = balanceStr ? parseFloat(balanceStr.replace(',', '.')) : null;

    let transactionType = null;
    if (creditStr && creditStr.trim()) {
      const cv = parseFloat(creditStr.replace(',', '.'));
      if (!isNaN(cv) && Math.abs(cv) > 0) transactionType = 'CREDIT';
    }
    if (debitStr && debitStr.trim()) {
      const dv = parseFloat(debitStr.replace(',', '.'));
      if (!isNaN(dv) && Math.abs(dv) > 0) transactionType = 'DEBIT';
    }

    let fullRecipient = counterpartyName || description;
    if (!counterpartyName) {
      fullRecipient = cleanKbcRecipientName(fullRecipient);
    }
    fullRecipient = normalizeToUppercase(fullRecipient);

    const memo = description ? normalizeToUppercase(description) : '';

    const commentParts = [];
    if (statementNumber) commentParts.push(`Statement: ${statementNumber.trim()}`);
    if (transactionType) commentParts.push(`Type: ${transactionType}`);
    if (counterpartyBic) commentParts.push(`BIC: ${counterpartyBic}`);
    if (structuredCommunication) commentParts.push(`Structured: ${structuredCommunication}`);
    if (freeCommunication) commentParts.push(`Free: ${freeCommunication}`);
    const comment = commentParts.length ? commentParts.join(' | ') : null;

    transactions.push({
      date,
      bankAccount: 'KBC',
      recipient: fullRecipient,
      memo,
      amount,
      currency,
      balance: balance !== null && !isNaN(balance) ? balance : null,
      recipientAccount: counterpartyAccount || null,
      recipientAddress: counterpartyAddress || null,
      recipientBankName: counterpartyAccount ? 'KBC' : null,
      comment,
      rawData: line,
    });
  }

  logger.info(`KBC CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

// ─── Generic CSV Adapter ───

function parseGenericCSV(filePath, config) {
  const content = fs.readFileSync(filePath, config.encoding || 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    delimiter: config.separator || ',',
    from: (config.skip_rows || 0) + 1,
    relax_column_count: true,
  });

  const colMap = config.column_mapping;
  const transactions = [];

  for (const row of records) {
    try {
      const dateStr = String(row[colMap.date] || '').trim();
      if (!dateStr) continue;

      // Parse date using config.date_format (simplified JS parsing)
      let date;
      const fmt = config.date_format || '';
      if (fmt.includes('%d/%m/%Y') || fmt === '%d/%m/%Y') {
        const p = dateStr.split('/');
        date = new Date(`${p[2]}-${p[1]}-${p[0]}`);
      } else if (fmt.includes('%m/%d/%Y') || fmt === '%m/%d/%Y') {
        const p = dateStr.split('/');
        date = new Date(`${p[2]}-${p[0]}-${p[1]}`);
      } else {
        date = new Date(dateStr);
      }
      if (isNaN(date.getTime())) continue;

      const amountStr = String(row[colMap.amount] || '').replace(/[$€£,]/g, '').trim();
      let cleanedAmount = amountStr;
      if (cleanedAmount.startsWith('(') && cleanedAmount.endsWith(')')) {
        cleanedAmount = '-' + cleanedAmount.slice(1, -1);
      }
      const amount = parseFloat(cleanedAmount);
      if (isNaN(amount)) continue;

      const recipient = String(row[colMap.recipient] || '').trim();
      const memo = colMap.memo ? String(row[colMap.memo] || '').trim() : '';

      let currency = null;
      if (colMap.currency) currency = String(row[colMap.currency] || '').trim() || null;
      let balance = null;
      if (colMap.balance) {
        const bv = parseFloat(String(row[colMap.balance] || ''));
        if (!isNaN(bv)) balance = bv;
      }

      const rawData = Object.values(row).join('|');
      const bankName = config.bank_name || 'CUSTOM';
      const accountType = config.account_type;
      const bankAccount = accountType ? `${bankName} ${accountType.toUpperCase()}` : bankName;

      transactions.push({
        date,
        bankAccount,
        recipient,
        memo,
        amount,
        currency,
        balance,
        recipientAccount: null,
        recipientAddress: null,
        recipientBankName: null,
        comment: null,
        rawData,
      });
    } catch {
      continue;
    }
  }

  logger.info(`Generic CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

// ─── Vault Voyager (self-import) Adapter ───

function parseVaultVoyager(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const transactions = [];

  for (const row of records) {
    try {
      const dateStr = (row['Date'] || '').trim();
      if (!dateStr) continue;

      const date = new Date(dateStr);
      if (isNaN(date.getTime())) continue;

      const amountStr = (row['Amount'] || '').replace(/[€$£,\s]/g, '').trim();
      const amount = parseFloat(amountStr);
      if (isNaN(amount)) continue;

      const bankAccount = normalizeToUppercase((row['Bank Account'] || 'VAULT VOYAGER').trim());
      const recipientRaw = (row['Recipient'] || '').trim();
      const recipient = recipientRaw ? normalizeToUppercase(cleanRecipientName(recipientRaw)) : 'UNKNOWN';
      const memo = row['Memo'] ? normalizeToUppercase(row['Memo'].trim()) : '';
      const currency = (row['Currency'] || 'EUR').trim().toUpperCase();
      const balanceStr = (row['Balance'] || '').trim();
      const balance = balanceStr ? parseFloat(balanceStr) : null;
      const category = (row['Category'] || '').trim();
      const comment = (row['Comment'] || '').trim() || null;

      const commentParts = [];
      if (category) commentParts.push(`Imported Category: ${category}`);
      if (comment) commentParts.push(comment);
      const fullComment = commentParts.length ? commentParts.join(' | ') : null;

      const rawData = Object.values(row).join('|');

      transactions.push({
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
        comment: fullComment,
        rawData,
      });
    } catch {
      continue;
    }
  }

  logger.info(`Vault Voyager CSV parsed: ${transactions.length} transactions`);
  return transactions;
}

// ─── Factory ───

const BANK_CONFIGURATIONS = {
  belfius: { bankName: 'Belfius', parser: parseBelfius },
  revolut: { bankName: 'Revolut', parser: parseRevolut },
  kbc: { bankName: 'KBC', parser: parseKBC },
  vault_voyager: { bankName: 'Vault Voyager', parser: parseVaultVoyager },
};

export function createAdapter(bankName, customConfig = null) {
  if (customConfig) {
    return (filePath) => parseGenericCSV(filePath, customConfig);
  }
  const key = bankName.toLowerCase().replace(/\s+/g, '_');
  const cfg = BANK_CONFIGURATIONS[key];
  if (!cfg) throw new Error(`No configuration found for bank: ${bankName}`);
  return cfg.parser;
}

export function getSupportedBanks() {
  return Object.keys(BANK_CONFIGURATIONS);
}
