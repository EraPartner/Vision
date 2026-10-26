/**
 * Interactive Brokers Client Portal "Transaction History" CSV adapter.
 *
 * This export is a multi-section statement, not a flat CSV. Monetary totals
 * are expressed in the statement base currency, while trade prices are in the
 * per-row Price Currency. Forex Trade Component rows are fiat conversion
 * details, not independent portfolio positions. Their explicit
 * commissions are separate base-currency cash expenses.
 */

import { readFile } from "node:fs/promises";
import { logger } from "../../config/logger.ts";
import { Decimal, toDecimal } from "../../lib/money.ts";
import {
  decodeCsvBuffer,
  parseCsvText,
  parseCustomAmount,
  parseDateWithFormat,
  rawDataForCsvRecord,
} from "../importPipeline/adapters/_shared.ts";
import type {
  ParsedPortfolioRow,
  ParsedPortfolioRows,
} from "./portfolioGenericAdapter.ts";
import { cellText } from "../cellText.ts";

/** One statement line: its csv-parse tuple and literal source record. */
type SourceRecord = { values: string[]; rawData: string };

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

function cleanCell(value: unknown): string {
  const text = cellText(value).trim();
  return text === "-" ? "" : text;
}

/**
 * An IBKR statement number. IBKR writes a decimal point and comma thousands
 * (`1,500` is fifteen hundred); a cell that is only valid with a decimal
 * comma (`4,25`, `1.234,56`) has a single reading and keeps it.
 */
export function ibkrNumber(value: unknown): number | null {
  const text = cleanCell(value);
  if (!text) return null;
  const dot = parseCustomAmount(text, "decimal_dot");
  if (Number.isFinite(dot)) return dot;
  const comma = parseCustomAmount(text, "decimal_comma");
  return Number.isFinite(comma) ? comma : null;
}

function magnitude(value: unknown): number | null {
  const parsed = ibkrNumber(value);
  return parsed == null ? null : Math.abs(parsed);
}

function signedNumber(value: unknown): number | null {
  return ibkrNumber(value);
}

/**
 * A trade's quantity × price × multiplier × exchange rate must explain its
 * base-currency Gross Amount within 1 % (at least 0.01). A misread quantity
 * fails by orders of magnitude. Without a gross amount or a rate between two
 * currencies, nothing can be compared.
 */
function grossAgrees(
  record: Record<string, string>,
  baseCurrency: string,
  priceCurrency: string,
): boolean {
  const units = magnitude(record.Quantity);
  const price = magnitude(record.Price);
  const gross = magnitude(record["Gross Amount"]);
  const rate =
    priceCurrency === baseCurrency ? 1 : magnitude(record["Exchange Rate"]);
  if (
    units == null ||
    price == null ||
    gross == null ||
    gross === 0 ||
    rate == null ||
    rate === 0
  )
    return true;
  const exportedMultiplier = magnitude(record.Multiplier);
  const multiplier =
    exportedMultiplier == null || exportedMultiplier === 0
      ? 1
      : exportedMultiplier;
  const value = toDecimal(units).times(price).times(multiplier).times(rate);
  return value
    .minus(gross)
    .abs()
    .lte(Decimal.max("0.01", value.times("0.01")));
}

function recordFrom(
  columns: string[],
  values: string[],
): Record<string, string> {
  return Object.fromEntries(
    columns.map((column, index) => [column, values[index] ?? ""]),
  );
}

function findBaseCurrency(
  sourceRecords: SourceRecord[],
):
  | { currency: string; row: SourceRecord }
  | { currency: null; row: SourceRecord | undefined } {
  const records = sourceRecords.filter(
    ({ values }) =>
      values[0] === "Summary" &&
      values[1] === "Data" &&
      String(values[2]).trim() === "Base Currency",
  );
  if (records.length > 1) {
    throw new Error("IBKR CSV has multiple Summary base currency records");
  }
  const row = records[0];
  const currency = cleanCell(row?.values[3]).toUpperCase();
  // A valid code can only come from an existing Summary record.
  return row && /^[A-Z]{3}$/.test(currency)
    ? { currency, row }
    : { currency: null, row };
}

function normalizeType(
  typeRaw: string,
  grossAmount: number | null,
): string | null {
  if (typeRaw === "Foreign Tax Withholding") return "tax";
  if (typeRaw !== "Adjustment") return typeRaw;
  if (grossAmount == null || grossAmount === 0) return null;
  return grossAmount < 0 ? "Withdrawal" : "Deposit";
}

