/** Saxo transaction-history adapter for localized CSV and detailed XLSX exports. */

import { logger } from "../../config/logger.js";
import { divide, toDecimal, toNumber } from "../../lib/money.js";
import {
  detectPortfolioFileFormat,
  readPortfolioWorkbook,
} from "../../lib/portfolioUpload.js";
import { ValidationError } from "../../middleware/errorHandler.js";
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

const RECORD_METADATA = new WeakMap();
const ID_COLUMNS = [
  "Rekening-ID",
  "Transactie-ID",
  "Bk Record Id",
  "Booking Id",
  "Corporate action-Id",
  "Positie-ID",
  "Order-ID",
];
const JOIN_COLUMNS = ["Rekening-ID", "Bk Record Id"];
const DETAIL_COLUMNS = [
  ...JOIN_COLUMNS,
  "Transactie-ID",
  "Corporate action-Id",
  "Acties",
  "Instrument",
  "Instrumentsymbool",
  "Instrument ISIN",
  "Instrumentvaluta",
];
const BOOKING_COLUMNS = [
  ...DETAIL_COLUMNS,
  "Booking Id",
  "Amount Type",
  "Boekingsbedrag",
  "Omrekeningskoers",
];
const TRADE_COLUMNS = [
  ...DETAIL_COLUMNS,
  "Traded Quantity",
  "Prijs",
  "Verhandelde waarde",
];

function cleanCell(value) {
  if (value?.type === "number") return value.raw.trim();
  return String(value ?? "").trim();
}

function normalizeHeader(value) {
  return cleanCell(value).replaceAll("\u00a0", " ");
}

function number(value) {
  const text = cleanCell(value);
  if (!text) return null;
  const parsed = parseAmountField(text);
  return Number.isFinite(parsed) ? parsed : null;
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
  if (record.Transactiedatum instanceof Date) {
    const value = record.Transactiedatum;
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }
  return parseDateWithFormat(
    cleanCell(record.Transactiedatum).replaceAll("/", "-"),
    "%Y-%m-%d",
  );
}

function sourceId(record) {
  const immutableId = (value) => {
    const text = cleanCell(value);
    return text && !/^0+$/.test(text) ? text : "";
  };
  return (
    immutableId(record["Bk Record Id"]) ||
    immutableId(record["Transactie-ID"]) ||
    immutableId(record["Booking Id"]) ||
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
    rawData: RECORD_METADATA.has(record)
      ? workbookProvenance([record])
      : rawDataForCsvRecord(record),
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
      typeRaw: "Unsupported Saxo event: Cashdividend",
      amount: magnitude(record.Boekingsbedrag),
      fees: magnitude(record["Totale kosten"]),
      note: "Saxo CSV dividend contains only a net booking amount. Import the detailed XLSX workbook to retain gross dividends and withholding taxes.",
    });
  }

  return unsupportedRow(record, "Unsupported Saxo transaction type");
}

/** @param {object[]} records */
function workbookProvenance(records) {
  return JSON.stringify({
    format: "saxo_xlsx_v1",
    sourceFileHash: RECORD_METADATA.get(records[0]).sourceFileHash,
    records: records.map((record) => {
      const metadata = RECORD_METADATA.get(record);
      return {
        sheet: metadata.sheet,
        row: metadata.row,
        headers: metadata.headers,
        cells: metadata.cells.map((cell) =>
          cell instanceof Date
            ? { type: "date", value: cell.toISOString() }
            : cell,
        ),
      };
    }),
  });
}

/** @param {import('../../lib/portfolioUpload.js').PortfolioWorkbookSheet} sheet @param {string[]} required */
function workbookRecords(sheet, required) {
  const [rawHeaders, ...data] = sheet.data;
  if (!rawHeaders)
    throw new ValidationError(`Saxo ${sheet.sheet} sheet is empty`);
  const headers = rawHeaders.map(normalizeHeader);
  if (new Set(headers).size !== headers.length)
    throw new ValidationError(
      `Saxo ${sheet.sheet} sheet has ambiguous duplicate headers`,
    );
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length)
    throw new ValidationError(
      `Saxo ${sheet.sheet} sheet is missing columns: ${missing.join(", ")}`,
    );
  return data.flatMap((cells, index) => {
    if (cells.every((value) => value == null || value === "")) return [];
    const record = Object.fromEntries(
      headers.map((header, column) => [header, cells[column] ?? null]),
    );
    for (const column of ID_COLUMNS) {
      const value = record[column];
      if (
        value?.type === "number" &&
        (!/^\d+$/.test(value.raw) || !Number.isSafeInteger(Number(value.raw)))
      ) {
        throw new ValidationError(
          `Saxo ${sheet.sheet} row ${index + 2} has an unsafe numeric identifier in ${column}`,
        );
      }
    }
    RECORD_METADATA.set(record, {
      sheet: sheet.sheet,
      row: index + 2,
      headers: rawHeaders,
      cells,
      sourceFileHash: sheet.sourceFileHash,
    });
    return [record];
  });
}

