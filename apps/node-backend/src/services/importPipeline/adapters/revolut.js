/**
 * Revolut CSV adapter — english headers, comma-separated, COMPLETED-only rows.
 */

import {
  cleanRecipientName,
  normalizeToUppercase,
} from "../../../lib/textNormalization.js";
import { logger } from "../../../config/logger.js";
import {
  parseCsvFile,
  buildOptionalComment,
  parseDecimalSafe,
  parseDateFlexibleUtc,
  normalizeIsoCurrency,
} from "./_shared.js";
import { toDecimal, roundMoney } from "../../../lib/money.js";
import { epochMsToUtcYmd } from "../../../lib/dateFormat.js";

/**
 * @typedef {import('./_shared.js').ParsedBankTransaction} ParsedBankTransaction
 * @typedef {import('./_shared.js').ParsedBankTransactions} ParsedBankTransactions
 */

const NAME = "revolut";
const BANK_LABEL = "Revolut";
const MIN_FIELDS = 10;

/**
 * @param {string} completedDateStr
 * @returns {Date|null} UTC-midnight Date
 */
function parseRevolutDate(completedDateStr) {
  // "YYYY-MM-DD HH:MM:SS" and plain ISO are both handled by the shared parser;
  // any other shape is rebuilt at UTC midnight rather than local (day-shift).
  return parseDateFlexibleUtc(completedDateStr);
}

/**
 * @param {string|null|undefined} product Revolut's "Product" column (CURRENT / SAVINGS / …)
 * @returns {string} the ADR-088 account label
 */
function buildBankAccount(product) {
  const upper = (product || "").toUpperCase();
  if (upper === "SAVINGS") return "REVOLUT SAVINGS";
  if (upper === "CURRENT") return "REVOLUT CURRENT";
  return `REVOLUT ${upper}`.trim();
}

/**
 * Rebuild the source record with both date columns normalized, so `rawData`
 * (and the dedup hash derived from it) is stable across export variants.
 *
 * @param {string[]} parts
 * @param {string} normalizedDate
 * @returns {string}
 */
function buildNormalizedRawData(parts, normalizedDate) {
  const normalized = [...parts];
  normalized[2] = normalizedDate;
  normalized[3] = normalizedDate;
  return normalized.map((f) => (f.includes(",") ? `"${f}"` : f)).join(",");
}

/**
 * @param {string[]} parts one split CSV record
 * @returns {ParsedBankTransaction|null} null when too short or unparseable
 */
function parseRow(parts) {
  if (parts.length < MIN_FIELDS) return null;

  const transactionType = parts[0].trim();
  const product = parts[1].trim();
  const completedDateStr = parts[3].trim();
  const description = parts[4].trim();
  const amountStr = parts[5].trim();
  const feeStr = parts[6].trim();
  const currencyCell = parts[7].trim();
  const currency = normalizeIsoCurrency(currencyCell);
  const state = parts[8].trim();
  const balanceStr = parts[9].trim();

  if (state.toUpperCase() !== "COMPLETED") return null;
  if (!completedDateStr) return null;

  const date = parseRevolutDate(completedDateStr);
  if (!date) return null;

  const grossAmount = parseDecimalSafe(amountStr);
  if (isNaN(grossAmount)) return null;

  const fee = parseDecimalSafe(feeStr) || 0;
  // Revolut's Amount column excludes Fee — the actual balance delta is
  // amount − fee. Book the net so imported amounts reconcile with the
  // imported Balance column (fee stays visible in the comment below).
  const amount = fee
    ? roundMoney(toDecimal(grossAmount).minus(toDecimal(fee)))
    : grossAmount;
  const balance = balanceStr ? parseDecimalSafe(balanceStr) : null;

  const cleanedDescription = normalizeToUppercase(
    cleanRecipientName(description),
  );
  const memo = normalizeToUppercase(`${transactionType} - ${product}`);

  const commentParts = [];
  if (transactionType) commentParts.push(`Type: ${transactionType}`);
  if (product) commentParts.push(`Product: ${product}`);
  if (fee > 0) {
    const feeText = fee
      .toFixed(4)
      .replace(/(\.\d{2}[1-9])0$/, "$1")
      .replace(/(\.\d{2})00$/, "$1");
    commentParts.push(`Fee: ${feeText} ${currencyCell}`);
  }
  if (state) commentParts.push(`State: ${state}`);

  const normalizedDate = epochMsToUtcYmd(date.getTime());
  const rawData = buildNormalizedRawData(parts, normalizedDate);

  return {
    date,
    bankAccount: buildBankAccount(product),
    recipient: cleanedDescription,
    memo,
    amount,
    currency,
    balance: balance !== null && !isNaN(balance) ? balance : null,
    recipientAccount: null,
    recipientAddress: null,
    recipientBankName: null,
    comment: buildOptionalComment(commentParts),
    rawData,
  };
}

/**
 * @param {string|null|undefined} csvSample raw head of the uploaded file
 * @returns {boolean}
 */
export function detect(csvSample) {
  if (!csvSample) return false;
  const firstLine = csvSample.split("\n")[0] || "";
  const lower = firstLine.toLowerCase();
  return (
    lower.startsWith("type,") &&
    lower.includes("completed date") &&
    lower.includes("state")
  );
}

/**
 * @param {string} filePath
 * @returns {Promise<ParsedBankTransactions>}
 */
export async function parse(filePath) {
  const records = await parseCsvFile(filePath, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  const transactions = /** @type {ParsedBankTransactions} */ ([]);
  let skipped = 0;

  for (let i = 0; i < records.length; i++) {
    const parts = records[i];
    if (i === 0 && parts[0] && parts[0].trim() === "Type") continue;
    const tx = parseRow(parts);
    if (tx) transactions.push(tx);
    else skipped++;
  }

  transactions.skipped = skipped;
  logger.info(
    `Revolut CSV parsed: ${transactions.length} transactions, ${skipped} skipped`,
  );
  return transactions;
}

export default {
  name: NAME,
  bankName: BANK_LABEL,
  detect,
  parse,
  multiCurrencyCash: true,
};
