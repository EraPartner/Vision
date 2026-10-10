/**
 * Revolut CSV adapter — english headers, comma-separated, COMPLETED-only rows.
 */

import {
  cleanRecipientName,
  normalizeToUppercase,
} from "../../../lib/textNormalization.ts";
import { logger } from "../../../config/logger.ts";
import {
  parseCsvFile,
  buildOptionalComment,
  rawDataForCsvRecord,
  parseDecimalSafe,
  parseDateFlexibleUtc,
  normalizeIsoCurrency,
  cellAt,
} from "./_shared.ts";
import type {
  ParsedBankTransaction,
  ParsedBankTransactions,
} from "./_shared.ts";
import { toDecimal, roundMoney } from "../../../lib/money.ts";

const NAME = "revolut";
const BANK_LABEL = "Revolut";
const MIN_FIELDS = 10;

/**
 * @returns UTC-midnight Date
 */
function parseRevolutDate(completedDateStr: string): Date | null {
  // "YYYY-MM-DD HH:MM:SS" and plain ISO are both handled by the shared parser;
  // any other shape is rebuilt at UTC midnight rather than local (day-shift).
  return parseDateFlexibleUtc(completedDateStr);
}

/**
 * @param product Revolut's "Product" column (CURRENT / SAVINGS / …)
 * @returns the ADR-088 account label
 */
function buildBankAccount(product: string | null | undefined): string {
  const upper = (product || "").toUpperCase();
  if (upper === "SAVINGS") return "REVOLUT SAVINGS";
  if (upper === "CURRENT") return "REVOLUT CURRENT";
  return `REVOLUT ${upper}`.trim();
}

/**
 * @param parts one split CSV record
 * @returns null when too short or unparseable
 */
function parseRow(parts: string[]): ParsedBankTransaction | null {
  if (parts.length < MIN_FIELDS) return null;

  const transactionType = cellAt(parts, 0).trim();
  const product = cellAt(parts, 1).trim();
  const completedDateStr = cellAt(parts, 3).trim();
  const description = cellAt(parts, 4).trim();
  const amountStr = cellAt(parts, 5).trim();
  const feeStr = cellAt(parts, 6).trim();
  const currencyCell = cellAt(parts, 7).trim();
  const currency = normalizeIsoCurrency(currencyCell);
  const state = cellAt(parts, 8).trim();
  const balanceStr = cellAt(parts, 9).trim();

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
    rawData: rawDataForCsvRecord(parts),
  };
}

/**
 * @param csvSample raw head of the uploaded file
 */
export function detect(csvSample: string | null | undefined): boolean {
  if (!csvSample) return false;
  const firstLine = csvSample.split("\n")[0] || "";
  const lower = firstLine.toLowerCase();
  return (
    lower.startsWith("type,") &&
    lower.includes("completed date") &&
    lower.includes("state")
  );
}

export async function parse(filePath: string): Promise<ParsedBankTransactions> {
  const records = await parseCsvFile<string[]>(filePath, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  const transactions: ParsedBankTransactions = [];
  let skipped = 0;

  for (const [i, parts] of records.entries()) {
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
