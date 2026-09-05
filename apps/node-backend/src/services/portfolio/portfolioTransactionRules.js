/**
 * Portfolio transaction domain rules:
 *   - validation (normalizeTransactionPayload, validatePortfolioUnitMutation)
 *   - asset-class helpers (unit-based set)
 *
 * `portfolio_transactions` is a plain flat table on every install: fresh installs get it
 * from the 0001 baseline and legacy table-inheritance installs are converted by migration
 * 0087 (ADR-109) before the backend starts listening, so no schema-shape probing is needed.
 */

import {
  getAccountLabel as loadAccountLabel,
  getUnitEventsForInvestment,
} from "../../repositories/portfolioTxRepo.reads.js";
import {
  areLotsFullyAssigned,
  partitionOversellDeficits,
  partitionTxnsByAccount,
} from "@vision/shared-utils/portfolio";
import {
  toDecimal,
  toNumber,
  roundMoney,
  multiply,
  divide,
} from "../../lib/money.js";
import { VALID_PORTFOLIO_TXN_TYPES } from "../../lib/portfolioTxnTypes.js";
import { makeValidationError } from "../../lib/repositoryErrors.js";
import { UNIT_BASED_ASSET_CLASSES as UNIT_BASED_ASSET_CLASS_LIST } from "@vision/types/assetClasses";
import { PORTFOLIO_RECURRENCE_INTERVALS } from "@vision/types/recurrence";

/** @typedef {import('../../types/rows.js').PortfolioTransactionRow} PortfolioTransactionRow */

/**
 * The caller-facing portfolio-transaction payload, before/after
 * {@link normalizeTransactionPayload} fills in the derived unit math.
 *
 * @typedef {object} PortfolioTransactionInput
 * @property {number} investment_id
 * @property {string} type
 * @property {string} date 'YYYY-MM-DD'
 * @property {number|string} [amount]
 * @property {number|string|null} [units]
 * @property {number|string|null} [price_per_unit]
 * @property {number|string|null} [fees]
 * @property {number|string|null} [taxes]
 * @property {'gross'|'net'|'unknown'} [dividend_amount_convention]
 * @property {string} [currency]
 * @property {string|null} [note]
 * @property {boolean} [is_recurring]
 * @property {string|null} [recurrence_interval]
 * @property {string|null} [recurrence_end_date]
 * @property {number|string|null} [fx_rate_to_eur]
 * @property {number|null} [account_id]
 * @property {number|string|null} [import_batch_id] The portfolio import batch that
 *           created this lot (migration 0086) — set only by the import commit path,
 *           NULL for manual entry. Rollback bulk-deletes on it.
 * @property {string} [preloaded_asset_class]
 */

// The recurrence_interval DB enum (migration 0001) / frontend RecurrenceInterval
// union, single-sourced in @vision/types/recurrence — note the hyphenated
// 'bi-weekly' spelling, which is NOT the planned-transaction vocabulary. An
// out-of-set value has no DB CHECK and otherwise surfaces as a raw enum-cast 500.
// Widened to Set<string>: callers probe raw, untrusted values with .has().
export const VALID_RECURRENCE_INTERVALS = new Set(
  /** @type {readonly string[]} */ (PORTFOLIO_RECURRENCE_INTERVALS),
);

// Derived from the shared canonical subset (@vision/types/assetClasses) so it
// cannot drift from the frontend's copy. Widened to Set<string>: callers probe
// raw payload values with .has().
export const UNIT_BASED_ASSET_CLASSES = new Set(
  /** @type {readonly string[]} */ (UNIT_BASED_ASSET_CLASS_LIST),
);

/**
 * @param {any} value
 * @param {string} fieldName
 * @returns {number|undefined}
 */
function parseOptionalNumber(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw makeValidationError(`${fieldName} must be a valid number`);
  }
  return parsed;
}

/**
 * @param {{ amount?: number, units?: number, pricePerUnit?: number }} input
 * @returns {{ amount: number, units: number, price_per_unit: number }}
 */
function normalizeBuySellMath({ amount, units, pricePerUnit }) {
  const hasAmount = amount !== undefined;
  const hasUnits = units !== undefined;
  const hasPrice = pricePerUnit !== undefined;
  const provided = Number(hasAmount) + Number(hasUnits) + Number(hasPrice);

  if (provided < 2) {
    throw makeValidationError(
      "For buy/sell transactions, provide at least two of amount, units, and price_per_unit",
    );
  }

  if (
    (hasUnits && units <= 0) ||
    (hasPrice && pricePerUnit <= 0) ||
    (hasAmount && amount <= 0)
  ) {
    throw makeValidationError(
      "For buy/sell transactions, amount, units, and price_per_unit must be positive",
    );
  }

  let nextAmount = amount;
  let nextUnits = units;
  let nextPrice = pricePerUnit;

  if (!hasAmount) nextAmount = roundMoney(multiply(nextUnits, nextPrice), 4);
  if (!hasUnits) nextUnits = roundMoney(divide(nextAmount, nextPrice), 8);
  if (!hasPrice) nextPrice = roundMoney(divide(nextAmount, nextUnits), 6);

  const expectedAmount = roundMoney(multiply(nextUnits, nextPrice), 4);
  const comparableAmount = roundMoney(nextAmount, 4);
  // Decimal compare: float subtraction at the tolerance boundary rejects the
  // exactly-one-cent case this check intends to accept (e.g. |100.00 − 99.99|
  // as floats is 0.010000000000005116 > 0.01).
  if (
    toDecimal(expectedAmount)
      .minus(toDecimal(comparableAmount))
      .abs()
      .gt("0.01")
  ) {
    throw makeValidationError(
      "amount must equal units * price_per_unit for buy/sell transactions",
    );
  }

  return {
    amount: comparableAmount,
    units: roundMoney(nextUnits, 8),
    price_per_unit: roundMoney(nextPrice, 6),
  };
}

