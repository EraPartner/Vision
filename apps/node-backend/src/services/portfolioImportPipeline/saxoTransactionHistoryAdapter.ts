/** Saxo transaction-history adapter for localized CSV and detailed XLSX exports. */

import { logger } from "../../config/logger.ts";
import {
  divide,
  toDecimal,
  toNumber,
  Decimal,
  type DecimalInput,
} from "../../lib/money.ts";
import {
  detectPortfolioFileFormat,
  readPortfolioWorkbook,
  type PortfolioWorkbookSheet,
  type WorkbookCell,
  type WorkbookNumber,
} from "../../lib/portfolioUpload.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";
import {
  parseCsvFile,
  parseCustomAmount,
  parseDateWithFormat,
  rawDataForCsvRecord,
} from "../importPipeline/adapters/_shared.ts";
import type {
  ParsedPortfolioRow,
  ParsedPortfolioRows,
} from "./portfolioGenericAdapter.ts";
import { cellText } from "../cellText.ts";
import { requiredValue } from "../requiredValue.ts";

/** One Saxo record keyed by header: CSV text cells or typed workbook cells. */
type SaxoRecord = Record<string, WorkbookCell>;

/** Where a workbook record came from, retained for its provenance envelope. */
type RecordMetadata = {
  sheet: string;
  row: number;
  headers: WorkbookCell[];
  cells: WorkbookCell[];
  sourceFileHash: string;
};

/** Booking-detail amount category (see amountKind). */
type AmountKind = "principal" | "fee" | "tax" | "dividend" | "cash" | "unknown";

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

const RECORD_METADATA = new WeakMap<SaxoRecord, RecordMetadata>();
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

function isWorkbookNumber(value: unknown): value is WorkbookNumber {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "number"
  );
}

/** Workbook-only metadata; every workbook record is registered on creation. */
function metadataOf(record: SaxoRecord | undefined): RecordMetadata {
  const metadata = record && RECORD_METADATA.get(record);
  if (!metadata) throw new TypeError("Saxo record has no workbook metadata");
  return metadata;
}

// Relational checks on a parsed amount: a missing amount compares as 0, exactly
// like the JavaScript `null > 0` / `null <= 0` coercion they replace.
function isPositive(value: number | null): boolean {
  return (value ?? 0) > 0;
}
function isNonPositive(value: number | null): boolean {
  return (value ?? 0) <= 0;
}
function isNonNegative(value: number | null): boolean {
  return (value ?? 0) >= 0;
}

function cleanCell(value: unknown): string {
  if (isWorkbookNumber(value)) return value.raw.trim();
  return cellText(value).trim();
}

function normalizeHeader(value: unknown): string {
  return cleanCell(value).replaceAll("\u00a0", " ");
}

/**
 * The decimal separator of one export. A CSV states it only through cells
 * whose reading does not depend on it, such as `-181.63` or `1.234,56`;
 * workbook numbers are typed and always use a dot.
 */
type SaxoNumberFormat = "decimal_dot" | "decimal_comma";

/** A number whose value depends on a decimal separator the file never states. */
class AmbiguousSaxoNumber extends ValidationError {
  constructor(text: string) {
    super(
      `Saxo number ${text} reads differently with a decimal point or comma, and the file does not show which it uses`,
    );
  }
}

const NUMBER_COLUMNS = [
  "Boekingsbedrag",
  "Omrekeningskoers",
  "Totale kosten",
  "Conversion cost",
];
const TRADE_ACTION =
  /^(Koop|Verkoop|Buy|Sell)\s+([+-]?[\d.,]+)\s+@\s+([+-]?[\d.,]+)(?:\s+([A-Z]{3}))?$/i;

/** The separator one numeric text proves, if its two readings differ in validity. */
function separatorEvidence(text: string): SaxoNumberFormat | undefined {
  const dot = parseCustomAmount(text, "decimal_dot");
  const comma = parseCustomAmount(text, "decimal_comma");
  if (Number.isFinite(dot) === Number.isFinite(comma)) return undefined;
  return Number.isFinite(dot) ? "decimal_dot" : "decimal_comma";
}