function joinKey(record) {
  const fields = JOIN_COLUMNS.map((column) => cleanCell(record[column]));
  if (fields.some((field) => !field || /^0+$/.test(field)))
    throw new ValidationError(
      "Saxo workbook contains a missing booking record or account identity",
    );
  return JSON.stringify(fields);
}

function assertClose(actual, expected, reason) {
  if (
    actual == null ||
    expected == null ||
    toDecimal(actual).minus(expected).abs().gt("0.01")
  )
    throw new ValidationError(reason);
}

function assertEqualNumber(actual, expected, reason) {
  if (actual == null || expected == null || !toDecimal(actual).eq(expected))
    throw new ValidationError(reason);
}

function sumBookings(records) {
  return records.reduce((sum, record) => {
    const amount = number(record.Boekingsbedrag);
    if (amount == null)
      throw new ValidationError(
        "Saxo workbook contains an invalid booking amount",
      );
    return sum.plus(amount);
  }, toDecimal(0));
}

function amountKind(record) {
  const kind = cleanCell(record["Amount Type"]).toLowerCase();
  if (kind === "aandeelbedrag" || kind === "share amount") return "principal";
  if (kind === "commissie" || kind === "commission") return "fee";
  if (/^beurstaks\b/.test(kind) || /^exchange tax\b/.test(kind)) return "tax";
  if (
    kind === "corporate actions - cash dividenden" ||
    kind === "corporate actions - cash dividends"
  )
    return "dividend";
  if (
    kind === "corporate actions - bronbelasting" ||
    kind === "corporate actions - roerende voorheffing" ||
    kind === "corporate actions - withholding tax" ||
    kind === "corporate actions - belgian withholding tax"
  )
    return "tax";
  if (kind === "cashbedrag" || kind === "cash amount") return "cash";
  return "unknown";
}

function parseWorkbookRecord(record, bookings, trades) {
  const parsed = parseRecord(record);
  const kind = cleanCell(record.Transactietype).toLowerCase();
  const action = cleanCell(record.Acties).toLowerCase();
  const accountCurrency = currency(record.Valuta);
  if (!accountCurrency || !parsed.date || Number.isNaN(parsed.date.getTime()))
    throw new ValidationError(
      "Saxo workbook contains an invalid transaction date or account currency",
    );
  if (bookings.length === 0)
    throw new ValidationError(
      "Saxo workbook transaction is missing booking details",
    );
  assertClose(
    sumBookings(bookings),
    number(record.Boekingsbedrag),
    "Saxo workbook booking details do not reconcile to the transaction net amount",
  );
  for (const booking of bookings) {
    if (
      DETAIL_COLUMNS.some(
        (column) => cleanCell(booking[column]) !== cleanCell(record[column]),
      )
    )
      throw new ValidationError(
        "Saxo workbook booking details conflict with their transaction",
      );
    assertEqualNumber(
      number(booking.Omrekeningskoers),
      number(record.Omrekeningskoers),
      "Saxo workbook booking details use inconsistent exchange rates",
    );
  }
  const buckets = new Map();
  for (const booking of bookings) {
    const key = amountKind(booking);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(booking);
  }
  const entries = (key) => buckets.get(key) || [];
  const magnitudeSum = (key) => toNumber(sumBookings(entries(key)).abs());
  const base = {
    ...parsed,
    rawData: workbookProvenance([record, ...trades, ...bookings]),
    currency: accountCurrency,
    fxRateToEur: null,
  };
  if (buckets.has("unknown"))
    return {
      ...base,
      typeRaw: "Unsupported Saxo event: booking detail",
      note: "Saxo workbook contains an unsupported booking amount type",
    };

  if (kind === "transactie" || kind === "trade") {
    if (
      trades.length !== 1 ||
      entries("principal").length !== 1 ||
      [...buckets.keys()].some(
        (key) => !["principal", "fee", "tax"].includes(key),
      )
    ) {
      throw new ValidationError(
        "Saxo workbook trade details are missing or ambiguous",
      );
    }
    const trade = trades[0];
    if (
      DETAIL_COLUMNS.some(
        (column) => cleanCell(trade[column]) !== cleanCell(record[column]),
      )
    )
      throw new ValidationError(
        "Saxo workbook execution details conflict with their transaction",
      );
    const units = magnitude(trade["Traded Quantity"]);
    const nativePrice = magnitude(trade.Prijs);
    const nativeGross = magnitude(trade["Verhandelde waarde"]);
    if (
      !units ||
      !nativePrice ||
      !nativeGross ||
      !["Buy", "Sell"].includes(parsed.typeRaw)
    )
      throw new ValidationError(
        "Saxo workbook trade contains invalid execution details",
      );
    assertEqualNumber(
      units,
      parsed.units,
      "Saxo workbook trade quantities do not agree",
    );
    assertEqualNumber(
      nativePrice,
      parsed.pricePerUnit,
      "Saxo workbook trade quoted prices do not agree",
    );
    const rate = magnitude(record.Omrekeningskoers);
    if (!rate)
      throw new ValidationError(
        "Saxo workbook trade is missing its exchange rate",
      );
    const principal = number(entries("principal")[0].Boekingsbedrag);
    if (
      (parsed.typeRaw === "Buy" && principal >= 0) ||
      (parsed.typeRaw === "Sell" && principal <= 0) ||
      [...entries("fee"), ...entries("tax")].some(
        (entry) => number(entry.Boekingsbedrag) > 0,
      )
    ) {
      throw new ValidationError(
        "Saxo workbook trade booking signs are inconsistent",
      );
    }
    assertClose(
      magnitudeSum("principal"),
      toDecimal(nativeGross).times(rate),
      "Saxo workbook trade principal does not reconcile to its execution value",
    );
    const gross = magnitudeSum("principal");
    return {
      ...base,
      units,
      pricePerUnit: toNumber(divide(gross, units)),
      amount: gross,
      fees: magnitudeSum("fee"),
      taxes: magnitudeSum("tax"),
    };
  }
  if (
    (kind === "corporate action" || kind === "corporateaction") &&
    (action === "cashdividend" || action === "cash dividend")
  ) {
    if (
      trades.length ||
      entries("dividend").length !== 1 ||
      [...buckets.keys()].some(
        (key) => !["dividend", "tax", "fee"].includes(key),
      ) ||
      number(entries("dividend")[0].Boekingsbedrag) <= 0 ||
      [...entries("tax"), ...entries("fee")].some(
        (entry) => number(entry.Boekingsbedrag) > 0,
      )
    ) {
      throw new ValidationError(
        "Saxo workbook dividend details are missing or inconsistent",
      );
    }
    return {
      ...base,
      typeRaw: "Dividend",
      amount: magnitudeSum("dividend"),
      fees: magnitudeSum("fee"),
      taxes: magnitudeSum("tax"),
      note: cleanCell(record.Opmerking) || "Saxo cash dividend",
    };
  }
  if (["Deposit", "Withdrawal"].includes(parsed.typeRaw)) {
    if (
      trades.length ||
      bookings.length !== 1 ||
      entries("cash").length !== 1 ||
      (parsed.typeRaw === "Deposit" && number(record.Boekingsbedrag) <= 0) ||
      (parsed.typeRaw === "Withdrawal" && number(record.Boekingsbedrag) >= 0)
    ) {
      throw new ValidationError(
        "Saxo workbook cash details are ambiguous or inconsistent",
      );
    }
    return base;
  }
  return base;
}