/**
 * @param {any} payload
 * @param {{ assetClass?: string }} [options]
 */
export function normalizeTransactionPayload(payload, { assetClass } = {}) {
  const type = payload.type;
  // Membership guard: an unknown type ('banana') otherwise inserted (invisible
  // to the units replay) or reached the enum column as a raw cast 500. The
  // import pipeline already constrains types to this same canonical set, so this
  // only rejects genuine garbage on the direct-API/update paths.
  if (type != null && !VALID_PORTFOLIO_TXN_TYPES.has(type)) {
    throw makeValidationError(`Invalid transaction type: ${type}`);
  }
  // recurrence_interval is a DB enum with no CHECK constraint; an out-of-set
  // value 500'd at insert. The import path never sets it (undefined).
  if (
    payload.recurrence_interval != null &&
    payload.recurrence_interval !== "" &&
    !VALID_RECURRENCE_INTERVALS.has(payload.recurrence_interval)
  ) {
    throw makeValidationError(
      `Invalid recurrence_interval: ${payload.recurrence_interval}`,
    );
  }
  const dividendAmountConvention =
    payload.dividend_amount_convention ?? "unknown";
  if (!new Set(["gross", "net", "unknown"]).has(dividendAmountConvention)) {
    throw makeValidationError(
      `Invalid dividend_amount_convention: ${dividendAmountConvention}`,
    );
  }
  if (type !== "dividend" && dividendAmountConvention !== "unknown") {
    throw makeValidationError(
      "dividend_amount_convention is only valid for dividend transactions",
    );
  }
  const amount = parseOptionalNumber(payload.amount, "amount");
  const units = parseOptionalNumber(payload.units, "units");
  const pricePerUnit = parseOptionalNumber(
    payload.price_per_unit,
    "price_per_unit",
  );
  const fees = parseOptionalNumber(payload.fees, "fees");
  const taxes = parseOptionalNumber(payload.taxes, "taxes");
  const fxRateToEur = parseOptionalNumber(
    payload.fx_rate_to_eur,
    "fx_rate_to_eur",
  );

  if (fxRateToEur !== undefined && fxRateToEur <= 0) {
    throw makeValidationError("fx_rate_to_eur must be positive");
  }

  const isUnitBasedAssetClass = assetClass
    ? UNIT_BASED_ASSET_CLASSES.has(assetClass)
    : false;

  if ((type === "buy" || type === "sell") && isUnitBasedAssetClass) {
    const math = normalizeBuySellMath({ amount, units, pricePerUnit });
    return {
      ...payload,
      dividend_amount_convention: dividendAmountConvention,
      ...math,
      fees: fees ?? 0,
      taxes: taxes ?? 0,
      fx_rate_to_eur: fxRateToEur,
    };
  }

  if (type === "buy" || type === "sell") {
    if (amount === undefined || amount <= 0) {
      throw makeValidationError("amount is required");
    }
    return {
      ...payload,
      dividend_amount_convention: dividendAmountConvention,
      amount,
      units,
      price_per_unit: pricePerUnit,
      fees: fees ?? 0,
      taxes: taxes ?? 0,
      fx_rate_to_eur: fxRateToEur,
    };
  }

  if (type === "gift") {
    if (assetClass && !UNIT_BASED_ASSET_CLASSES.has(assetClass)) {
      throw makeValidationError(
        "gift transactions are only supported for unit-based investments",
      );
    }
    if (units === undefined || units <= 0) {
      throw makeValidationError("gift transactions require units > 0");
    }
    if ((fees ?? 0) !== 0 || (taxes ?? 0) !== 0) {
      throw makeValidationError(
        "gift transactions must have 0 fees and 0 taxes",
      );
    }
    if (amount !== undefined && amount < 0) {
      throw makeValidationError("gift transaction amount cannot be negative");
    }

    return {
      ...payload,
      dividend_amount_convention: dividendAmountConvention,
      amount: amount ?? 0,
      units: roundMoney(units, 8),
      price_per_unit:
        pricePerUnit !== undefined ? roundMoney(pricePerUnit, 6) : undefined,
      fees: 0,
      taxes: 0,
      fx_rate_to_eur: fxRateToEur,
    };
  }

  if (amount === undefined) {
    throw makeValidationError("amount is required");
  }

  return {
    ...payload,
    dividend_amount_convention: dividendAmountConvention,
    amount,
    units,
    price_per_unit: pricePerUnit,
    fees: fees ?? 0,
    taxes: taxes ?? 0,
    fx_rate_to_eur: fxRateToEur,
  };
}