/** The CSV's own decimal separator, when its unambiguous numeric cells agree on one. */
function csvNumberFormat(
  records: readonly SaxoRecord[],
): SaxoNumberFormat | undefined {
  const found = new Set<SaxoNumberFormat>();
  for (const record of records) {
    const action = TRADE_ACTION.exec(cleanCell(record.Acties));
    const texts = [
      ...NUMBER_COLUMNS.map((column) => cleanCell(record[column])),
      ...(action
        ? [
            requiredValue(action[2], "the trade action carries its quantity"),
            requiredValue(action[3], "the trade action carries its price"),
          ]
        : []),
    ];
    for (const text of texts) {
      const evidence = text ? separatorEvidence(text) : undefined;
      if (evidence) found.add(evidence);
    }
  }
  // A file that proves both separators states no single convention: each cell
  // then reads on its own, and one that reads two ways is surfaced.
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * A Saxo number in the export's own convention. Without one, a value that
 * reads differently with either separator (`1,500`, `1.500`) is ambiguous.
 */
function number(
  value: unknown,
  format?: SaxoNumberFormat,
): number | null {
  const text = cleanCell(value);
  if (!text) return null;
  if (isWorkbookNumber(value)) {
    const parsed = parseCustomAmount(text, "decimal_dot");
    return Number.isFinite(parsed) ? parsed : null;
  }
  let parsed: number;
  try {
    parsed = parseCustomAmount(text, format ?? "auto");
  } catch (error) {
    if (error instanceof ValidationError) throw new AmbiguousSaxoNumber(text);
    throw error;
  }
  return Number.isFinite(parsed) ? parsed : null;
}

function magnitude(
  value: unknown,
  format?: SaxoNumberFormat,
): number | null {
  const parsed = number(value, format);
  return parsed == null ? null : Math.abs(parsed);
}

/** `magnitude` for a row that is already being rejected: ambiguity reads as absent. */
function magnitudeOrNull(value: unknown, format?: SaxoNumberFormat) {
  try {
    return magnitude(value, format);
  } catch (error) {
    if (error instanceof AmbiguousSaxoNumber) return null;
    throw error;
  }
}

function currency(value: unknown): string | null {
  const code = cleanCell(value).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function instrumentSymbol(value: unknown): string {
  // split always yields at least one element.
  return (cleanCell(value).split(":", 1)[0] ?? "").trim();
}

function date(record: SaxoRecord): Date | null {
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

function sourceId(record: SaxoRecord): string | null {
  const immutableId = (value: unknown) => {
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

function baseRow(
  record: SaxoRecord,
  overrides: Partial<ParsedPortfolioRow>,
): ParsedPortfolioRow {
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

function unsupportedRow(
  record: SaxoRecord,
  reason: string,
): ParsedPortfolioRow {
  return baseRow(record, {
    typeRaw: `Unsupported Saxo event: ${cleanCell(record.Acties) || cleanCell(record.Transactietype) || "unknown"}`,
    amount: magnitudeOrNull(record.Boekingsbedrag),
    note: reason,
  });
}

/**
 * A CSV trade's units × price × exchange rate must explain its booked
 * account-currency amount within its costs and 1 % (at least one unit of
 * currency). A misread quantity, such as `1,500` taken as 1.5, fails by orders
 * of magnitude. Without a booked amount, or a rate between two currencies,
 * nothing can be compared.
 */
function bookedValueAgrees(
  record: SaxoRecord,
  units: number,
  price: number,
  instrumentCurrency: string,
  format: SaxoNumberFormat | undefined,
): boolean {
  const booked = magnitude(record.Boekingsbedrag, format);
  const accountCurrency = currency(record.Valuta);
  const rate =
    accountCurrency === instrumentCurrency
      ? 1
      : magnitude(record.Omrekeningskoers, format);
  if (booked == null || booked === 0 || rate == null || rate === 0) return true;
  const costs = toDecimal(magnitude(record["Totale kosten"], format) ?? 0);
  const value = toDecimal(units).times(price).times(rate);
  const tolerance = costs.plus(Decimal.max(1, value.times("0.01")));
  return value.minus(booked).abs().lte(tolerance);
}

function parseTrade(
  record: SaxoRecord,
  format?: SaxoNumberFormat,
): ParsedPortfolioRow {
  const action = cleanCell(record.Acties);
  const match = TRADE_ACTION.exec(action);
  if (!match)
    return unsupportedRow(
      record,
      "Saxo trade action could not be parsed safely",
    );

  const units = magnitude(match[2], format);
  const price = magnitude(match[3], format);
  const instrumentCurrency = currency(match[4] || record.Instrumentvaluta);
  if (
    units == null ||
    units === 0 ||
    price == null ||
    price === 0 ||
    !instrumentCurrency
  ) {
    return unsupportedRow(
      record,
      "Saxo trade is missing units, price, or instrument currency",
    );
  }

  const accountCurrency = currency(record.Valuta);
  const exchangeRate = magnitude(record.Omrekeningskoers, format);
  const accountFees = magnitude(record["Totale kosten"], format);
  if (
    !RECORD_METADATA.has(record) &&
    !bookedValueAgrees(record, units, price, instrumentCurrency, format)
  )
    return unsupportedRow(
      record,
      `Saxo trade ${action} does not agree with its booked amount; check the quantity and price before importing`,
    );
  const fees =
    accountFees != null &&
    accountFees !== 0 &&
    accountCurrency !== instrumentCurrency &&
    exchangeRate != null &&
    exchangeRate !== 0
      ? toNumber(divide(accountFees, exchangeRate))
      : accountFees;

  return baseRow(record, {
    typeRaw: /^(koop|buy)$/i.test(
      requiredValue(match[1], "the action group is mandatory"),
    )
      ? "Buy"
      : "Sell",
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

function parseRecord(
  record: SaxoRecord,
  format?: SaxoNumberFormat,
): ParsedPortfolioRow {
  try {
    return parseKnownRecord(record, format);
  } catch (error) {
    if (!(error instanceof AmbiguousSaxoNumber)) throw error;
    return unsupportedRow(record, error.message);
  }
}

function parseKnownRecord(
  record: SaxoRecord,
  format?: SaxoNumberFormat,
): ParsedPortfolioRow {
  const kind = cleanCell(record.Transactietype).toLowerCase();
  const action = cleanCell(record.Acties).toLowerCase();
  if (kind === "transactie" || kind === "trade")
    return parseTrade(record, format);

  if (kind === "storting/opname" || kind === "cash transfer") {
    if (action === "storting" || action === "deposit") {
      return baseRow(record, {
        typeRaw: "Deposit",
        symbolRaw: "",
        nameRaw: "",
        amount: magnitude(record.Boekingsbedrag, format),
        note: cleanCell(record.Opmerking) || "Saxo cash deposit",
      });
    }
    if (action === "opname" || action === "withdrawal") {
      return baseRow(record, {
        typeRaw: "Withdrawal",
        symbolRaw: "",
        nameRaw: "",
        amount: magnitude(record.Boekingsbedrag, format),
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
      amount: magnitude(record.Boekingsbedrag, format),
      fees: magnitude(record["Totale kosten"], format),
      note: "Saxo CSV dividend contains only a net booking amount. Import the detailed XLSX workbook to retain gross dividends and withholding taxes.",
    });
  }

  return unsupportedRow(record, "Unsupported Saxo transaction type");
}

function workbookProvenance(records: SaxoRecord[]): string {
  return JSON.stringify({
    format: "saxo_xlsx_v1",
    sourceFileHash: metadataOf(records[0]).sourceFileHash,
    records: records.map((record) => {
      const metadata = metadataOf(record);
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

function workbookRecords(
  sheet: PortfolioWorkbookSheet,
  required: string[],
): SaxoRecord[] {
  const [rawHeaders, ...data] = sheet.data;
  if (!rawHeaders)
    throw new ValidationError(`Saxo ${sheet.sheet} sheet is empty`);
  const headers = rawHeaders.map(normalizeHeader);
  if (new Set(headers).size !== headers.length)
    throw new ValidationError(
      `Saxo ${sheet.sheet} sheet has ambiguous duplicate headers`,
    );
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length > 0)
    throw new ValidationError(
      `Saxo ${sheet.sheet} sheet is missing columns: ${missing.join(", ")}`,
    );
  return data.flatMap((cells, index) => {
    if (cells.every((value) => value == null || value === "")) return [];
    const record: SaxoRecord = Object.fromEntries(
      headers.map((header, column) => [header, cells[column] ?? null]),
    );
    for (const column of ID_COLUMNS) {
      const value = record[column];
      if (
        isWorkbookNumber(value) &&
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

function joinKey(record: SaxoRecord): string {
  const fields = JOIN_COLUMNS.map((column) => cleanCell(record[column]));
  if (fields.some((field) => !field || /^0+$/.test(field)))
    throw new ValidationError(
      "Saxo workbook contains a missing booking record or account identity",
    );
  return JSON.stringify(fields);
}

function assertClose(
  actual: DecimalInput,
  expected: DecimalInput,
  reason: string,
): void {
  if (
    actual == null ||
    expected == null ||
    toDecimal(actual).minus(expected).abs().gt("0.01")
  )
    throw new ValidationError(reason);
}

function assertEqualNumber(
  actual: DecimalInput,
  expected: DecimalInput,
  reason: string,
): void {
  if (actual == null || expected == null || !toDecimal(actual).eq(expected))
    throw new ValidationError(reason);
}

function sumBookings(records: SaxoRecord[]): Decimal {
  return records.reduce((sum, record) => {
    const amount = number(record.Boekingsbedrag);
    if (amount == null)
      throw new ValidationError(
        "Saxo workbook contains an invalid booking amount",
      );
    return sum.plus(amount);
  }, toDecimal(0));
}

function amountKind(record: SaxoRecord): AmountKind {
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

/**
 * The separator of a workbook trade's text action: the one under which its
 * quantity and price equal the typed execution cells. Neither leaves the
 * action ambiguous, and the execution check below rejects the workbook.
 */
function workbookActionFormat(
  record: SaxoRecord,
  trades: readonly SaxoRecord[],
): SaxoNumberFormat | undefined {
  const match = TRADE_ACTION.exec(cleanCell(record.Acties));
  const [trade] = trades;
  if (!match || trades.length !== 1 || !trade) return undefined;
  const quantityText = requiredValue(match[2], "the trade action carries its quantity");
  const priceText = requiredValue(match[3], "the trade action carries its price");
  const units = magnitude(trade["Traded Quantity"]);
  const price = magnitude(trade.Prijs);
  return (["decimal_dot", "decimal_comma"] as const).find((format) => {
    const read = (text: string) => {
      const value = parseCustomAmount(text, format);
      return Number.isFinite(value) ? Math.abs(value) : undefined;
    };
    return read(quantityText) === units && read(priceText) === price;
  });
}

function parseWorkbookRecord(
  record: SaxoRecord,
  bookings: SaxoRecord[],
  trades: SaxoRecord[],
): ParsedPortfolioRow {
  const parsed = parseRecord(record, workbookActionFormat(record, trades));
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
  const buckets = new Map<AmountKind, SaxoRecord[]>();
  for (const booking of bookings) {
    const key = amountKind(booking);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(booking);
  }
  const entries = (key: AmountKind) => buckets.get(key) ?? [];
  const magnitudeSum = (key: AmountKind) =>
    toNumber(sumBookings(entries(key)).abs());
  const base: ParsedPortfolioRow = {
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
    const trade = requiredValue(
      trades[0],
      "the check above admits exactly one trade",
    );
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
      units == null ||
      units === 0 ||
      nativePrice == null ||
      nativePrice === 0 ||
      nativeGross == null ||
      nativeGross === 0 ||
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
    if (rate == null || rate === 0)
      throw new ValidationError(
        "Saxo workbook trade is missing its exchange rate",
      );
    const principal = number(
      requiredValue(
        entries("principal")[0],
        "the trade check above admits exactly one principal entry",
      ).Boekingsbedrag,
    );
    if (
      (parsed.typeRaw === "Buy" && isNonNegative(principal)) ||
      (parsed.typeRaw === "Sell" && isNonPositive(principal)) ||
      [...entries("fee"), ...entries("tax")].some((entry) =>
        isPositive(number(entry.Boekingsbedrag)),
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
      trades.length > 0 ||
      entries("dividend").length !== 1 ||
      [...buckets.keys()].some(
        (key) => !["dividend", "tax", "fee"].includes(key),
      ) ||
      isNonPositive(
        number(
          requiredValue(
            entries("dividend")[0],
            "reached only when exactly one dividend entry exists",
          ).Boekingsbedrag,
        ),
      ) ||
      [...entries("tax"), ...entries("fee")].some((entry) =>
        isPositive(number(entry.Boekingsbedrag)),
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
      trades.length > 0 ||
      bookings.length !== 1 ||
      entries("cash").length !== 1 ||
      (parsed.typeRaw === "Deposit" &&
        isNonPositive(number(record.Boekingsbedrag))) ||
      (parsed.typeRaw === "Withdrawal" &&
        isNonNegative(number(record.Boekingsbedrag)))
    ) {
      throw new ValidationError(
        "Saxo workbook cash details are ambiguous or inconsistent",
      );
    }
    return base;
  }
  return base;
}

async function parseWorkbook(
  filePath: string | URL,
): Promise<ParsedPortfolioRows> {
  const sheets = await readPortfolioWorkbook(filePath);
  const table = (name: string, columns: string[]) => {
    const matches = sheets.filter((sheet) => sheet.sheet === name);
    const [match] = matches;
    if (matches.length !== 1 || !match)
      throw new ValidationError(
        `Saxo XLSX workbook requires one ${name} sheet`,
      );
    return workbookRecords(match, columns);
  };
  const main = table("Transacties", REQUIRED_COLUMNS);
  const trades = table("_Transacties", TRADE_COLUMNS);
  const bookings = table("Bookings", BOOKING_COLUMNS);
  if (main.length === 0)
    throw new ValidationError("Saxo transaction history is empty");
  const groups = new Map<
    string,
    { record: SaxoRecord; trades: SaxoRecord[]; bookings: SaxoRecord[] }
  >();
  for (const record of main) {
    const key = joinKey(record);
    if (groups.has(key))
      throw new ValidationError(
        "Saxo workbook has ambiguous duplicate transaction booking records",
      );
    groups.set(key, { record, trades: [], bookings: [] });
  }
  const bookingIds = new Set<string>();
  for (const { records, target } of [
    { records: trades, target: "trades" as const },
    { records: bookings, target: "bookings" as const },
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
  const rows: ParsedPortfolioRows = [...groups.values()].map(
    ({ record, trades: execution, bookings: details }) =>
      parseWorkbookRecord(record, details, execution),
  );
  rows.skipped = 0;
  return rows;
}

export async function parseSaxoTransactionHistory(
  filePath: string,
  config: { encoding?: string } = {},
): Promise<ParsedPortfolioRows> {
  if ((await detectPortfolioFileFormat(filePath)) === "xlsx")
    return parseWorkbook(filePath);
  let sourceColumns: string[] | undefined;
  const records: Record<string, string>[] = await parseCsvFile(
    filePath,
    {
      columns: (headers: string[]) => {
        sourceColumns = [...headers];
        return headers.map(normalizeHeader);
      },
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

  const rows: ParsedPortfolioRows = [];
  let skipped = 0;
  const format = csvNumberFormat(records);
  for (const record of records) {
    const parsed = parseRecord(record, format);
    if (!parsed.date || Number.isNaN(parsed.date.getTime())) {
      skipped++;
      continue;
    }
    rows.push(parsed);
  }
  rows.skipped = skipped;
  rows.sourceColumns = sourceColumns;
  logger.info(
    `Saxo transaction history parsed: ${rows.length} rows, ${skipped} source rows skipped`,
  );
  return rows;
}
