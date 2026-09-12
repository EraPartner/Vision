/**
 * Nexo transaction-history CSV adapter.
 *
 * Nexo records wallet transfers and conversions as separate lifecycle rows.
 * `Deposit To Exchange` and `Exchange To Withdraw` are the conversion records;
 * their matching wallet rows are internal movements and must not be imported a
 * second time. Values are normalized to the export's USD-equivalent field so
 * crypto-to-crypto conversions have one stable transaction currency.
 */

import { logger } from "../../config/logger.js";
import { divide, toNumber } from "../../lib/money.js";
import {
  parseAmountField,
  parseCsvFile,
  parseDateWithFormat,
  rawDataForCsvRecord,
} from "../importPipeline/adapters/_shared.js";

const REQUIRED_COLUMNS = [
  "Transaction",
  "Type",
  "Input Currency",
  "Input Amount",
  "Output Currency",
  "Output Amount",
  "USD Equivalent",
  "Fee",
  "Fee Currency",
  "Details",
  "Date / Time (UTC)",
];

const INTERNAL_TYPES = new Set([
  "Exchange Deposited On",
  "Transfer From Pro Wallet",
  "Transfer To Pro Wallet",
  "Withdraw Exchanged",
]);

// Nexo's suffixed balance assets (for example EURX/USDX) remain holdings.
// Only ordinary fiat codes form the cash-like side of a conversion.
const CASH_CODES = new Set(["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "USD"]);

function cleanCell(value) {
  return String(value ?? "").trim();
}

function magnitude(value) {
  const text = cleanCell(value);
  if (!text) return null;
  const parsed = parseAmountField(text);
  return Number.isNaN(parsed) ? null : Math.abs(parsed);
}

function assetCode(value) {
  const code = cleanCell(value).toUpperCase();
  return /^[A-Z0-9]{2,10}$/.test(code) ? code : "";
}

function date(record) {
  return parseDateWithFormat(
    cleanCell(record["Date / Time (UTC)"]),
    "%Y-%m-%d %H:%M:%S",
  );
}

function sourceId(record, suffix = "") {
  const id = cleanCell(record.Transaction);
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
    note: cleanCell(record.Details),
    rawData: rawDataForCsvRecord(record),
    sourceAccountIdentity: null,
    sourceId: sourceId(record),
    ...overrides,
  };
}

function unsupportedRow(record, reason) {
  const symbol = assetCode(record["Input Currency"]);
  const units = magnitude(record["Input Amount"]);
  return baseRow(record, {
    typeRaw: `Unsupported Nexo event: ${cleanCell(record.Type) || "unknown"}`,
    symbolRaw: symbol,
    units,
    amount: magnitude(record["USD Equivalent"]),
    currency: "USD",
    note: reason,
  });
}

function parseTrade(record) {
  const inputCode = assetCode(record["Input Currency"]);
  const outputCode = assetCode(record["Output Currency"]);
  const inputUnits = magnitude(record["Input Amount"]);
  const outputUnits = magnitude(record["Output Amount"]);
  const usdValue = magnitude(record["USD Equivalent"]);
  if (
    !inputCode ||
    !outputCode ||
    inputCode === outputCode ||
    !inputUnits ||
    !outputUnits ||
    !usdValue
  ) {
    return unsupportedRow(
      record,
      "Nexo conversion is missing a distinct asset pair, units, or USD valuation",
    );
  }

  const inputIsCash = CASH_CODES.has(inputCode);
  const outputIsCash = CASH_CODES.has(outputCode);
  if (inputIsCash === outputIsCash) {
    return unsupportedRow(
      record,
      "Nexo conversion has no unambiguous cash-like portfolio side",
    );
  }

  const isBuy = inputIsCash;
  const symbol = isBuy ? outputCode : inputCode;
  const units = isBuy ? outputUnits : inputUnits;

  const feeCurrency = assetCode(record["Fee Currency"]);
  const fee = magnitude(record.Fee);
  if (fee && feeCurrency !== "USD") {
    return unsupportedRow(
      record,
      `Nexo conversion fee in ${feeCurrency || "an unknown currency"} cannot be valued safely`,
    );
  }
  return baseRow(record, {
    typeRaw: isBuy ? "Buy" : "Sell",
    symbolRaw: symbol,
    units,
    pricePerUnit: toNumber(divide(usdValue, units)),
    amount: usdValue,
    fees: feeCurrency === "USD" ? fee : null,
    currency: "USD",
    note: `Nexo conversion ${inputCode}/${outputCode}`,
  });
}

function parseInterest(record) {
  const symbol = assetCode(record["Output Currency"]);
  const units = magnitude(record["Output Amount"]);
  const usdValue = magnitude(record["USD Equivalent"]);
  if (!symbol || !units || !usdValue) return null;

  return [
    baseRow(record, {
      typeRaw: "Interest",
      symbolRaw: symbol,
      amount: usdValue,
      currency: "USD",
      note: "Nexo interest income",
      sourceId: sourceId(record, ":income"),
    }),
    baseRow(record, {
      typeRaw: "Gift",
      symbolRaw: symbol,
      units,
      pricePerUnit: toNumber(divide(usdValue, units)),
      amount: usdValue,
      currency: "USD",
      note: "Nexo interest units",
      sourceId: sourceId(record, ":units"),
    }),
  ];
}

function parseTopUp(record) {
  const symbol = assetCode(record["Output Currency"]);
  const units = magnitude(record["Output Amount"]);
  const usdValue = magnitude(record["USD Equivalent"]);
  if (!symbol || !units) return null;
  return baseRow(record, {
    typeRaw: "Gift",
    symbolRaw: symbol,
    units,
    pricePerUnit: usdValue ? toNumber(divide(usdValue, units)) : null,
    amount: usdValue,
    currency: "USD",
    note: "Nexo asset transfer in; original cost basis unavailable",
  });
}

/**
 * @param {string} filePath
 * @param {{ encoding?: BufferEncoding }} [config]
 * @returns {Promise<import('./portfolioGenericAdapter.js').ParsedPortfolioRows>}
 */
export async function parseNexoTransactionHistory(filePath, config = {}) {
  const records = await parseCsvFile(
    filePath,
    { columns: true, skip_empty_lines: true, relax_column_count: true },
    config.encoding || "utf-8",
  );
  if (records.length === 0)
    throw new Error("Nexo transaction history is empty");

  const missing = REQUIRED_COLUMNS.filter(
    (column) => !Object.prototype.hasOwnProperty.call(records[0], column),
  );
  if (missing.length > 0) {
    throw new Error(
      `Nexo transaction history is missing columns: ${missing.join(", ")}`,
    );
  }

  const rows =
    /** @type {import('./portfolioGenericAdapter.js').ParsedPortfolioRows} */ ([]);
  let skipped = 0;
  for (const record of records) {
    const type = cleanCell(record.Type);

    let parsed;
    if (INTERNAL_TYPES.has(type)) {
      parsed = unsupportedRow(
        record,
        "Nexo lifecycle or internal-transfer row requires explicit pairing review",
      );
    } else if (
      type === "Deposit To Exchange" ||
      type === "Exchange To Withdraw"
    ) {
      parsed = parseTrade(record);
    } else if (type === "Interest") {
      parsed = parseInterest(record);
    } else if (type === "Top up Crypto") {
      parsed = parseTopUp(record);
    } else if (type === "Withdrawal") {
      parsed = unsupportedRow(
        record,
        "Nexo asset withdrawal requires manual transfer-out reconciliation",
      );
    } else {
      parsed = unsupportedRow(record, "Unsupported Nexo transaction type");
    }

    if (!parsed) {
      skipped++;
      continue;
    }
    rows.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }

  rows.skipped = skipped;
  logger.info(
    `Nexo transaction history parsed: ${rows.length} rows, ${skipped} source rows skipped`,
  );
  return rows;
}

export default {
  name: "nexo_transaction_history",
  parseWithConfig: parseNexoTransactionHistory,
};