/** @param {string|URL} filePath */
async function parseWorkbook(filePath) {
  const sheets = await readPortfolioWorkbook(filePath);
  const table = (name, columns) => {
    const matches = sheets.filter((sheet) => sheet.sheet === name);
    if (matches.length !== 1)
      throw new ValidationError(
        `Saxo XLSX workbook requires one ${name} sheet`,
      );
    return workbookRecords(matches[0], columns);
  };
  const main = table("Transacties", REQUIRED_COLUMNS);
  const trades = table("_Transacties", TRADE_COLUMNS);
  const bookings = table("Bookings", BOOKING_COLUMNS);
  if (main.length === 0)
    throw new ValidationError("Saxo transaction history is empty");
  const groups = new Map();
  for (const record of main) {
    const key = joinKey(record);
    if (groups.has(key))
      throw new ValidationError(
        "Saxo workbook has ambiguous duplicate transaction booking records",
      );
    groups.set(key, { record, trades: [], bookings: [] });
  }
  const bookingIds = new Set();
  for (const { records, target } of [
    { records: trades, target: "trades" },
    { records: bookings, target: "bookings" },
  ]) {
    for (const record of records) {
      const key = joinKey(record);
      const group = groups.get(key);
      if (!group)
        throw new ValidationError(
          "Saxo workbook contains an orphaned detail record",
        );
      if (target === "bookings") {
        const id = JSON.stringify([
          cleanCell(record["Rekening-ID"]),
          cleanCell(record["Booking Id"]),
        ]);
        if (!cleanCell(record["Booking Id"]) || bookingIds.has(id))
          throw new ValidationError(
            "Saxo workbook has duplicate or missing booking detail identifiers",
          );
        bookingIds.add(id);
      }
      group[target].push(record);
    }
  }
  const rows =
    /** @type {import('./portfolioGenericAdapter.js').ParsedPortfolioRows} */ (
      [...groups.values()].map(
        ({ record, trades: execution, bookings: details }) =>
          parseWorkbookRecord(record, details, execution),
      )
    );
  rows.skipped = 0;
  return rows;
}

/**
 * @param {string} filePath
 * @param {{ encoding?: string }} [config]
 * @returns {Promise<import('./portfolioGenericAdapter.js').ParsedPortfolioRows>}
 */
export async function parseSaxoTransactionHistory(filePath, config = {}) {
  if ((await detectPortfolioFileFormat(filePath)) === "xlsx")
    return parseWorkbook(filePath);
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
