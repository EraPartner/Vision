/** Nexo Pro Spot order-history CSV adapter. Financial values come only from fills. */

import { logger } from "../../config/logger.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";
import {
  Decimal,
  toDecimal,
  toNumber,
  type DecimalInput,
} from "../../lib/money.ts";
import {
  parseCsvFile,
  parseCsvText,
  parseDateWithFormat,
  rawDataForCsvRecord,
} from "../importPipeline/adapters/_shared.ts";
import type {
  ParsedPortfolioRow,
  ParsedPortfolioRows,
} from "./portfolioGenericAdapter.ts";

/** A Nexo Pro Spot order record keyed by its (validated) column names. */
type NexoProRecord = Record<string, string>;

/** Exact source proof for one staged Nexo Pro Spot fill (decimal strings). */
export interface NexoProSpotReconciliationEvidence {
  sourceOrderId: string;
  sourceTimestamp: string;
  side: "buy" | "sell";
  symbol: string;
  currency: string;
  unitPrice: string;
  grossUnits: string;
  netUnits: string;
  feeUnits: string;
  feeCurrency: string;
  quoteFee: string;
  grossQuoteAmount: string;
  amount: string;
}

const REQUIRED_COLUMNS = [
  "id",
  "timestamp",
  "pair",
  "side",
  "type",
  "price",
  "executedPrice",
  "triggerPrice",
  "requestedAmount",
  "filledAmount",
  "tradingFee",
  "feeCurrency",
  "status",
  "orderId",
];
const FIAT_QUOTES = new Set(["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "USD"]);
const FINAL_STATUSES = new Set(["completed", "cancelled", "canceled"]);
const ORDER_TYPES = new Set([
  "limit",
  "market",
  "stop_limit",
  "stop_market",
  "stop-limit",
  "stop-market",
  "stoploss",
]);
const DECIMAL_CELL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Match a literal execution value at the four-decimal staging precision. */
export function nexoProSourceMoneyMatches(
  literal: DecimalInput,
  staged: DecimalInput,
): boolean {
  if (literal == null || staged == null) return false;
  // PostgreSQL NUMERIC ties round away from zero; normalized in-memory values
  // use HALF_EVEN. These are the only two supported representations.
  return [Decimal.ROUND_HALF_EVEN, Decimal.ROUND_HALF_UP].some((rounding) =>
    toDecimal(literal)
      .toDecimalPlaces(4, rounding)
      .eq(toDecimal(staged).toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN)),
  );
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}
function decimal(value: unknown): Decimal | undefined {
  const raw = text(value);
  if (!DECIMAL_CELL.test(raw)) return undefined;
  const result = toDecimal(raw);
  return result.isFinite() && result.gte(0) ? result : undefined;
}

/** Retain the export's calendar day without the host machine shifting it. */
function exportedDate(record: NexoProRecord): Date | null {
  const raw = text(record.timestamp);
  const match = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z)?$/,
  );
  if (
    !match ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    return null;
  return parseDateWithFormat(match[1], "%Y-%m-%d");
}

function pair(
  record: NexoProRecord,
): { base: string; quote: string } | undefined {
  const match = text(record.pair)
    .toUpperCase()
    .match(/^([A-Z0-9]{2,12})\/([A-Z0-9]{2,12})$/);
  return match ? { base: match[1], quote: match[2] } : undefined;
}

function baseRow(
  record: NexoProRecord,
  overrides: Partial<ParsedPortfolioRow> = {},
): ParsedPortfolioRow {
  const instrument = pair(record);
  const orderId = text(record.orderId);
  return {
    date: exportedDate(record),
    typeRaw: "Unsupported Nexo Pro Spot order",
    symbolRaw: instrument?.base || "",
    nameRaw: "",
    units: null,
    pricePerUnit: null,
    amount: null,
    fees: null,
    taxes: null,
    currency:
      instrument && FIAT_QUOTES.has(instrument.quote) ? instrument.quote : null,
    fxRateToEur: null,
    note: "",
    rawData: rawDataForCsvRecord(record),
    sourceAccountIdentity: null,
    sourceId: orderId ? `nexo-pro:spot:order:${orderId}` : null,
    ...overrides,
  };
}

function unsupported(
  record: NexoProRecord,
  reason: string,
): ParsedPortfolioRow {
  return baseRow(record, { note: reason });
}

