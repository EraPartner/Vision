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
import { divide, toDecimal, toNumber } from "../../lib/money.js";
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

// Approved same-fiat wrapper lifecycle pairs are cash movements. Other
// conversions still require one ordinary fiat side to identify the asset.
const CASH_CODES = new Set(["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "USD"]);
const CASH_LIFECYCLE_PAIR_WINDOW_MS = 30 * 60 * 1000;

function fiatCode(value) {
  const code = assetCode(value);
  if (CASH_CODES.has(code)) return code;
  const underlying = code.endsWith("X") ? code.slice(0, -1) : "";
  return CASH_CODES.has(underlying) ? underlying : null;
}

function isRejected(record) {
  return /^rejected\b/i.test(cleanCell(record.Details));
}

function isApproved(record) {
  return /^approved\b/i.test(cleanCell(record.Details));
}

function sourceTime(record) {
  return Date.parse(
    `${cleanCell(record["Date / Time (UTC)"]).replace(" ", "T")}Z`,
  );
}

function equalAmount(a, b) {
  const left = magnitude(a);
  const right = magnitude(b);
  return (
    left != null && right != null && toDecimal(left).minus(right).abs().lt(1e-8)
  );
}

function isFiatWrapper(record) {
  const input = fiatCode(record["Input Currency"]);
  const output = fiatCode(record["Output Currency"]);
  return (
    input &&
    input === output &&
    assetCode(record["Input Currency"]) !== assetCode(record["Output Currency"])
  );
}

function cashCompanionMatches(primary, companion) {
  if (!isApproved(primary) || !isApproved(companion)) return false;
  const expected =
    cleanCell(primary.Type) === "Deposit To Exchange"
      ? "Exchange Deposited On"
      : "Withdraw Exchanged";
  if (cleanCell(companion.Type) !== expected) return false;
  const leftTime = sourceTime(primary);
  const rightTime = sourceTime(companion);
  if (
    !Number.isFinite(leftTime) ||
    !Number.isFinite(rightTime) ||
    Math.abs(leftTime - rightTime) > CASH_LIFECYCLE_PAIR_WINDOW_MS ||
    cleanCell(primary["Date / Time (UTC)"]).slice(0, 10) !==
      cleanCell(companion["Date / Time (UTC)"]).slice(0, 10)
  )
    return false;
  const fiat = fiatCode(primary["Input Currency"]);
  if (
    fiatCode(companion["Input Currency"]) !== fiat ||
    fiatCode(companion["Output Currency"]) !== fiat
  )
    return false;
  return expected === "Exchange Deposited On"
    ? equalAmount(primary["Input Amount"], companion["Input Amount"]) &&
        equalAmount(primary["Output Amount"], companion["Output Amount"])
    : equalAmount(primary["Output Amount"], companion["Input Amount"]) &&
        equalAmount(primary["Output Amount"], companion["Output Amount"]);
}

function parseFiatWrapper(record, companion) {
  const fiat = fiatCode(record["Input Currency"]);
  const provenance = `${rawDataForCsvRecord(record)}\n${rawDataForCsvRecord(companion)}`;
  const unsupported = (reason) => ({
    ...unsupportedRow(record, reason),
    rawData: provenance,
  });
  const fee = feeAmount(record.Fee);
  if (fee == null)
    return unsupported("Nexo cash movement fee is not a valid amount");
  if (fee && fiatCode(record["Fee Currency"]) !== fiat)
    return unsupported(
      "Nexo cash movement fee is not in the underlying fiat currency",
    );
  const deposit = cleanCell(record.Type) === "Deposit To Exchange";
  const input = magnitude(record["Input Amount"]);
  const output = magnitude(record["Output Amount"]);
  const amount = deposit ? input : output;
  if (
    !amount ||
    (deposit &&
      (output == null || (output !== 0 && !equalAmount(input, output)))) ||
    (!deposit &&
      (input == null ||
        toDecimal(input).minus(amount).minus(fee).abs().gt(1e-8)))
  )
    return unsupported("Nexo cash principal and fee do not reconcile");
  // A zero output on an explicitly approved fiat top-up does not mean failure.
  // Record external principal once; the paired wrapper event is provenance.
  const rows = [
    baseRow(record, {
      typeRaw: deposit ? "Deposit" : "Withdrawal",
      amount,
      currency: fiat,
      note: deposit ? "Nexo fiat deposit" : "Nexo fiat withdrawal",
      rawData: provenance,
    }),
  ];
  if (fee)
    rows.push(
      baseRow(record, {
        typeRaw: "Fee",
        amount: fee,
        currency: fiat,
        note: "Nexo fiat movement fee",
        sourceId: sourceId(record, ":fee"),
        rawData: provenance,
      }),
    );
  return rows;
}

function cleanCell(value) {
  return String(value ?? "").trim();
}

function magnitude(value) {
  const text = cleanCell(value);
  if (!text) return null;
  const parsed = parseAmountField(text);
  return Number.isNaN(parsed) ? null : Math.abs(parsed);
}

function feeAmount(value) {
  const text = cleanCell(value);
  if (!text || text === "-") return 0;
  const parsed = parseAmountField(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
  const fiat = fiatCode(symbol);
  if (fiat) {
    if (
      !isApproved(record) ||
      fiatCode(record["Input Currency"]) !== fiat ||
      !units ||
      !equalAmount(record["Input Amount"], record["Output Amount"]) ||
      feeAmount(record.Fee) !== 0
    )
      return unsupportedRow(
        record,
        "Nexo fiat interest has unresolved approval, principal, or fee evidence",
      );
    return baseRow(record, {
      typeRaw: "Interest",
      amount: units,
      currency: fiat,
      note: "Nexo fiat interest income",
      sourceId: sourceId(record, ":income"),
    });
  }
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

function parseTopUp(record, config) {
  const symbol = assetCode(record["Output Currency"]);
  const units = magnitude(record["Output Amount"]);
  if (!symbol || !units) return null;
  const origin = Number(config.transfer_origin_account_id);
  if (Number.isInteger(origin) && origin > 0) {
    if (!isApproved(record) || feeAmount(record.Fee) !== 0)
      return unsupportedRow(
        record,
        "Nexo incoming asset transfer has unresolved approval or fee evidence",
      );
    return baseRow(record, {
      typeRaw: "AssetTransfer",
      symbolRaw: symbol,
      units,
      amount: 0,
      fees: 0,
      taxes: 0,
      note: "Nexo internal asset transfer in; original acquisition basis is carried from the configured origin",
      assetTransfer: {
        direction: "in",
        basisStatus: "carried",
        feeUnits: "0",
        receivedUnits: String(units),
      },
    });
  }
  return baseRow(record, {
    typeRaw: "Gift",
    symbolRaw: symbol,
    units,
    amount: 0,
    note: "Nexo asset transfer in; original cost basis unavailable",
    assetTransfer: { direction: "in", basisStatus: "unresolved" },
  });
}

function parseInternalProMovement(record) {
  if (
    !isApproved(record) ||
    assetCode(record["Input Currency"]) !==
      assetCode(record["Output Currency"]) ||
    !magnitude(record["Input Amount"]) ||
    !equalAmount(record["Input Amount"], record["Output Amount"]) ||
    feeAmount(record.Fee) !== 0
  )
    return unsupportedRow(
      record,
      "Nexo Pro wallet movement has unresolved status, currency, units, or fees",
    );
  return baseRow(record, {
    typeRaw: "InternalMovement",
    amount: 0,
    note: "Movement between Nexo Wallet and Pro within the same Vision account; Pro execution history is required",
    assetTransfer: { direction: "internal", basisStatus: "not_applicable" },
  });
}

function parseAssetWithdrawal(record) {
  const symbol = assetCode(record["Input Currency"]);
  const output = assetCode(record["Output Currency"]);
  const gross = magnitude(record["Input Amount"]);
  const received = magnitude(record["Output Amount"]);
  const fee = feeAmount(record.Fee);
  const feeCurrency = assetCode(record["Fee Currency"]);
  if (
    !symbol ||
    symbol !== output ||
    !gross ||
    !received ||
    !Number.isFinite(fee) ||
    fee < 0 ||
    (fee > 0 && feeCurrency !== symbol) ||
    !toDecimal(gross).eq(toDecimal(received).plus(fee))
  )
    return unsupportedRow(
      record,
      "Nexo asset withdrawal has unresolved units or fee currency",
    );
  return baseRow(record, {
    typeRaw: "AssetTransfer",
    symbolRaw: symbol,
    units: gross,
    amount: 0,
    fees: 0,
    taxes: 0,
    note: "Nexo internal asset transfer",
    assetTransfer: {
      direction: "out",
      basisStatus: "carried",
      feeUnits: String(fee),
      receivedUnits: String(received),
    },
  });
}

/**
 * @param {string} filePath
 * @param {{ encoding?: string, transfer_origin_account_id?: number }} [config]
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
  const wrapperPrimaries = records.filter(
    (record) =>
      ["Deposit To Exchange", "Exchange To Withdraw"].includes(
        cleanCell(record.Type),
      ) &&
      isFiatWrapper(record) &&
      !isRejected(record),
  );
  const companions = new Map();
  for (const primary of wrapperPrimaries) {
    const matches = records.filter((record) =>
      cashCompanionMatches(primary, record),
    );
    if (matches.length !== 1) continue;
    const companion = matches[0];
    if (
      wrapperPrimaries.filter((record) =>
        cashCompanionMatches(record, companion),
      ).length !== 1
    )
      continue;
    companions.set(primary, companion);
  }
  const consumedCompanions = new Set(companions.values());
  for (const record of records) {
    const type = cleanCell(record.Type);

    if (isRejected(record) || consumedCompanions.has(record)) {
      skipped++;
      continue;
    }

    let parsed;
    if (companions.has(record)) {
      parsed = parseFiatWrapper(record, companions.get(record));
    } else if (wrapperPrimaries.includes(record)) {
      parsed = unsupportedRow(
        record,
        "Nexo fiat movement has no unique approved lifecycle companion",
      );
    } else if (
      ["Transfer From Pro Wallet", "Transfer To Pro Wallet"].includes(type)
    ) {
      parsed = parseInternalProMovement(record);
    } else if (INTERNAL_TYPES.has(type)) {
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
      parsed = parseTopUp(record, config);
    } else if (type === "Withdrawal") {
      parsed = parseAssetWithdrawal(record);
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
