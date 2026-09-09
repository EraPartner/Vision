/**
 * Interactive Brokers Client Portal "Transaction History" CSV adapter.
 *
 * This export is a multi-section statement, not a flat CSV. Monetary totals
 * are expressed in the statement base currency, while trade prices are in the
 * per-row Price Currency. Forex Trade Component rows are conversion details
 * for securities trades, not independent portfolio positions.
 */

import { logger } from "../../config/logger.js";
import {
  parseAmountField,
  parseCsvFile,
  parseDateWithFormat,
  rawDataForCsvRecord,
} from "../importPipeline/adapters/_shared.js";

const SECTION = "Transaction History";
const REQUIRED_COLUMNS = new Set([
  "Date",
  "Description",
  "Transaction Type",
  "Symbol",
  "Quantity",
  "Price",
  "Price Currency",
  "Gross Amount",
  "Commission",
  "Net Amount",
  "Exchange Rate",
  "Transaction Fees",
]);

function cleanCell(value) {
  const text = String(value ?? "").trim();
  return text === "-" ? "" : text;
}

function magnitude(value) {
  const text = cleanCell(value);
  if (!text) return null;
  const parsed = parseAmountField(text);
  return Number.isNaN(parsed) ? null : Math.abs(parsed);
}

function signedNumber(value) {
  const text = cleanCell(value);
  if (!text) return null;
  const parsed = parseAmountField(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function recordFrom(columns, values) {
  return Object.fromEntries(
    columns.map((column, index) => [column, String(values[index] ?? "")]),
  );
}

function findBaseCurrency(sourceRecords) {
  const row = sourceRecords.find(
    ({ values }) =>
      values[0] === "Summary" &&
      values[1] === "Data" &&
      String(values[2]).trim() === "Base Currency",
  );
  const currency = cleanCell(row?.values[3]).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function normalizeType(typeRaw, grossAmount) {
  if (typeRaw === "Foreign Tax Withholding") return "tax";
  if (typeRaw !== "Adjustment") return typeRaw;
  if (grossAmount == null || grossAmount === 0) return null;
  return grossAmount < 0 ? "Withdrawal" : "Deposit";
}

function parseTransaction(record, baseCurrency, rawData) {
  const originalType = cleanCell(record["Transaction Type"]);
  if (!originalType || originalType === "Forex Trade Component") return null;

  const grossSigned = signedNumber(record["Gross Amount"]);
  const typeRaw = normalizeType(originalType, grossSigned);
  if (!typeRaw) return null;

  const symbol = cleanCell(record.Symbol);
  const description = cleanCell(record.Description);
  const isTrade = typeRaw === "Buy" || typeRaw === "Sell";
  const priceCurrency = cleanCell(record["Price Currency"]).toUpperCase();
  const exportedFxRate = magnitude(record["Exchange Rate"]);
  const fxRateToEur = isTrade && baseCurrency === "EUR" ? exportedFxRate : null;

  const commission = magnitude(record.Commission) ?? 0;
  const transactionFees = magnitude(record["Transaction Fees"]) ?? 0;
  // Both fee columns are statement-base amounts. Portfolio transactions store
  // fees in their own currency, so convert them back when IBKR supplied the
  // base-per-price-currency rate.
  const baseFees = commission + transactionFees;
  const fees =
    isTrade && baseFees > 0 && exportedFxRate
      ? baseFees / exportedFxRate
      : baseFees || null;

  return {
    date: parseDateWithFormat(cleanCell(record.Date), "%Y-%m-%d"),
    typeRaw,
    symbolRaw: symbol,
    // IBKR's Description is event prose, not a stable instrument name. Keep it
    // out of exact-name matching for both holdings and instrument-less cash.
    nameRaw: "",
    units: magnitude(record.Quantity),
    pricePerUnit: magnitude(record.Price),
    // Trade totals in this report are base-currency values and therefore do
    // not equal units * price. Leave amount absent so the shared domain rule
    // derives the transaction-currency amount from those two source fields.
    amount: isTrade ? null : magnitude(record["Gross Amount"]),
    fees,
    taxes: null,
    currency: isTrade ? priceCurrency || null : baseCurrency,
    fxRateToEur,
    note: description,
    // Keep the literal CSV record, including its original quoting and column
    // order, like the line-aware budgeting adapters. This is retained in the
    // staging table for provenance and feeds the per-row hash.
    rawData,
    sourceAccountIdentity: cleanCell(record.Account) || null,
    sourceId: null,
  };
}

/**
 * @param {string} filePath
 * @param {{ encoding?: BufferEncoding }} [config]
 * @returns {Promise<import('./portfolioGenericAdapter.js').ParsedPortfolioRows>}
 */
export async function parseIbkrTransactionHistory(filePath, config = {}) {
  const parsedRecords = await parseCsvFile(
    filePath,
    {
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      info: true,
      raw: true,
    },
    config.encoding || "utf-8",
  );
  const sourceRecords = parsedRecords.map((record) => ({
    values: record,
    rawData: rawDataForCsvRecord(record),
  }));

  const headerIndex = sourceRecords.findIndex(
    ({ values }) => values[0] === SECTION && values[1] === "Header",
  );
  if (headerIndex < 0) {
    throw new Error('IBKR CSV is missing the "Transaction History" header');
  }

  const columns = sourceRecords[headerIndex].values
    .slice(2)
    .map((column) => String(column).trim());
  const missing = [...REQUIRED_COLUMNS].filter(
    (column) => !columns.includes(column),
  );
  if (missing.length > 0) {
    throw new Error(
      `IBKR Transaction History is missing columns: ${missing.join(", ")}`,
    );
  }

  const baseCurrency = findBaseCurrency(sourceRecords);
  if (!baseCurrency) {
    throw new Error("IBKR CSV is missing a valid Summary base currency");
  }

  const rows =
    /** @type {import('./portfolioGenericAdapter.js').ParsedPortfolioRows} */ ([]);
  let skipped = 0;
  for (const { values, rawData } of sourceRecords.slice(headerIndex + 1)) {
    if (values[0] !== SECTION || values[1] !== "Data") continue;
    const parsed = parseTransaction(
      recordFrom(columns, values.slice(2)),
      baseCurrency,
      rawData,
    );
    if (!parsed?.date || Number.isNaN(parsed.date.getTime())) {
      skipped++;
      continue;
    }
    rows.push(parsed);
  }
  rows.skipped = skipped;
  logger.info(
    `IBKR Transaction History parsed: ${rows.length} rows, ${skipped} skipped`,
  );
  return rows;
}

export default {
  name: "ibkr_transaction_history",
  parseWithConfig: parseIbkrTransactionHistory,
};
