/**
 * Belfius CSV adapter — Dutch-language Belgian bank statements.
 * Statement-export format: 13 header lines, then ';'-delimited transactions.
 */

import {
  cleanRecipientName,
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
import { toDecimal, roundMoney } from "../../../lib/money.ts";

/** Belfius rows carry their export sequence until applyRunningBalances runs. */
type SequencedBankTransaction = ParsedBankTransaction & {
  _seq: [number, number];
};

const NAME = "belfius";
const BANK_LABEL = "Belfius";
const HEADER_ROWS = 13;
const BALANCE_LINE_INDEX = 9;
const MIN_FIELDS = 12;

/**
 * @param line the statement's "Laatste saldo;" header line
 */
function parseLastBalance(line: string): number | null {
  if (!line.includes("Laatste saldo;")) return null;
  const parts = line.split(";");
  if (parts.length < 2) return null;
  // "12.345,67 EUR" — a bare comma swap left "12.345.67" (NaN), so running
  // balances silently never applied for balances ≥ €1000.
  const balStr = cellAt(parts, 1).replace(" EUR", "").trim();
  const val = parseCommaDecimal(balStr);
  return isNaN(val) ? null : val;
}

/**
 * Walk the statement's closing balance backwards over the rows, stamping each
 * one's `balance`. Mutates `transactions` in place.
 */
function applyRunningBalances(
  transactions: SequencedBankTransaction[],
  lastBalance: number | null,
): void {
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
      (a, b) => b._seq[0] - a._seq[0] || b._seq[1] - a._seq[1],
    );
  } else {
    // Non-empty: the early return above covers an empty statement.
    const first = transactions[0];
    const last = transactions.at(-1);
    const isDescending =
      first !== undefined && last !== undefined && first.date >= last.date;
    newestToOldest = isDescending
      ? [...transactions]
      : [...transactions].reverse();
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
 * @param parts one ';'-delimited statement record
 * @returns null when the line is too short or unparseable
 */
function parseTransactionLine(
  parts: string[],
): SequencedBankTransaction | null {
  if (!parts || parts.length < MIN_FIELDS) return null;

  const accountNumber = cellAt(parts, 0).trim();
  const transactionDateStr = cellAt(parts, 1).trim();
  const statementNumber = cellAt(parts, 2).trim();
  const transactionNumber = cellAt(parts, 3).trim();
  const recipientAccount = cellAt(parts, 4).trim();
  const recipientName = cellAt(parts, 5).trim();
  const street = cellAt(parts, 6).trim();
  const location = cellAt(parts, 7).trim();
  const transactionDescription = cellAt(parts, 8).trim();
  const amountStr = cellAt(parts, 10).trim();
  const currency = normalizeIsoCurrency(parts[11]);
  const bicCode = parts[12] ? parts[12].trim() : "";
  const countryCode = parts[13] ? parts[13].trim() : "";
  const additionalMessage = parts[14] ? parts[14].trim() : "";

  const date = parseDayMonthYear(transactionDateStr);
  if (!date) return null;

  const amount = parseCommaDecimal(amountStr);
  if (isNaN(amount)) return null;

  const baseRecipient = recipientName || transactionDescription;
  const fullRecipient = normalizeToUppercase(cleanRecipientName(baseRecipient));

  const addressParts = [street, location].filter(Boolean);
  const recipientFullAddress = addressParts.length
    ? addressParts.join(", ")
    : null;
  const memo = transactionDescription
    ? normalizeToUppercase(transactionDescription)
    : "";

  const commentParts = [];
  if (statementNumber) commentParts.push(`Statement: ${statementNumber}`);
  if (transactionNumber) commentParts.push(`Transaction: ${transactionNumber}`);
  if (bicCode) commentParts.push(`BIC: ${bicCode}`);
  if (countryCode) commentParts.push(`Country: ${countryCode}`);
  if (additionalMessage) commentParts.push(additionalMessage);

  return {
    date,
    bankAccount: canonicalIban(accountNumber) || "BELFIUS",
    recipient: fullRecipient,
    memo,
    amount,
    currency,
    balance: null,
    recipientAccount: recipientAccount || null,
    recipientAddress: recipientFullAddress,
    recipientBankName: recipientAccount ? "BELFIUS" : null,
    comment: buildOptionalComment(commentParts),
    rawData: rawDataForCsvRecord(parts),
    // Statement/transaction counters are not proven globally immutable across
    // export periods, so they remain descriptive fields rather than identity.
    sourceId: null,
    // Statement + transaction number: the export's own ordering, used (and
    // stripped again) by applyRunningBalances.
    _seq: [
      Number.parseInt(statementNumber, 10),
      Number.parseInt(transactionNumber, 10),
    ],
  };
}

/**
 * @param csvSample raw head of the uploaded file
 */
export function detect(csvSample: string | null | undefined): boolean {
  if (!csvSample) return false;
  const lines = splitCsvLines(csvSample).slice(0, 15);
  return (
    lines.some((line) => line.includes("Laatste saldo;")) ||
    lines.some(
      (line) =>
        /^BE\d{2}/.test(line.trim()) && line.split(";").length >= MIN_FIELDS,
    )
  );
}

export async function parse(filePath: string): Promise<ParsedBankTransactions> {
  const content = await readTextWithEncodingFallback(filePath);
  const lines = splitCsvLines(content);
  let malformed = 0;
  const records = parseCsvText<string[]>(content, {
    delimiter: ";",
    from_line: HEADER_ROWS + 1,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_records_with_error: true,
    on_skip: () => {
      malformed++;
    },
  });
  const transactions: SequencedBankTransaction[] = [];
  const balanceLine = lines[BALANCE_LINE_INDEX];
  const lastBalance =
    balanceLine !== undefined ? parseLastBalance(balanceLine.trim()) : null;

  let skipped = malformed;
  for (const parts of records) {
    const tx = parseTransactionLine(parts);
    if (tx) {
      transactions.push(tx);
    } else {
      skipped++;
    }
  }

  applyRunningBalances(transactions, lastBalance);
  // The same array, now viewed without the sequence it is about to lose.
  const parsed: ParsedBankTransactions = transactions;
  for (const tx of parsed) delete tx._seq;
  parsed.skipped = skipped;
  logger.info(
    `Belfius CSV parsed: ${parsed.length} transactions, ${skipped} skipped`,
  );
  return parsed;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
