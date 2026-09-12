/** Saxo transaction-history CSV adapter for localized account exports. */

import { logger } from "../../config/logger.js";
import { divide, toNumber } from "../../lib/money.js";
import {
  parseAmountField,
  parseCsvFile,
  parseDateWithFormat,
  rawDataForCsvRecord,
} from "../importPipeline/adapters/_shared.js";

const REQUIRED_COLUMNS = [
  "Transactiedatum",
  "Rekening-ID",
  "Transactie-ID",
  "Bk Record Id",
  "Booking Id",
  "Transactietype",
  "Acties",
  "Boekingsbedrag",
  "Valuta",
  "Omrekeningskoers",
  "Totale kosten",
  "Instrument",
  "Instrumentsymbool",
  "Instrument ISIN",
  "Instrumentvaluta",
];

function cleanCell(value) {
  return String(value ?? "").trim();
}

function normalizeHeader(value) {
  return cleanCell(value).replaceAll("\u00a0", " ");
}

function number(value) {
  const text = cleanCell(value);
  if (!text) return null;
  const parsed = parseAmountField(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function magnitude(value) {
  const parsed = number(value);
  return parsed == null ? null : Math.abs(parsed);
}

function currency(value) {
  const code = cleanCell(value).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function instrumentSymbol(value) {
  return cleanCell(value).split(":", 1)[0].trim();
}

function date(record) {
  return parseDateWithFormat(
    cleanCell(record.Transactiedatum).replaceAll("/", "-"),
    "%Y-%m-%d",
  );
}

function sourceId(record) {
  return (
    cleanCell(record["Transactie-ID"]) ||
    cleanCell(record["Booking Id"]) ||
    cleanCell(record["Bk Record Id"]) ||
    null
  );
}

function baseRow(record, overrides) {
  return {
    date: date(record),
    typeRaw: "",
    symbolRaw: instrumentSymbol(record.Instrumentsymbool),
    nameRaw: cleanCell(record.Instrument),
    units: null,
    pricePerUnit: null,
    amount: null,
    fees: null,
    taxes: null,
    currency: currency(record.Valuta),
    fxRateToEur: null,
    note: cleanCell(record.Opmerking),
    rawData: rawDataForCsvRecord(record),
    sourceAccountIdentity: cleanCell(record["Rekening-ID"]) || null,
    sourceId: sourceId(record),
    ...overrides,
  };
}

function unsupportedRow(record, reason) {
  return baseRow(record, {
    typeRaw: `Unsupported Saxo event: ${cleanCell(record.Acties) || cleanCell(record.Transactietype) || "unknown"}`,
    amount: magnitude(record.Boekingsbedrag),
    note: reason,
  });
}

function parseTrade(record) {
  const action = cleanCell(record.Acties);
  const match = action.match(
    /^(Koop|Verkoop|Buy|Sell)\s+([+-]?[\d.,]+)\s+@\s+([+-]?[\d.,]+)(?:\s+([A-Z]{3}))?$/i,
  );
  if (!match)
    return unsupportedRow(
      record,
      "Saxo trade action could not be parsed safely",
    );

  const units = magnitude(match[2]);
  const price = magnitude(match[3]);
  const instrumentCurrency = currency(match[4] || record.Instrumentvaluta);
  if (!units || !price || !instrumentCurrency) {
    return unsupportedRow(
      record,
      "Saxo trade is missing units, price, or instrument currency",
    );
  }

  const accountCurrency = currency(record.Valuta);
  const exchangeRate = magnitude(record.Omrekeningskoers);
  const accountFees = magnitude(record["Totale kosten"]);
  const fees =
    accountFees && accountCurrency !== instrumentCurrency && exchangeRate
      ? toNumber(divide(accountFees, exchangeRate))
      : accountFees;

  return baseRow(record, {
    typeRaw: /^(koop|buy)$/i.test(match[1]) ? "Buy" : "Sell",
    units,
    pricePerUnit: price,
    amount: null,
    fees,
    currency: instrumentCurrency,
    fxRateToEur:
      accountCurrency === "EUR" && instrumentCurrency !== "EUR"
        ? exchangeRate
        : null,
    note: cleanCell(record.Opmerking) || action,
  });
}

function parseRecord(record) {
  const kind = cleanCell(record.Transactietype).toLowerCase();
  const action = cleanCell(record.Acties).toLowerCase();
  if (kind === "transactie" || kind === "trade") return parseTrade(record);

  if (kind === "storting/opname" || kind === "cash transfer") {
    if (action === "storting" || action === "deposit") {
      return baseRow(record, {
        typeRaw: "Deposit",
        symbolRaw: "",
        nameRaw: "",
        amount: magnitude(record.Boekingsbedrag),
        note: cleanCell(record.Opmerking) || "Saxo cash deposit",
      });
    }
    if (action === "opname" || action === "withdrawal") {
      return baseRow(record, {
        typeRaw: "Withdrawal",
        symbolRaw: "",
        nameRaw: "",
        amount: magnitude(record.Boekingsbedrag),
        note: cleanCell(record.Opmerking) || "Saxo cash withdrawal",
      });
    }
  }

  if (
    (kind === "corporate action" || kind === "corporateaction") &&
    (action === "cashdividend" || action === "cash dividend")
  ) {
    return baseRow(record, {
      typeRaw: "Dividend",
      amount: magnitude(record.Boekingsbedrag),
      fees: magnitude(record["Totale kosten"]),
      note: cleanCell(record.Opmerking) || "Saxo cash dividend",
    });
  }

  return unsupportedRow(record, "Unsupported Saxo transaction type");
}

/**
 * @param {string} filePath
 * @param {{ encoding?: BufferEncoding }} [config]
 * @returns {Promise<import('./portfolioGenericAdapter.js').ParsedPortfolioRows>}
 */
export async function parseSaxoTransactionHistory(filePath, config = {}) {
  const records = await parseCsvFile(
    filePath,
    {
      columns: (headers) => headers.map(normalizeHeader),
      skip_empty_lines: true,
      relax_column_count: true,
    },
    config.encoding || "utf-8",
  );
  if (records.length === 0)
    throw new Error("Saxo transaction history is empty");

  const missing = REQUIRED_COLUMNS.filter(
    (column) => !Object.prototype.hasOwnProperty.call(records[0], column),
  );
  if (missing.length > 0) {
    throw new Error(
      `Saxo transaction history is missing columns: ${missing.join(", ")}`,
    );
  }

  const rows =
    /** @type {import('./portfolioGenericAdapter.js').ParsedPortfolioRows} */ ([]);
  let skipped = 0;
  for (const record of records) {
    const parsed = parseRecord(record);
    if (!parsed?.date || Number.isNaN(parsed.date.getTime())) {
      skipped++;
      continue;
    }
    rows.push(parsed);
  }
  rows.skipped = skipped;
  logger.info(
    `Saxo transaction history parsed: ${rows.length} rows, ${skipped} source rows skipped`,
  );
  return rows;
}

export default {
  name: "saxo_transaction_history",
  parseWithConfig: parseSaxoTransactionHistory,
};