function parseRecord(record: NexoProRecord): ParsedPortfolioRow | undefined {
  const status = text(record.status).toLowerCase();
  const filled = text(record.filledAmount)
    ? decimal(record.filledAmount)
    : toDecimal(0);
  const fee = text(record.tradingFee)
    ? decimal(record.tradingFee)
    : toDecimal(0);
  const execution = text(record.executedPrice)
    ? decimal(record.executedPrice)
    : toDecimal(0);
  if (!filled || !fee || !execution)
    return unsupported(
      record,
      "Nexo Pro Spot order contains an invalid fill quantity, execution price, or fee",
    );

  // A final cancellation with no fills is an order instruction, not a trade.
  // Cancellation with fills remains a real execution and must be imported.
  if (["cancelled", "canceled"].includes(status) && filled.isZero()) {
    if (!fee.isZero() || !execution.isZero())
      return unsupported(
        record,
        "Nexo Pro Spot cancelled order has fees or an execution price without any fill",
      );
    return undefined;
  }
  if (!FINAL_STATUSES.has(status))
    return unsupported(
      record,
      "Nexo Pro Spot order is not final; a later export may contain more fills",
    );
  if (
    filled.isZero() ||
    execution.isZero() ||
    !text(record.filledAmount) ||
    !text(record.executedPrice) ||
    !text(record.tradingFee)
  ) {
    return unsupported(
      record,
      "Nexo Pro Spot final order is missing a filled quantity, execution price, or explicit fee",
    );
  }
  if (!ORDER_TYPES.has(text(record.type).toLowerCase()))
    return unsupported(record, "Nexo Pro Spot order type is unsupported");
  const side = text(record.side).toLowerCase();
  if (side !== "buy" && side !== "sell")
    return unsupported(record, "Nexo Pro Spot order side must be buy or sell");
  const instrument = pair(record);
  if (
    !instrument ||
    instrument.base === instrument.quote ||
    FIAT_QUOTES.has(instrument.base)
  )
    return unsupported(
      record,
      "Nexo Pro Spot order has no unambiguous asset and fiat quote pair",
    );
  if (!FIAT_QUOTES.has(instrument.quote))
    return unsupported(
      record,
      "Nexo Pro Spot crypto-quoted fills require a separate valuation and asset-leg contract",
    );
  const feeCurrency = text(record.feeCurrency).toUpperCase();
  if (
    !fee.isZero() &&
    feeCurrency !== instrument.base &&
    feeCurrency !== instrument.quote
  )
    return unsupported(
      record,
      "Nexo Pro Spot fee in a third asset cannot be valued from this export",
    );

  let units = filled;
  let quoteFee = fee;
  if (feeCurrency === instrument.base) {
    quoteFee = fee.times(execution);
    units = side === "buy" ? filled.minus(fee) : filled.plus(fee);
    if (units.lte(0))
      return unsupported(
        record,
        "Nexo Pro Spot base-asset fee consumes the entire filled quantity",
      );
  }
  const amount = units.times(execution);
  if (side === "sell" && quoteFee.gt(amount))
    return unsupported(
      record,
      "Nexo Pro Spot sell fee exceeds its gross quote proceeds",
    );
  if (
    ![units, execution, amount, quoteFee].every(
      (value) =>
        Number.isFinite(toNumber(value)) &&
        (value.isZero() || toNumber(value) !== 0),
    )
  )
    return unsupported(
      record,
      "Nexo Pro Spot execution exceeds supported numeric limits",
    );
  return baseRow(record, {
    typeRaw: side === "buy" ? "Buy" : "Sell",
    units: toNumber(units),
    pricePerUnit: toNumber(execution),
    amount: toNumber(amount),
    fees: toNumber(quoteFee),
    taxes: 0,
    currency: instrument.quote,
    note: "Nexo Pro Spot filled order; source timestamp retained in provenance",
  });
}

/**
 * Exact source proof for reconciliation of this adapter's staged literal row.
 * Callers must also pin the batch format and compare sourceOrderId to the
 * staged source identity. netUnits means acquired units on buys and consumed
 * units on sells. sourceTimestamp is exported text, not a verified fill time.
 */
