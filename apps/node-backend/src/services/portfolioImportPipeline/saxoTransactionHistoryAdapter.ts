/** Saxo transaction-history adapter for localized CSV and detailed XLSX exports. */

import { logger } from "../../config/logger.ts";
import {
  divide,
  toDecimal,
  toNumber,
  type Decimal,
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
  parseAmountField,
  parseCsvFile,
  parseCsvText,
  parseDateWithFormat,
  rawDataForCsvRecord,
} from "../importPipeline/adapters/_shared.ts";
import type {
  ParsedPortfolioRow,
  ParsedPortfolioRows,
} from "./portfolioGenericAdapter.ts";

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

/**
 * A retained `saxo_xlsx_v1` envelope as JSON.parse returns it. Record headers
 * and cells stay `unknown`: they are untrusted until validated structurally.
 */
type RetainedWorkbookEnvelope = {
  format?: unknown;
  sourceFileHash: string;
  records: { sheet: string; row: number; headers: unknown; cells: unknown }[];
};

/** A primary workbook event re-derived from its retained envelope. */
export type SaxoWorkbookEvidence = ParsedPortfolioRow & {
  instrumentIsin: string;
};

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

/** A retained `{ type: 'date', value }` cell (see workbookProvenance). */
function isRetainedDateCell(
  value: unknown,
): value is { type: "date"; value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "date" &&
    "value" in value &&
    typeof value.value === "string"
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Workbook-only metadata; every workbook record is registered on creation. */
function metadataOf(record: SaxoRecord): RecordMetadata {
  const metadata = RECORD_METADATA.get(record);
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
  return String(value ?? "").trim();
}

function normalizeHeader(value: unknown): string {
  return cleanCell(value).replaceAll("\u00a0", " ");
}

function number(value: unknown): number | null {
  const text = cleanCell(value);
  if (!text) return null;
  const parsed = parseAmountField(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function magnitude(value: unknown): number | null {
  const parsed = number(value);
  return parsed == null ? null : Math.abs(parsed);
}

function currency(value: unknown): string | null {
  const code = cleanCell(value).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function instrumentSymbol(value: unknown): string {
  return cleanCell(value).split(":", 1)[0].trim();
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
    amount: magnitude(record.Boekingsbedrag),
    note: reason,
  });
}

function parseTrade(record: SaxoRecord): ParsedPortfolioRow {
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

function parseRecord(record: SaxoRecord): ParsedPortfolioRow {
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
  if (missing.length)
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

function parseWorkbookRecord(
  record: SaxoRecord,
  bookings: SaxoRecord[],
  trades: SaxoRecord[],
): ParsedPortfolioRow {
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
  const entries = (key: AmountKind) => buckets.get(key) || [];
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
      trades.length ||
      entries("dividend").length !== 1 ||
      [...buckets.keys()].some(
        (key) => !["dividend", "tax", "fee"].includes(key),
      ) ||
      isNonPositive(number(entries("dividend")[0].Boekingsbedrag)) ||
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
      trades.length ||
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

/**
 * Reparse one retained, typed XLSX transaction without trusting staged economics.
 * @param rawData the retained `saxo_xlsx_v1` envelope
 */
export function getSaxoWorkbookReconciliationEvidence(
  rawData: unknown,
): SaxoWorkbookEvidence | undefined {
  try {
    if (typeof rawData !== "string" || rawData.length > 2 * 1024 * 1024)
      return undefined;
    const envelope = JSON.parse(rawData) as RetainedWorkbookEnvelope;
    if (
      envelope.format !== "saxo_xlsx_v1" ||
      !/^[a-f0-9]{64}$/.test(envelope.sourceFileHash) ||
      !Array.isArray(envelope.records) ||
      envelope.records.length < 2 ||
      envelope.records.length > 1000
    )
      return undefined;
    const groups: Record<string, SaxoRecord[]> = {
      Transacties: [],
      _Transacties: [],
      Bookings: [],
    };
    const columns: Record<string, string[]> = {
      Transacties: REQUIRED_COLUMNS,
      _Transacties: TRADE_COLUMNS,
      Bookings: BOOKING_COLUMNS,
    };
    const locations = new Set<string>();
    for (const retained of envelope.records) {
      if (
        !Object.hasOwn(groups, retained.sheet) ||
        !Number.isSafeInteger(retained.row) ||
        retained.row < 2 ||
        !isStringArray(retained.headers) ||
        retained.headers.length > 512 ||
        !Array.isArray(retained.cells) ||
        retained.cells.length > retained.headers.length
      )
        return undefined;
      const location = JSON.stringify([retained.sheet, retained.row]);
      if (locations.has(location)) return undefined;
      locations.add(location);
      // Untrusted retained JSON: each cell is validated structurally below.
      const cells = retained.cells.map((cell: unknown): WorkbookCell => {
        // JSON.parse never yields `undefined`, so a nullish cell is `null`.
        if (cell == null) return null;
        if (typeof cell === "string" || typeof cell === "boolean") return cell;
        if (
          isWorkbookNumber(cell) &&
          typeof cell.raw === "string" &&
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(cell.raw) &&
          Number.isFinite(Number(cell.raw))
        )
          return cell;
        if (isRetainedDateCell(cell)) {
          const value = new Date(cell.value);
          if (value.toISOString() === cell.value) return value;
        }
        throw new ValidationError("Invalid retained Saxo cell");
      });
      const [record] = workbookRecords(
        {
          sheet: retained.sheet,
          sourceFileHash: envelope.sourceFileHash,
          data: [retained.headers, cells],
        },
        columns[retained.sheet],
      );
      if (!record) return undefined;
      metadataOf(record).row = retained.row;
      groups[retained.sheet].push(record);
    }
    if (groups.Transacties.length !== 1) return undefined;
    const record = groups.Transacties[0];
    const identity = joinKey(record);
    const bookingIds = new Set<string>();
    for (const detail of [...groups._Transacties, ...groups.Bookings])
      if (joinKey(detail) !== identity) return undefined;
    for (const booking of groups.Bookings) {
      const id = cleanCell(booking["Booking Id"]);
      if (!id || /^0+$/.test(id) || bookingIds.has(id)) return undefined;
      bookingIds.add(id);
    }
    const parsed = parseWorkbookRecord(
      record,
      groups.Bookings,
      groups._Transacties,
    );
    if (
      !["Buy", "Sell", "Dividend", "Deposit", "Withdrawal"].includes(
        parsed.typeRaw,
      )
    )
      return undefined;
    return {
      ...parsed,
      instrumentIsin: cleanCell(record["Instrument ISIN"]),
    };
  } catch {
    return undefined;
  }
}

/**
 * Bind one literal CSV event to the detailed workbook's primary event.
 * @param rawData the literal CSV record
 * @param sourceColumns the batch's retained source column names
 * @param workbookRawData the primary workbook row's retained envelope
 */
export function getSaxoCsvCompanionEvidence(
  rawData: unknown,
  sourceColumns: unknown,
  workbookRawData: string,
): { csv: ParsedPortfolioRow; workbook: SaxoWorkbookEvidence } | undefined {
  try {
    if (
      typeof rawData !== "string" ||
      rawData.length > 1024 * 1024 ||
      !Array.isArray(sourceColumns) ||
      sourceColumns.length > 512 ||
      !sourceColumns.every((column: unknown) => typeof column === "string")
    )
      return undefined;
    const headers = sourceColumns.map(normalizeHeader);
    if (
      new Set(headers).size !== headers.length ||
      REQUIRED_COLUMNS.some((column) => !headers.includes(column))
    )
      return undefined;
    const tuples: string[][] = parseCsvText(rawData, {
      columns: false,
      skip_empty_lines: false,
      relax_column_count: false,
    });
    if (
      tuples.length !== 1 ||
      tuples[0].length !== headers.length ||
      rawDataForCsvRecord(tuples[0]) !== rawData
    )
      return undefined;
    const csv: Record<string, string> = Object.fromEntries(
      headers.map((header, index) => [header, tuples[0][index]]),
    );
    if (
      !cleanCell(csv["Rekening-ID"]) ||
      /^0+$/.test(cleanCell(csv["Rekening-ID"])) ||
      !cleanCell(csv["Bk Record Id"]) ||
      /^0+$/.test(cleanCell(csv["Bk Record Id"]))
    )
      return undefined;
    const workbook = getSaxoWorkbookReconciliationEvidence(workbookRawData);
    if (!workbook) return undefined;
    const main = (
      JSON.parse(workbookRawData) as RetainedWorkbookEnvelope
    ).records.find((record) => record.sheet === "Transacties");
    // The workbook evidence above already validated this envelope's single
    // Transacties record, its string headers, and its cell array.
    if (!main || !isStringArray(main.headers) || !Array.isArray(main.cells))
      return undefined;
    const mainCells: unknown[] = main.cells;
    const workbookHeaders = main.headers.map(normalizeHeader);
    const record: Record<string, unknown> = Object.fromEntries(
      workbookHeaders.map((header, index) => {
        const cell = mainCells[index];
        return [header, isRetainedDateCell(cell) ? new Date(cell.value) : cell];
      }),
    );
    const monetary = new Set([
      "Boekingsbedrag",
      "Omrekeningskoers",
      "Conversion cost",
      "Totale kosten",
      "Gerealiseerde W/V",
    ]);
    const dates = new Set(["Transactiedatum", "Valutadatum"]);
    const ownerColumns = new Set(["Gebruikersnaam", "IBAN owner name"]);
    if (
      workbookHeaders.some(
        (header) => !ownerColumns.has(header) && !headers.includes(header),
      )
    )
      return undefined;
    for (const header of headers) {
      if (ownerColumns.has(header)) continue;
      if (!workbookHeaders.includes(header)) return undefined;
      const left = csv[header];
      const right = record[header];
      if (dates.has(header)) {
        if (!cleanCell(left) && !cleanCell(right)) continue;
        const parsed = (value: unknown) =>
          value instanceof Date
            ? value
            : parseDateWithFormat(
                cleanCell(value).replaceAll("/", "-"),
                "%Y-%m-%d",
              );
        if (
          parsed(left)?.toISOString().slice(0, 10) !==
          parsed(right)?.toISOString().slice(0, 10)
        )
          return undefined;
      } else if (monetary.has(header)) {
        if (!cleanCell(left) && !cleanCell(right)) continue;
        assertEqualNumber(
          number(left),
          number(right),
          "Saxo companion source amount differs",
        );
      } else if (typeof right === "boolean") {
        if (cleanCell(left).toLowerCase() !== String(right)) return undefined;
      } else if (cleanCell(left) !== cleanCell(right)) return undefined;
    }
    return { csv: parseRecord(csv), workbook };
  } catch {
    return undefined;
  }
}

async function parseWorkbook(
  filePath: string | URL,
): Promise<ParsedPortfolioRows> {
  const sheets = await readPortfolioWorkbook(filePath);
  const table = (name: string, columns: string[]) => {
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
  for (const record of records) {
    const parsed = parseRecord(record);
    if (!parsed?.date || Number.isNaN(parsed.date.getTime())) {
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

export default {
  name: "saxo_transaction_history",
  parseWithConfig: parseSaxoTransactionHistory,
};
