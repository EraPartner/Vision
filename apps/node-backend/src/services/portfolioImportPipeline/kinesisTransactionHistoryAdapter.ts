/**
 * Kinesis Money Transaction Statement CSV adapter.
 *
 * Kinesis exports one row per currency leg. Exchange orders therefore appear
 * twice under one Order_ID: the asset leg and the quote-currency leg. This
 * adapter collapses those records into one portfolio trade and one real cash
 * movement, which matches Vision's brokerage import contract without counting
 * the quote leg as a second investment.
 */

import { logger } from "../../config/logger.ts";
import {
  divide,
  multiply,
  subtract,
  toNumber,
  toDecimal,
} from "../../lib/money.ts";
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

/** A `columns: true` csv-parse record of the Kinesis statement. */
type KinesisRecord = Record<string, string>;

/** The parser-config fields the Kinesis event mapping reads. */
type KinesisEventConfig = { yield_basis_policy?: "zero" };

const REQUIRED_COLUMNS = [
  "DateTime",
  "HIN",
  "Currency_Code",
  "Transaction_Type",
  "Transaction_ID",
  "Order_ID",
  "Currency_Pair",
  "Amount",
  "Trade_Price",
  "Total",
  "Fee",
  "Fee_Currency",
  "Trade_Value",
  "Trade_Value_Currency",
  "Starting_Balance",
  "Starting_Balance_Currency",
  "Closing_Balance",
  "Closing_Balance_Currency",
];

const FIAT_CURRENCIES = new Set([
  "AUD",
  "CAD",
  "CHF",
  "EUR",
  "GBP",
  "SGD",
  "USD",
]);

const DISTRIBUTION_TYPES = new Set([
  "Holder's_Distribution",
  "Velocity's_Distribution",
]);

function cleanCell(value: unknown): string {
  return String(value ?? "").trim();
}