export function getNexoProSpotReconciliationEvidence(
  rawData: unknown,
): NexoProSpotReconciliationEvidence | undefined {
  if (typeof rawData !== "string") return undefined;
  let tuples: string[][];
  try {
    tuples = parseCsvText(rawData, { columns: false, skip_empty_lines: false });
  } catch {
    return undefined;
  }
  if (tuples.length !== 1 || tuples[0].length !== REQUIRED_COLUMNS.length)
    return undefined;
  const record: NexoProRecord = Object.fromEntries(
    REQUIRED_COLUMNS.map((column, index) => [column, tuples[0][index]]),
  );
  if (!text(record.orderId) || !exportedDate(record)) return undefined;
  const parsed = parseRecord(record);
  if (!parsed || (parsed.typeRaw !== "Buy" && parsed.typeRaw !== "Sell"))
    return undefined;
  const instrument = pair(record);
  const grossUnits = decimal(record.filledAmount);
  const fee = decimal(record.tradingFee);
  const unitPrice = decimal(record.executedPrice);
  // A parsed Buy/Sell already proved the pair and all three decimal cells.
  if (!instrument || !grossUnits || !fee || !unitPrice) return undefined;
  const feeCurrency = text(record.feeCurrency).toUpperCase();
  const feeUnits = feeCurrency === instrument.base ? fee : toDecimal(0);
  const side = parsed.typeRaw === "Buy" ? "buy" : "sell";
  const netUnits =
    side === "buy" ? grossUnits.minus(feeUnits) : grossUnits.plus(feeUnits);
  return {
    sourceOrderId: text(record.orderId),
    sourceTimestamp: text(record.timestamp),
    side,
    symbol: instrument.base,
    currency: instrument.quote,
    unitPrice: unitPrice.toFixed(),
    grossUnits: grossUnits.toFixed(),
    netUnits: netUnits.toFixed(),
    feeUnits: feeUnits.toFixed(),
    feeCurrency,
    quoteFee: (feeCurrency === instrument.base
      ? fee.times(unitPrice)
      : fee
    ).toFixed(),
    grossQuoteAmount: grossUnits.times(unitPrice).toFixed(),
    amount: netUnits.times(unitPrice).toFixed(),
  };
}

/**
 * The CSV reports an order timestamp and aggregate execution, not individual
 * fills. Callers must establish timestamp semantics before an actual import;
 * no separate execution day can be reconstructed from these columns.
 */
export async function parseNexoProSpotHistory(
  filePath: string,
  config: { encoding?: string } = {},
): Promise<ParsedPortfolioRows> {
  let schemaFound = false;
  const records: NexoProRecord[] = await parseCsvFile(
    filePath,
    {
      columns: (headers: unknown[]) => {
        const normalized = headers.map(text);
        const missing = REQUIRED_COLUMNS.filter(
          (column) => !normalized.includes(column),
        );
        if (missing.length)
          throw new ValidationError(
            `Nexo Pro Spot history is missing columns: ${missing.join(", ")}`,
          );
        if (new Set(normalized).size !== normalized.length)
          throw new ValidationError(
            "Nexo Pro Spot history contains duplicate column names",
          );
        if (
          normalized.length !== REQUIRED_COLUMNS.length ||
          normalized.some((column, index) => column !== REQUIRED_COLUMNS[index])
        ) {
          throw new ValidationError(
            "Nexo Pro Spot history has an unsupported column order or schema extension",
          );
        }
        schemaFound = true;
        return normalized;
      },
      skip_empty_lines: true,
    },
    config.encoding || "utf-8",
  );
  if (!schemaFound)
    throw new ValidationError(
      "Nexo Pro Spot history is missing its CSV header",
    );

  const rows: ParsedPortfolioRows = [];
  const orderIds = new Set<string>();
  let skipped = 0;
  for (const [index, record] of records.entries()) {
    if (!exportedDate(record))
      throw new ValidationError(
        `Nexo Pro Spot row ${index + 2} has an invalid timestamp`,
      );
    const orderId = text(record.orderId);
    if (!orderId || orderIds.has(orderId))
      throw new ValidationError(
        `Nexo Pro Spot row ${index + 2} has a missing or duplicate order identifier`,
      );
    orderIds.add(orderId);
    const parsed = parseRecord(record);
    if (parsed) rows.push(parsed);
    else skipped++;
  }
  rows.skipped = skipped;
  logger.info(
    `Nexo Pro Spot history parsed: ${rows.length} rows, ${skipped} zero-fill orders skipped`,
  );
  return rows;
}

export default {
  name: "nexo_pro_spot_history",
  parseWithConfig: parseNexoProSpotHistory,
};
