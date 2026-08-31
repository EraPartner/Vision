/**
 * BNP Paribas Fortis CSV adapter — Dutch-language Belgian bank statements.
 * Semicolon-delimited with a single header row. The `Bedrag` column may use
 * either a comma or a dot as decimal separator (user-selectable in the BNP
 * export UI), so `parseAmountField` is used instead of `parseCommaDecimal`.
 *
 * Columns (0-based):
 *   0  Volgnummer              sequence / reference number
 *   1  Uitvoeringsdatum        execution date           DD/MM/YYYY
 *   2  Valutadatum             value date               DD/MM/YYYY
 *   3  Bedrag                  amount (comma or dot decimal)
 *   4  Valuta rekening         account currency         (e.g. EUR)
 *   5  Rekeningnummer          own account IBAN
 *   6  Type verrichting        transaction type
 *   7  Tegenpartij             counterparty account / IBAN
 *   8  Naam van de tegenpartij counterparty name
 *   9  Mededeling              free-text message
 *  10  Details                 additional details
 *  11  Status                  transaction status
 *  12  Reden van weigering     rejection reason
 */

import {
  cleanRecipientName,
  normalizeToUppercase,
} from "../../../lib/textNormalization.js";
import { logger } from "../../../config/logger.js";
import {
  parseDayMonthYear,
  parseAmountField,
  buildOptionalComment,
  splitCsvLines,
  splitDelimitedRecord,
  canonicalIban,
  readTextWithEncodingFallback,
  normalizeIsoCurrency,
} from "./_shared.js";

/**
 * @typedef {import('./_shared.js').ParsedBankTransaction} ParsedBankTransaction
 * @typedef {import('./_shared.js').ParsedBankTransactions} ParsedBankTransactions
 */

const NAME = "bnp";
const BANK_LABEL = "BNP Paribas Fortis";
const MIN_FIELDS = 9;

/**
 * @param {string} line
 * @returns {boolean}
 */
function isHeaderLine(line) {
  return line.includes("Volgnummer") && line.includes("Uitvoeringsdatum");
}

// A rejected/cancelled row (e.g. a refused direct debit) means the money never
// moved — importing it as a real expense corrupts balances and spend totals.
// Denylist rather than "keep only executed": the status vocabulary isn't pinned
// against every BNP export variant, so an unknown status keeps the row (never
// silently drop a real transaction). NL/FR/EN refusal + cancellation stems.
const NON_EXECUTED_STATUS_RE =
  /geweiger|geannuleer|annulering|refus|annul|reject|cancel/i;

/**
 * @param {string} status the export's status column
 * @param {string} rejectionReason non-empty means the payment was refused
 * @returns {boolean}
 */
function isNonExecutedRow(status, rejectionReason) {
  if (rejectionReason) return true;
  return NON_EXECUTED_STATUS_RE.test(status);
}

/**
 * @param {string} line one ';'-delimited statement record
 * @returns {ParsedBankTransaction|null} null when too short, non-executed, or unparseable
 */
function parseLine(line) {
  const parts = splitDelimitedRecord(line);
  if (!parts || parts.length < MIN_FIELDS) return null;

  const sequenceNumber = parts[0].trim();
  const executionDateStr = parts[1].trim();
  const amountStr = parts[3].trim();
  const currency = normalizeIsoCurrency(parts[4]);
  const accountNumber = parts[5].trim();
  const transactionType = parts[6].trim();
  const counterpartyAccount = parts[7].trim();
  const counterpartyName = parts[8] ? parts[8].trim() : "";
  const message = parts[9] ? parts[9].trim() : "";
  const details = parts[10] ? parts[10].trim() : "";
  const status = parts[11] ? parts[11].trim() : "";
  const rejectionReason = parts[12] ? parts[12].trim() : "";

  if (isNonExecutedRow(status, rejectionReason)) return null;

  const date = parseDayMonthYear(executionDateStr);
  if (!date) return null;

  const amount = parseAmountField(amountStr);
  if (isNaN(amount)) return null;

  const recipientRaw = counterpartyName || transactionType || details;
  const recipient = normalizeToUppercase(cleanRecipientName(recipientRaw));
  const memo = normalizeToUppercase(transactionType || details);

  const commentParts = [];
  if (sequenceNumber) commentParts.push(`Sequence: ${sequenceNumber}`);
  if (message) commentParts.push(`Message: ${message}`);
  if (details && details !== transactionType)
    commentParts.push(`Details: ${details}`);
  if (status) commentParts.push(`Status: ${status}`);
  if (rejectionReason) commentParts.push(`Rejected: ${rejectionReason}`);

  return {
    date,
    bankAccount: canonicalIban(accountNumber) || "BNP",
    recipient,
    memo,
    amount,
    currency,
    balance: null,
    recipientAccount: counterpartyAccount || null,
    recipientAddress: null,
    recipientBankName: counterpartyAccount ? "BNP Paribas Fortis" : null,
    comment: buildOptionalComment(commentParts),
    rawData: line,
  };
}

/**
 * @param {string|null|undefined} csvSample raw head of the uploaded file
 * @returns {boolean}
 */
export function detect(csvSample) {
  if (!csvSample) return false;
  const lines = splitCsvLines(csvSample).slice(0, 3);
  return lines.some(
    (line) =>
      line.includes("Volgnummer") &&
      line.includes("Uitvoeringsdatum") &&
      line.includes("Valuta rekening"),
  );
}

/**
 * @param {string} filePath
 * @returns {Promise<ParsedBankTransactions>}
 */
export async function parse(filePath) {
  const content = await readTextWithEncodingFallback(filePath);
  const lines = splitCsvLines(content);
  const transactions = /** @type {ParsedBankTransactions} */ ([]);
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
  logger.info(
    `BNP CSV parsed: ${transactions.length} transactions, ${skipped} skipped`,
  );
  return transactions;
}

export default { name: NAME, bankName: BANK_LABEL, detect, parse };
