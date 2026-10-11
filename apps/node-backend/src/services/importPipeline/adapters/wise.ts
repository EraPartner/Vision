/**
 * Wise CSV adapter — multi-currency transfer history.
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
  parseAmountField,
  parseDateFlexibleUtc,
  normalizeIsoCurrency,
} from "./_shared.ts";
import type {
  ParsedBankTransaction,
  ParsedBankTransactions,
} from "./_shared.ts";

const NAME = "wise";
const BANK_LABEL = "Wise";

/**
 * @param direction Wise's 'IN' / 'OUT' / 'NEUTRAL' column
 * @returns signed amount, or null when unparseable
 */
function resolveAmount(amountStr: string, direction: string): number | null {
  const parsed = parseAmountField(amountStr);
  if (isNaN(parsed)) return null;
  if (direction === "OUT") return -Math.abs(parsed);
  if (direction === "IN") return Math.abs(parsed);
  return parsed;
}

function buildWiseComment(
  row: Record<string, string>,
  direction: string,
  sourceAmountStr: string,
  targetAmountStr: string,
  sourceCurrency: string,
  targetCurrency: string,
): string | null {
  const sourceFee = (row["Source fee amount"] || "").trim();
  const sourceFeeCurrency = (row["Source fee currency"] || "").trim();
  const exchangeRate = (row["Exchange rate"] || "").trim();
  const transactionId = (row["ID"] || "").trim();
  const batch = (row["Batch"] || "").trim();

  const commentParts = [];
  if (transactionId) commentParts.push(`ID: ${transactionId}`);
  if (direction) commentParts.push(`Direction: ${direction}`);
  if (sourceFee && parseFloat(sourceFee) > 0)
    commentParts.push(`Fee: ${sourceFee} ${sourceFeeCurrency}`);
  if (exchangeRate && parseFloat(exchangeRate) > 0)
    commentParts.push(`Rate: ${exchangeRate}`);
  if (sourceCurrency !== targetCurrency && sourceCurrency && targetCurrency) {
    commentParts.push(
      `${sourceAmountStr} ${sourceCurrency} → ${targetAmountStr} ${targetCurrency}`,
    );
  }
  if (batch) commentParts.push(`Batch: ${batch}`);
  return buildOptionalComment(commentParts);
}

/**
 * @param row a `columns: true` csv-parse record
 * @returns null unless the row is COMPLETED and parseable
 */
function rowToTransaction(
  row: Record<string, string>,
): ParsedBankTransaction | null {
  const status = (row["Status"] || "").trim().toUpperCase();
  if (status !== "COMPLETED") return null;

  const dateStr = (row["Finished on"] || row["Created on"] || "").trim();
  if (!dateStr) return null;
  // Wise exports "YYYY-MM-DD HH:MM:SS"; parseDateFlexibleUtc reads the ISO date
  // part as UTC and rebuilds any other shape at UTC midnight so toISOString in
  // stage/dedup can't shift the day.
  const date = parseDateFlexibleUtc(dateStr);
  if (!date) return null;

  const direction = (row["Direction"] || "").trim().toUpperCase();

  const targetAmountStr = (row["Target amount (after fees)"] || "").trim();
  const sourceAmountStr = (row["Source amount (after fees)"] || "").trim();
  const targetCurrency = (row["Target currency"] || "").trim().toUpperCase();
  const sourceCurrency = (row["Source currency"] || "").trim().toUpperCase();

  // The transfer always has a source side and a target side. For an OUT
  // transfer YOUR account is the source (you send 100 EUR → recipient gets
  // 108 USD), so book the source amount/currency; for IN your account is the
  // target. Booking the recipient's side put the wrong amount on the wrong
  // per-account balance. Fall back to the other side when the preferred one is
  // blank (same-currency transfers populate both identically).
  const preferSource = direction === "OUT";
  const amountStr = preferSource
    ? sourceAmountStr || targetAmountStr
    : targetAmountStr || sourceAmountStr;
  if (!amountStr) return null;
  const amount = resolveAmount(amountStr, direction);
  if (amount === null) return null;

  // A booked-side cell that is not an ISO-4217-shaped code would break the
  // adapter output contract (and the transactions.currency CHECK) and fail the
  // whole import; skip the row like any other unparseable one instead.
  const currency = normalizeIsoCurrency(
    (preferSource
      ? sourceCurrency || targetCurrency
      : targetCurrency || sourceCurrency) || "USD",
  );
  if (currency === null) return null;

  const targetName = (row["Target name"] || "").trim();
  const sourceName = (row["Source name"] || "").trim();
  const recipientRaw =
    direction === "IN" ? sourceName || targetName : targetName || sourceName;
  const recipient = recipientRaw
    ? normalizeToUppercase(cleanRecipientName(recipientRaw))
    : "UNKNOWN";

  const reference = (row["Reference"] || "").trim();
  const category = (row["Category"] || "").trim();
  const note = (row["Note"] || "").trim();
  const memo = normalizeToUppercase(
    [reference, category, note].filter(Boolean).join(" - ") || "WISE TRANSFER",
  );

  return {
    date,
    bankAccount: `WISE ${currency}`,
    recipient,
    memo,
    amount,
    currency,
    balance: null,
    recipientAccount: null,
    recipientAddress: null,
    recipientBankName: null,
    comment: buildWiseComment(
      row,
      direction,
      sourceAmountStr,
      targetAmountStr,
      sourceCurrency,
      targetCurrency,
    ),
    rawData: rawDataForCsvRecord(row),
    sourceId: (row["ID"] || "").trim() || null,
  };
}

/**
 * @param csvSample raw head of the uploaded file
 */
export function detect(csvSample: string | null | undefined): boolean {
  if (!csvSample) return false;
  const firstLine = (csvSample.split("\n")[0] || "").toLowerCase();
  return (
    firstLine.includes("direction") &&
    firstLine.includes("target amount") &&
    firstLine.includes("source amount")
  );
}

export async function parse(filePath: string): Promise<ParsedBankTransactions> {
  const records = await parseCsvFile(filePath, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const transactions: ParsedBankTransactions = [];
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

  logger.info(
    `Wise CSV parsed: ${transactions.length} transactions, ${skipped} skipped`,
  );
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