/** @param {Array<Record<string, any>>} rows */
function replayUnits(rows) {
  let net = toDecimal(0);
  for (const row of rows) {
    const units = toDecimal(row.units || 0);
    if (row.type === "buy" || row.type === "gift") net = net.plus(units);
    else if (row.type === "sell")
      net = toDecimal(Math.max(0, toNumber(net.minus(units))));
    else if (row.type === "split" && units.gt(0) && net.gt(0)) net = units; // absolute new total
  }
  return toNumber(net);
}

function onOrBefore(rows, date) {
  return rows.filter((row) => !row.date || String(row.date) <= String(date));
}

/**
 * Display label for a broker account, for user-facing validation errors.
 * @param {number} accountId
 * @returns {Promise<string>}
 */
async function getAccountLabel(accountId) {
  try {
    return await loadAccountLabel(accountId);
  } catch {
    return `account #${accountId}`;
  }
}

/**
 * Reject a sell that exceeds available units. Scope (ADR-108):
 *  - account-scoped when the sell names a broker account AND every lot row of
 *    the instrument is broker-assigned — you cannot sell at broker A what is
 *    held at broker B, even if investment-wide units would cover it; the
 *    error names the broker;
 *  - investment-global otherwise (unassigned sell, or transition rule: the
 *    instrument still has unassigned lots).
 *
 * @param {{ investmentId: any, assetClass: any, type?: any, date?: any, units?: any, accountId?: any, excludeTransactionId?: any, excludeTransactionIds?: any[], omitCandidate?: boolean, checkProjectedHistory?: boolean }} params
 */
export async function validatePortfolioUnitMutation({
  investmentId,
  assetClass,
  type,
  date,
  units,
  accountId,
  excludeTransactionId,
  excludeTransactionIds = [],
  omitCandidate = false,
  checkProjectedHistory = false,
}) {
  if (!UNIT_BASED_ASSET_CLASSES.has(assetClass)) return;
  if (type !== "sell" && !checkProjectedHistory) return;
  if (!investmentId || (!omitCandidate && !date)) return;

  const EPSILON = 1e-8;
  const rows = await getUnitEventsForInvestment(investmentId);
  const numericExcludedId = Number(excludeTransactionId);
  const excludedIds = new Set(
    [numericExcludedId, ...excludeTransactionIds.map(Number)].filter(
      (id) => Number.isInteger(id) && id > 0,
    ),
  );
  const retainedRows = rows.filter((row) => !excludedIds.has(Number(row.id)));
  const projectedRows = omitCandidate
    ? retainedRows
    : [
        ...retainedRows,
        {
          id: excludedIds.has(numericExcludedId)
            ? numericExcludedId
            : Number.MAX_SAFE_INTEGER,
          type,
          date: String(date),
          units: Number(units) || 0,
          account_id: accountId == null ? null : Number(accountId),
        },
      ];

  const sellUnits = Number(units) || 0;
  const numericAccountId = accountId == null ? undefined : Number(accountId);
  const accountScoped =
    type === "sell" &&
    sellUnits > 0 &&
    Number.isInteger(numericAccountId) &&
    numericAccountId > 0 &&
    areLotsFullyAssigned(projectedRows);

  if (!omitCandidate && type === "sell" && sellUnits > 0) {
    const priorRows = onOrBefore(retainedRows, date);
    let availableUnits;
    if (accountScoped) {
      const accountRows =
        partitionTxnsByAccount(priorRows).get(numericAccountId) ?? [];
      availableUnits = replayUnits(accountRows);
    } else {
      availableUnits = replayUnits(priorRows);
    }
    if (sellUnits - availableUnits > EPSILON) {
      if (!accountScoped) {
        throw makeValidationError("sell units exceed available holdings");
      }
      const label = await getAccountLabel(numericAccountId);
      throw makeValidationError(
        `sell units exceed available holdings at ${label} ` +
          `(${toNumber(roundMoney(availableUnits, 8))} units held there)`,
      );
    }
  }

  if (checkProjectedHistory || type === "sell") {
    const before = partitionOversellDeficits(rows);
    const after = partitionOversellDeficits(projectedRows);
    for (const [oversoldAccountId, deficit] of after) {
      if (deficit - (before.get(oversoldAccountId) ?? 0) > EPSILON) {
        const label = await getAccountLabel(oversoldAccountId);
        throw makeValidationError(
          `change would create or worsen an oversold partition at ${label}`,
        );
      }
    }
  }
}

export const __validateSellUnitsAvailability = validatePortfolioUnitMutation;
