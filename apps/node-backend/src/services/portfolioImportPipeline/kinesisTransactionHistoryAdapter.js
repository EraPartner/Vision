/**
 * Kinesis Money Transaction Statement CSV adapter.
 *
 * Kinesis exports one row per currency leg. Exchange orders therefore appear
 * twice under one Order_ID: the asset leg and the quote-currency leg. This
 * adapter collapses those records into one portfolio trade and one real cash
 * movement, which matches Vision's brokerage import contract without counting
 * the quote leg as a second investment.
 */

import { logger } from "../../config/logger.js";
import { divide, multiply, subtract, toNumber } from "../../lib/money.js";
import {
  parseAmountField,
  parseCsvFile,
  parseDateWithFormat,
  rawDataForCsvRecord,
} from "../importPipeline/adapters/_shared.js";

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

function cleanCell(value) {
  return String(value ?? "").trim();
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
  if (code === "C1USD") return "USD";
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function date(record) {
  return parseDateWithFormat(
    cleanCell(record.DateTime).replace(/\s+UTC$/i, ""),
    "%Y-%m-%d %H:%M:%S",
  );
}

function balanceDelta(record) {
  const start = number(record.Starting_Balance);
  const close = number(record.Closing_Balance);
  return start == null || close == null
    ? null
    : toNumber(subtract(close, start));
}

function sourceId(record, suffix = "") {
  const id = cleanCell(record.Transaction_ID);
  return id ? `${id}${suffix}` : null;
}

function baseRow(record, overrides) {
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

function unsupportedRow(record, reason) {
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

function parseTrade(records) {
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

function parseDistribution(record) {
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

  // A Kinesis yield is paid in metal. Record both the income and the acquired
  // units. Giving the unit receipt the same basis avoids counting its initial
  // value again as an immediate capital gain.
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
      pricePerUnit: toNumber(divide(value, units)),
      amount: value,
      currency: valueCurrency,
      note: `${cleanCell(record.Transaction_Type).replaceAll("_", " ")} units`,
      sourceId: sourceId(record, ":units"),
    }),
  ];
}

function parseNonTrade(record) {
  const type = cleanCell(record.Transaction_Type);
  const code = cleanCell(record.Currency_Code).toUpperCase();
  const isFiat = FIAT_CURRENCIES.has(code);
  const delta = balanceDelta(record);
  const amount = magnitude(delta) ?? magnitude(record.Amount);

  if (DISTRIBUTION_TYPES.has(type)) return parseDistribution(record);

  if (type === "Holder's_Distribution_Adjustment") {
    if (!isFiat && delta != null && delta > 0 && amount) {
      return [
        baseRow(record, {
          typeRaw: "Gift",
          symbolRaw: code,
          units: amount,
          amount: 0,
          note: "Kinesis holder distribution adjustment",
        }),
      ];
    }
    return [
      unsupportedRow(
        record,
        "Kinesis negative holder distribution adjustment requires manual reconciliation",
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
            },
      ),
    ];
  }

  if (type === "Withdrawal" || type === "Withdrawal(Card Payment)") {
    // Vision has no unit-transfer-out transaction. Fiat withdrawals are real
    // sleeve cash movements. Asset withdrawals remain visible as review errors
    // rather than being dropped or fabricated as zero-proceeds sales.
    if (!amount) return null;
    if (!isFiat) {
      return [
        unsupportedRow(
          record,
          "Kinesis asset withdrawal requires manual transfer-out reconciliation",
        ),
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
 * @param {string} filePath
 * @param {{ encoding?: BufferEncoding }} [config]
 * @returns {Promise<import('./portfolioGenericAdapter.js').ParsedPortfolioRows>}
 */
export async function parseKinesisTransactionHistory(filePath, config = {}) {
  const records = await parseCsvFile(
    filePath,
    {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    },
    config.encoding || "utf-8",
  );

  if (records.length === 0) {
    throw new Error("Kinesis Transaction Statement is empty");
  }
  const missing = REQUIRED_COLUMNS.filter(
    (column) => !Object.prototype.hasOwnProperty.call(records[0], column),
  );
  if (missing.length > 0) {
    throw new Error(
      `Kinesis Transaction Statement is missing columns: ${missing.join(", ")}`,
    );
  }

  const tradesByOrder = new Map();
  for (const record of records) {
    if (cleanCell(record.Transaction_Type) !== "Trade") continue;
    const orderId = cleanCell(record.Order_ID);
    if (!orderId) continue;
    const group = tradesByOrder.get(orderId) || [];
    group.push(record);
    tradesByOrder.set(orderId, group);
  }

  const handledOrders = new Set();
  const rows =
    /** @type {import('./portfolioGenericAdapter.js').ParsedPortfolioRows} */ ([]);
  let skipped = 0;
  for (const record of records) {
    let parsed;
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
      parsed = parseNonTrade(record);
      if (!parsed) skipped++;
    }

    if (!parsed) continue;
    rows.push(...parsed);
  }

  rows.skipped = skipped;
  logger.info(
    `Kinesis Transaction Statement parsed: ${rows.length} rows, ${skipped} source rows skipped`,
  );
  return rows;
}

export default {
  name: "kinesis_transaction_history",
  parseWithConfig: parseKinesisTransactionHistory,
};
