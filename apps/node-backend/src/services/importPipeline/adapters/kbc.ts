/**
 * KBC CSV adapter — Belgian bank, ';'-separated with 15+ columns.
 */

import {
  cleanKbcRecipientName,
  normalizeToUppercase,
} from "../../../lib/textNormalization.ts";
import { logger } from "../../../config/logger.ts";
import {
  parseDayMonthYear,
  parseCommaDecimal,
  buildOptionalComment,
  splitCsvLines,
  parseCsvText,
  rawDataForCsvRecord,
  canonicalIban,
  readTextWithEncodingFallback,
  normalizeIsoCurrency,
  cellAt,
} from "./_shared.ts";
import type {
  ParsedBankTransaction,
  ParsedBankTransactions,
} from "./_shared.ts";

const NAME = "kbc";
const BANK_LABEL = "KBC";
const MIN_FIELDS = 15;

/**
 * @returns null when neither column holds a non-zero amount
 */
function classifyTransactionType(
  creditStr: string | undefined,
  debitStr: string | undefined,
): "CREDIT" | "DEBIT" | null {
  if (creditStr && creditStr.trim()) {
    const cv = parseCommaDecimal(creditStr);
    if (!isNaN(cv) && Math.abs(cv) > 0) return "CREDIT";
  }
  if (debitStr && debitStr.trim()) {
    const dv = parseCommaDecimal(debitStr);
    if (!isNaN(dv) && Math.abs(dv) > 0) return "DEBIT";
  }
  return null;
}

/**
 * @param parts one ';'-delimited statement record
 * @returns null when too short or unparseable
 */
function parseLine(parts: string[]): ParsedBankTransaction | null {
  if (!parts || parts.length < MIN_FIELDS) return null;

  const ownAccount = cellAt(parts, 0).trim(); // "Rekeningnummer" — the account holder's own IBAN
  const currency = normalizeIsoCurrency(parts[3]);
  const statementNumber = cellAt(parts, 4).trim();
  const transactionDateStr = cellAt(parts, 5).trim();
  const description = cellAt(parts, 6).trim();
  const amountStr = cellAt(parts, 8).trim();
  const balanceStr = cellAt(parts, 9).trim();
  const creditStr = cellAt(parts, 10).trim();
  const debitStr = cellAt(parts, 11).trim();
  const counterpartyAccount = cellAt(parts, 12).trim();
  const counterpartyBic = cellAt(parts, 13).trim();
  const counterpartyName = cellAt(parts, 14).trim();
  const counterpartyAddress = parts[15] ? parts[15].trim() : "";
  const structuredCommunication = parts[16] ? parts[16].trim() : "";
  const freeCommunication = parts[17] ? parts[17].trim() : "";

  const date = parseDayMonthYear(transactionDateStr);
  if (!date) return null;

  const amount = parseCommaDecimal(amountStr);
  if (isNaN(amount)) return null;

  const balance = balanceStr ? parseCommaDecimal(balanceStr) : null;
  const transactionType = classifyTransactionType(creditStr, debitStr);

  let fullRecipient = counterpartyName || description;
  if (!counterpartyName) fullRecipient = cleanKbcRecipientName(fullRecipient);
  fullRecipient = normalizeToUppercase(fullRecipient);

  const memo = description ? normalizeToUppercase(description) : "";

  const commentParts = [];
  if (statementNumber)
    commentParts.push(`Statement: ${statementNumber.trim()}`);
  if (transactionType) commentParts.push(`Type: ${transactionType}`);
  if (counterpartyBic) commentParts.push(`BIC: ${counterpartyBic}`);
  if (structuredCommunication)
    commentParts.push(`Structured: ${structuredCommunication}`);
  if (freeCommunication) commentParts.push(`Free: ${freeCommunication}`);

  return {
    date,
    bankAccount: canonicalIban(ownAccount) || "KBC",
    recipient: fullRecipient,
    memo,
    amount,
    currency,
    balance: balance !== null && !isNaN(balance) ? balance : null,
    recipientAccount: counterpartyAccount || null,
    recipientAddress: counterpartyAddress || null,
    recipientBankName: counterpartyAccount ? "KBC" : null,
    comment: buildOptionalComment(commentParts),
    rawData: rawDataForCsvRecord(parts),
  };
}

function isNonDataLine(line: string): boolean {
  return (
    line.startsWith("Rekeningnummer") ||
    line.includes("Vrije Mededeling") ||
    line.startsWith(",,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,")
  );
}

/**
 * @param csvSample raw head of the uploaded file
 */
export function detect(csvSample: string | null | undefined): boolean {
  if (!csvSample) return false;
  const lines = splitCsvLines(csvSample).slice(0, 5);
  return (
    lines.some((line) => line.startsWith("Rekeningnummer")) ||
    lines.some((line) => line.includes("Vrije Mededeling"))
  );
}

export async function parse(filePath: string): Promise<ParsedBankTransactions> {
  const content = await readTextWithEncodingFallback(filePath);
  let malformed = 0;
  const records = parseCsvText<string[]>(content, {
    delimiter: ";",
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_records_with_error: true,
    on_skip: () => {
      malformed++;
    },
  });
  const transactions: ParsedBankTransactions = [];
  let skipped = malformed;

  for (const parts of records) {
    const line = rawDataForCsvRecord(parts).trim();
    if (isNonDataLine(line)) continue;
    const tx = parseLine(parts);
    if (tx) transactions.push(tx);
    else skipped++;
  }

  transactions.skipped = skipped;
  logger.info(
    `KBC CSV parsed: ${transactions.length} transactions, ${skipped} skipped`,
  );
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