function parseTransaction(
  record: Record<string, string>,
  baseCurrency: string,
  rawData: string,
): ParsedPortfolioRow | null {
  const originalType = cleanCell(record["Transaction Type"]);
  if (!originalType) return null;
  const description = cleanCell(record.Description);
  if (originalType === "Forex Trade Component") {
    const charge = (column: string): number => {
      const text = cleanCell(record[column]);
      const value = text ? signedNumber(text) : 0;
      if (value == null || !Number.isFinite(value) || value > 0)
        throw new Error(
          `IBKR Forex Trade Component has an unsupported ${column}`,
        );
      return -value;
    };
    const amount = charge("Commission") + charge("Transaction Fees");
    if (amount === 0) return null;
    return {
      date: parseDateWithFormat(cleanCell(record.Date), "%Y-%m-%d"),
      typeRaw: "Fee",
      symbolRaw: "",
      nameRaw: "",
      units: null,
      pricePerUnit: null,
      amount,
      fees: null,
      taxes: null,
      currency: baseCurrency,
      fxRateToEur: null,
      note: `${description} (FX commission)`,
      rawData,
      sourceAccountIdentity: cleanCell(record.Account) || null,
      sourceId: null,
    };
  }
  // This adjustment reports a base-currency valuation change, not cash.
  if (originalType === "Adjustment" && description === "FX Translations P&L")
    return null;

  const grossSigned = signedNumber(record["Gross Amount"]);
  const typeRaw = normalizeType(originalType, grossSigned);
  if (!typeRaw) return null;

  const symbol = cleanCell(record.Symbol);
  const isTrade = typeRaw === "Buy" || typeRaw === "Sell";
  const priceCurrency = cleanCell(record["Price Currency"]).toUpperCase();
  const exportedFxRate = magnitude(record["Exchange Rate"]);
  if (isTrade && !grossAgrees(record, baseCurrency, priceCurrency))
    return {
      date: parseDateWithFormat(cleanCell(record.Date), "%Y-%m-%d"),
      typeRaw: `Unsupported IBKR event: ${originalType}`,
      symbolRaw: symbol,
      nameRaw: "",
      units: null,
      pricePerUnit: null,
      amount: magnitude(record["Gross Amount"]),
      fees: null,
      taxes: null,
      currency: baseCurrency,
      fxRateToEur: null,
      note: `IBKR ${originalType} of ${cleanCell(record.Quantity)} @ ${cleanCell(record.Price)} does not agree with its Gross Amount; check the quantity and price before importing`,
      rawData,
      sourceAccountIdentity: cleanCell(record.Account) || null,
      sourceId: null,
    };
  const fxRateToEur = isTrade && baseCurrency === "EUR" ? exportedFxRate : null;

  const commission = magnitude(record.Commission) ?? 0;
  const transactionFees = magnitude(record["Transaction Fees"]) ?? 0;
  // Both fee columns are statement-base amounts. Portfolio transactions store
  // fees in their own currency, so convert them back when IBKR supplied the
  // base-per-price-currency rate.
  const baseFees = commission + transactionFees;
  const fees =
    isTrade && baseFees > 0 && exportedFxRate != null && exportedFxRate !== 0
      ? baseFees / exportedFxRate
      : baseFees !== 0
        ? baseFees
        : null;

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

export async function parseIbkrTransactionHistory(
  filePath: string,
  config: { encoding?: string } = {},
): Promise<ParsedPortfolioRows> {
  const sourceBytes = await readFile(filePath);
  const parsedRecords: string[][] = parseCsvText(
    decodeCsvBuffer(sourceBytes, config.encoding || "utf-8"),
    {
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      info: true,
      raw: true,
    },
  );
  const sourceRecords = parsedRecords.map((record): SourceRecord => ({
    values: record,
    rawData: rawDataForCsvRecord(record),
  }));

  const headers = sourceRecords.filter(
    ({ values }) => values[0] === SECTION && values[1] === "Header",
  );
  if (headers.length === 0) {
    throw new Error('IBKR CSV is missing the "Transaction History" header');
  }
  if (headers.length > 1) {
    throw new Error('IBKR CSV has multiple "Transaction History" headers');
  }
  const [header] = headers;
  if (!header) {
    throw new Error('IBKR CSV is missing the "Transaction History" header');
  }
  const headerIndex = sourceRecords.indexOf(header);

  const columns = header.values.slice(2).map((column) => column.trim());
  if (columns.some((column) => !column)) {
    throw new Error("IBKR Transaction History has blank column names");
  }
  if (new Set(columns).size !== columns.length) {
    throw new Error("IBKR Transaction History has duplicate column names");
  }
  const missing = [...REQUIRED_COLUMNS].filter(
    (column) => !columns.includes(column),
  );
  if (missing.length > 0) {
    throw new Error(
      `IBKR Transaction History is missing columns: ${missing.join(", ")}`,
    );
  }

  const base = findBaseCurrency(sourceRecords);
  if (!base.currency) {
    throw new Error("IBKR CSV is missing a valid Summary base currency");
  }
  const { currency: baseCurrency } = base;

  const rows: ParsedPortfolioRows = [];
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
  rows.sourceColumns = columns;
  logger.info(
    `IBKR Transaction History parsed: ${rows.length} rows, ${skipped} skipped`,
  );
  return rows;
}