function number(value: unknown): number | null {
  const text = cleanCell(value);
  if (!text) return null;
  const parsed = parseAmountField(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function magnitude(value: unknown): number | null {
  const parsed = number(value);
  return parsed == null ? null : Math.abs(parsed);
}

function currency(value: unknown): string | null {
  const code = cleanCell(value).toUpperCase();
  if (code === "C1USD") return "USD";
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function date(record: KinesisRecord): Date | null {
  return parseDateWithFormat(
    cleanCell(record.DateTime).replace(/\s+UTC$/i, ""),
    "%Y-%m-%d %H:%M:%S",
  );
}

function balanceDelta(record: KinesisRecord): number | null {
  const start = number(record.Starting_Balance);
  const close = number(record.Closing_Balance);
  return start == null || close == null
    ? null
    : toNumber(subtract(close, start));
}

function sourceId(record: KinesisRecord, suffix = ""): string | null {
  const id = cleanCell(record.Transaction_ID);
  return id ? `${id}${suffix}` : null;
}

function baseRow(
  record: KinesisRecord,
  overrides: Partial<ParsedPortfolioRow>,
): ParsedPortfolioRow {
  return {
    date: date(record),
    typeRaw: "",
    symbolRaw: "",
    nameRaw: "",
    units: null,
    pricePerUnit: null,
    amount: null,
    fees: null,
    taxes: null,
    currency: null,
    fxRateToEur: null,
    note: "",
    rawData: rawDataForCsvRecord(record),
    sourceAccountIdentity: cleanCell(record.HIN) || null,
    sourceId: sourceId(record),
    ...overrides,
  };
}

function unsupportedRow(
  record: KinesisRecord,
  reason: string,
): ParsedPortfolioRow {
  const code = cleanCell(record.Currency_Code).toUpperCase();
  const amount = magnitude(balanceDelta(record)) ?? magnitude(record.Amount);
  return baseRow(record, {
    typeRaw: `Unsupported Kinesis event: ${cleanCell(record.Transaction_Type) || "unknown"}`,
    symbolRaw: FIAT_CURRENCIES.has(code) ? "" : code,
    units: FIAT_CURRENCIES.has(code) ? null : amount,
    amount: FIAT_CURRENCIES.has(code) ? amount : null,
    currency: FIAT_CURRENCIES.has(code) ? currency(code) : null,
    note: reason,
  });
}

function parseTrade(records: KinesisRecord[]): ParsedPortfolioRow[] | null {
  if (records.length !== 2) return null;
  const pair = cleanCell(records[0]?.Currency_Pair).toUpperCase();
  if (
    records.some(
      (record) => cleanCell(record.Currency_Pair).toUpperCase() !== pair,
    )
  ) {
    return null;
  }
  const [assetCode, quoteCode, ...rest] = pair.split("_");
  if (!assetCode || !quoteCode || rest.length > 0) return null;

  const asset = records.find(
    (record) => cleanCell(record.Currency_Code).toUpperCase() === assetCode,
  );
  const quote = records.find(
    (record) => cleanCell(record.Currency_Code).toUpperCase() === quoteCode,
  );
  const tradeCurrency = currency(quoteCode);
  if (!asset || !quote || !tradeCurrency) return null;

  const assetDelta = balanceDelta(asset);
  const quoteDelta = balanceDelta(quote);
  const units =
    magnitude(asset.Total) ?? magnitude(assetDelta) ?? magnitude(asset.Amount);
  const price = magnitude(asset.Trade_Price);
  const cashAmount =
    magnitude(quoteDelta) ?? magnitude(quote.Amount) ?? magnitude(quote.Total);
  if (
    !date(asset) ||
    assetDelta == null ||
    assetDelta === 0 ||
    quoteDelta == null ||
    quoteDelta === 0 ||
    !units ||
    !price ||
    !cashAmount
  ) {
    return null;
  }

  const fee = magnitude(asset.Fee);
  const feeCurrency = cleanCell(asset.Fee_Currency).toUpperCase();
  const quoteFee =
    fee == null
      ? null
      : feeCurrency === assetCode
        ? toNumber(multiply(fee, price))
        : feeCurrency === quoteCode
          ? fee
          : null;

  return [
    baseRow(asset, {
      typeRaw: assetDelta > 0 ? "Buy" : "Sell",
      symbolRaw: assetCode,
      units,
      pricePerUnit: price,
      // Kinesis' quote leg is the real sleeve movement. The portfolio side
      // derives gross amount from units × price and adds the converted fee.
      amount: null,
      fees: quoteFee,
      currency: tradeCurrency,
      note: `Kinesis trade ${pair}`,
    }),
    baseRow(quote, {
      typeRaw: quoteDelta > 0 ? "Deposit" : "Withdrawal",
      amount: cashAmount,
      currency: tradeCurrency,
      note: `Kinesis trade cash leg ${pair}`,
    }),
  ];
}

function parseDistribution(
  record: KinesisRecord,
  config: KinesisEventConfig,
): ParsedPortfolioRow[] | null {
  const symbol = cleanCell(record.Currency_Code).toUpperCase();
  const units = magnitude(record.Amount);
  const value = magnitude(record.Trade_Value);
  const valueCurrency = currency(record.Trade_Value_Currency);
  if (
    !symbol ||
    FIAT_CURRENCIES.has(symbol) ||
    !units ||
    !value ||
    !valueCurrency
  ) {
    return null;
  }

  // Statement income is retained separately from the received units. A reviewed
  // zero-basis interpretation changes only the unit receipt, never income facts.
  return [
    baseRow(record, {
      typeRaw: "Dividend",
      symbolRaw: symbol,
      amount: value,
      currency: valueCurrency,
      note: cleanCell(record.Transaction_Type).replaceAll("_", " "),
      sourceId: sourceId(record, ":income"),
    }),
    baseRow(record, {
      typeRaw: "Gift",
      symbolRaw: symbol,
      units,
      pricePerUnit:
        config.yield_basis_policy === "zero"
          ? 0
          : toNumber(divide(value, units)),
      amount: config.yield_basis_policy === "zero" ? 0 : value,
      currency: valueCurrency,
      note: `${cleanCell(record.Transaction_Type).replaceAll("_", " ")} units`,
      sourceId: sourceId(record, ":units"),
      ...(config.yield_basis_policy === "zero"
        ? {
            assetAdjustment: { kind: "yield_acquisition", basisPolicy: "zero" },
          }
        : {}),
    }),
  ];
}

function parseNonTrade(
  record: KinesisRecord,
  config: KinesisEventConfig,
): ParsedPortfolioRow[] | null {
  const type = cleanCell(record.Transaction_Type);
  const code = cleanCell(record.Currency_Code).toUpperCase();
  const isFiat = FIAT_CURRENCIES.has(code);
  const delta = balanceDelta(record);
  const amount = magnitude(delta) ?? magnitude(record.Amount);

  if (DISTRIBUTION_TYPES.has(type)) return parseDistribution(record, config);

  if (type === "Holder's_Distribution_Adjustment") {
    if (!isFiat && delta != null && delta > 0 && amount) {
      return [
        baseRow(record, {
          typeRaw: "Gift",
          symbolRaw: code,
          units: amount,
          amount: 0,
          pricePerUnit: config.yield_basis_policy === "zero" ? 0 : null,
          note: "Kinesis holder distribution adjustment; original cost basis policy retained",
          ...(config.yield_basis_policy === "zero"
            ? {
                assetAdjustment: {
                  kind: "yield_acquisition",
                  basisPolicy: "zero",
                },
              }
            : {
                assetTransfer: { direction: "in", basisStatus: "unresolved" },
              }),
        }),
      ];
    }
    if (
      !isFiat &&
      delta != null &&
      delta < 0 &&
      amount &&
      config.yield_basis_policy === "zero" &&
      toDecimal(number(record.Amount) || 0).eq(delta)
    )
      return [
        baseRow(record, {
          typeRaw: "AssetAdjustment",
          symbolRaw: code,
          units: amount,
          amount: 0,
          fees: 0,
          taxes: 0,
          note: "Kinesis holder distribution reversal; only source-proven zero-basis yield units are eligible",
          assetAdjustment: {
            kind: "yield_reversal",
            basisPolicy: "zero_yield_only",
          },
        }),
      ];
    return [
      unsupportedRow(
        record,
        "Kinesis negative holder distribution adjustment requires an explicit known-zero yield basis policy and eligible source history",
      ),
    ];
  }

  if (type === "Deposit") {
    if (!amount) return null;
    return [
      baseRow(
        record,
        isFiat
          ? {
              typeRaw: "Deposit",
              amount,
              currency: currency(code),
              note: "Kinesis cash deposit",
            }
          : {
              typeRaw: "Gift",
              symbolRaw: code,
              units: amount,
              amount: 0,
              note: "Kinesis asset transfer in; original cost basis unavailable",
              assetTransfer: { direction: "in", basisStatus: "unresolved" },
            },
      ),
    ];
  }

  if (type === "Withdrawal" || type === "Withdrawal(Card Payment)") {
    if (!amount) return null;
    if (!isFiat) {
      const received = magnitude(record.Amount);
      const fee = number(record.Fee);
      const feeCode = cleanCell(record.Fee_Currency).toUpperCase();
      if (
        delta == null ||
        delta >= 0 ||
        !received ||
        fee == null ||
        fee < 0 ||
        (fee > 0 && feeCode !== code) ||
        !toDecimal(amount).eq(toDecimal(received).plus(fee))
      ) {
        return [
          unsupportedRow(
            record,
            "Kinesis asset withdrawal has unresolved units or fee currency",
          ),
        ];
      }
      return [
        baseRow(record, {
          typeRaw: "AssetTransfer",
          symbolRaw: code,
          units: amount,
          amount: 0,
          fees: 0,
          taxes: 0,
          note: "Kinesis internal asset transfer",
          assetTransfer: {
            direction: "out",
            basisStatus: "carried",
            feeUnits: String(fee),
            receivedUnits: String(received),
          },
        }),
      ];
    }
    return [
      baseRow(record, {
        typeRaw: "Withdrawal",
        amount,
        fees: magnitude(record.Fee),
        currency: currency(code),
        note:
          type === "Withdrawal(Card Payment)"
            ? "Kinesis card payment"
            : "Kinesis cash withdrawal",
      }),
    ];
  }

  return [unsupportedRow(record, "Unsupported Kinesis transaction type")];
}

/**
 * Reparse retained literal yield rows only with their actual source header.
 *
 * @returns undefined when the header or record is not a literal yield event;
 *   null when the yield event itself does not map to portfolio rows.
 */
export function parseKinesisSourceRecordForBasisPolicy(
  rawData: string,
  config: { sourceColumns?: string[]; yield_basis_policy?: "zero" },
): ParsedPortfolioRow[] | null | undefined {
  const columns = config.sourceColumns;
  if (
    !Array.isArray(columns) ||
    columns.length !== REQUIRED_COLUMNS.length ||
    new Set(columns).size !== columns.length ||
    !REQUIRED_COLUMNS.every((column) => columns.includes(column))
  )
    return undefined;
  try {
    const records: KinesisRecord[] = parseCsvText(rawData, {
      columns,
      skip_empty_lines: true,
      relax_column_count: false,
    });
    const [record] = records;
    if (
      records.length !== 1 ||
      !record ||
      ![...DISTRIBUTION_TYPES, "Holder's_Distribution_Adjustment"].includes(
        cleanCell(record.Transaction_Type),
      )
    )
      return undefined;
    return parseNonTrade(record, config);
  } catch {
    return undefined;
  }
}

/** Reparse a complete retained statement event set with its actual header. */
export function reparseKinesisSourceEvents(
  rawRecords: string[],
  config: { sourceColumns: string[]; yield_basis_policy?: "zero" },
): ParsedPortfolioRow[] | undefined {
  const columns = config.sourceColumns;
  if (
    !Array.isArray(columns) ||
    columns.length !== REQUIRED_COLUMNS.length ||
    new Set(columns).size !== columns.length ||
    !REQUIRED_COLUMNS.every((column) => columns.includes(column))
  )
    return undefined;
  try {
    const records = [...new Set(rawRecords)].map((raw): KinesisRecord => {
      const parsed: KinesisRecord[] = parseCsvText(raw, {
        columns,
        skip_empty_lines: true,
        relax_column_count: false,
      });
      const [record] = parsed;
      if (parsed.length !== 1 || !record)
        throw new Error("Expected one literal Kinesis record");
      return record;
    });
    const result: ParsedPortfolioRow[] = [];
    const orders = new Set<string>();
    for (const record of records) {
      if (cleanCell(record.Transaction_Type) !== "Trade") {
        const parsed = parseNonTrade(record, config);
        if (!parsed) return undefined;
        result.push(...parsed);
        continue;
      }
      const order = cleanCell(record.Order_ID);
      if (!order) return undefined;
      if (orders.has(order)) continue;
      orders.add(order);
      const group = records.filter(
        (item) =>
          cleanCell(item.Transaction_Type) === "Trade" &&
          cleanCell(item.Order_ID) === order,
      );
      if (
        group.length !== 2 ||
        group.some(
          (item) =>
            cleanCell(item.HIN) !== cleanCell(record.HIN) ||
            cleanCell(item.DateTime) !== cleanCell(record.DateTime),
        )
      )
        return undefined;
      const parsed = parseTrade(group);
      if (!parsed) return undefined;
      result.push(...parsed);
    }
    return result;
  } catch {
    return undefined;
  }
}

export async function parseKinesisTransactionHistory(
  filePath: string,
  config: { encoding?: string; yield_basis_policy?: "zero" } = {},
): Promise<ParsedPortfolioRows> {
  const records: KinesisRecord[] = await parseCsvFile(
    filePath,
    {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    },
    config.encoding || "utf-8",
  );

  const [firstRecord] = records;
  if (!firstRecord) {
    throw new Error("Kinesis Transaction Statement is empty");
  }
  const missing = REQUIRED_COLUMNS.filter(
    (column) => !Object.prototype.hasOwnProperty.call(firstRecord, column),
  );
  if (missing.length > 0) {
    throw new Error(
      `Kinesis Transaction Statement is missing columns: ${missing.join(", ")}`,
    );
  }

  const tradesByOrder = new Map<string, KinesisRecord[]>();
  for (const record of records) {
    if (cleanCell(record.Transaction_Type) !== "Trade") continue;
    const orderId = cleanCell(record.Order_ID);
    if (!orderId) continue;
    const group = tradesByOrder.get(orderId) || [];
    group.push(record);
    tradesByOrder.set(orderId, group);
  }

  const handledOrders = new Set<string>();
  const rows: ParsedPortfolioRows = [];
  let skipped = 0;
  for (const record of records) {
    let parsed: ParsedPortfolioRow[] | null;
    if (cleanCell(record.Transaction_Type) === "Trade") {
      const orderId = cleanCell(record.Order_ID);
      if (handledOrders.has(orderId)) continue;
      handledOrders.add(orderId);
      const group = tradesByOrder.get(orderId) || [record];
      parsed = parseTrade(group);
      if (!parsed) {
        parsed = group.map((tradeRecord) =>
          unsupportedRow(
            tradeRecord,
            "Kinesis trade legs could not be paired safely",
          ),
        );
      }
    } else {
      parsed = parseNonTrade(record, config);
      if (!parsed) skipped++;
    }

    if (!parsed) continue;
    rows.push(...parsed);
  }

  rows.skipped = skipped;
  rows.sourceColumns = Object.keys(firstRecord);
  logger.info(
    `Kinesis Transaction Statement parsed: ${rows.length} rows, ${skipped} source rows skipped`,
  );
  return rows;
}

export default {
  name: "kinesis_transaction_history",
  parseWithConfig: parseKinesisTransactionHistory,
};
