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
} from "../../repositories/portfolioTxRepo.reads.ts";
import { hasAssetTransfersForInvestment } from "../../repositories/portfolioAssetTransferRepository.ts";
import { RowContractError } from "../../database/rowContracts.ts";
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
} from "../../lib/money.ts";
import { VALID_PORTFOLIO_TXN_TYPES } from "../../lib/portfolioTxnTypes.ts";
import { makeValidationError } from "../../lib/repositoryErrors.ts";
import { UNIT_BASED_ASSET_CLASSES as UNIT_BASED_ASSET_CLASS_LIST } from "@vision/types/assetClasses";
import { PORTFOLIO_RECURRENCE_INTERVALS } from "@vision/types/recurrence";
import type { PartitionedTxnLike } from "@vision/shared-utils/portfolio";
import type { DecimalInput } from "../../lib/money.ts";
import type { PortfolioUnitEventRow } from "../../repositories/portfolioTxRepo.reads.ts";

export type PortfolioTransactionRow =
  import("../../types/rows.ts").PortfolioTransactionRow;

/**
 * The caller-facing portfolio-transaction payload, before/after
 * {@link normalizeTransactionPayload} fills in the derived unit math.
 */
export interface PortfolioTransactionInput {
  investment_id: number;
  type: string;
  /** 'YYYY-MM-DD' */
  date: string;
  /** `null` reaches here from a JSON body that sends `"amount": null`. */
  amount?: number | string | null;
  units?: number | string | null;
  price_per_unit?: number | string | null;
  fees?: number | string | null;
  taxes?: number | string | null;
  dividend_amount_convention?: "gross" | "net" | "unknown";
  currency?: string;
  note?: string | null;
  is_recurring?: boolean;
  recurrence_interval?: string | null;
  recurrence_end_date?: string | null;
  fx_rate_to_eur?: number | string | null;
  account_id?: number | null;
  /**
   * The portfolio import batch that
   *           created this lot (migration 0086) — set only by the import commit path,
   *           NULL for manual entry. Rollback bulk-deletes on it.
   */
  import_batch_id?: number | string | null;
  preloaded_asset_class?: string;
  source_record_hash?: string | null;
  dedup_fingerprint?: string | null;
  dedup_fingerprint_version?: number | null;
}

// The canonical recurrence vocabulary is shared with planned transactions.
// Migration 0099 replaces the legacy enum column with a checked text column.
// Widened to Set<string>: callers probe raw, untrusted values with .has().
export const VALID_RECURRENCE_INTERVALS = new Set<string>(
  PORTFOLIO_RECURRENCE_INTERVALS,
);

// Derived from the shared canonical subset (@vision/types/assetClasses) so it
// cannot drift from the frontend's copy. Widened to Set<string>: callers probe
// raw payload values with .has().
export const UNIT_BASED_ASSET_CLASSES = new Set<string>(
  UNIT_BASED_ASSET_CLASS_LIST,
);

type DividendAmountConvention = "gross" | "net" | "unknown";

function isDividendAmountConvention(
  value: unknown,
): value is DividendAmountConvention {
  return new Set<unknown>(["gross", "net", "unknown"]).has(value);
}

/**
 * The payload fields {@link normalizeTransactionPayload} validates and
 * rewrites. Callers pass the full API/import payload (or a stored row merged
 * with a patch); every other field is passed through unchanged.
 */
export interface NormalizableTransactionPayload {
  type?: string | null;
  recurrence_interval?: string | null;
  dividend_amount_convention?: string | null;
  amount?: unknown;
  units?: unknown;
  price_per_unit?: unknown;
  fees?: unknown;
  taxes?: unknown;
  fx_rate_to_eur?: unknown;
}

/** The fields {@link normalizeTransactionPayload} always (re)writes. */
export type NormalizedTransactionFields = {
  dividend_amount_convention: DividendAmountConvention;
  amount: number | undefined;
  units: number | undefined;
  price_per_unit: number | undefined;
  fees: number;
  taxes: number;
  fx_rate_to_eur: number | undefined;
};

/**
 * A caller-supplied candidate row projected into a unit-event history by
 * {@link validatePortfolioUnitMutation}.
 */
type ProjectedUnitEvent = Record<string, unknown> & {
  id: number;
  type: string | undefined;
  date: string;
  units: number;
  account_id: number | null;
};

/**
 * The shared engine's transaction shape as the repositories deliver it: any
 * field may be absent or SQL NULL.
 */
export type NullablePartitionedTxn = {
  [K in keyof PartitionedTxnLike]?: PartitionedTxnLike[K] | null;
};

/**
 * View unit-event rows as the shared partition engine's transaction shape.
 * The pg rows carry SQL NULLs (and projected candidates loose payload values)
 * where the engine declares optional fields; that is the existing runtime
 * contract between the repository and the engine, unchanged here.
 */
export function asPartitionedTxns(
  rows: readonly NullablePartitionedTxn[],
): readonly PartitionedTxnLike[] {
  return rows as readonly PartitionedTxnLike[];
}

function parseOptionalNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw makeValidationError(`${fieldName} must be a valid number`);
  }
  return parsed;
}

function normalizeBuySellMath({
  amount,
  units,
  pricePerUnit,
}: {
  amount?: number;
  units?: number;
  pricePerUnit?: number;
}): { amount: number; units: number; price_per_unit: number } {
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
    (units !== undefined && units <= 0) ||
    (pricePerUnit !== undefined && pricePerUnit <= 0) ||
    (amount !== undefined && amount <= 0)
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

export function normalizeTransactionPayload<
  P extends NormalizableTransactionPayload,
>(
  payload: P,
  { assetClass }: { assetClass?: string } = {},
): Omit<P, keyof NormalizedTransactionFields> & NormalizedTransactionFields {
  const type = payload.type;
  const recurrenceInterval = payload.recurrence_interval;
  const normalizedPayload = { ...payload };
  // Membership guard: an unknown type ('banana') otherwise inserted (invisible
  // to the units replay) or reached the enum column as a raw cast 500. The
  // import pipeline already constrains types to this same canonical set, so this
  // only rejects genuine garbage on the direct-API/update paths.
  if (type != null && !VALID_PORTFOLIO_TXN_TYPES.has(type)) {
    throw makeValidationError(`Invalid transaction type: ${type}`);
  }
  // recurrence_interval is checked in the database after migration 0099; reject
  // invalid values at the domain boundary so they never surface as DB errors.
  if (
    recurrenceInterval != null &&
    recurrenceInterval !== "" &&
    !VALID_RECURRENCE_INTERVALS.has(recurrenceInterval)
  ) {
    throw makeValidationError(
      `Invalid recurrence_interval: ${payload.recurrence_interval}`,
    );
  }
  const dividendAmountConvention =
    payload.dividend_amount_convention ?? "unknown";
  if (!isDividendAmountConvention(dividendAmountConvention)) {
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
      ...normalizedPayload,
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
      ...normalizedPayload,
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
      ...normalizedPayload,
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
    ...normalizedPayload,
    dividend_amount_convention: dividendAmountConvention,
    amount,
    units,
    price_per_unit: pricePerUnit,
    fees: fees ?? 0,
    taxes: taxes ?? 0,
    fx_rate_to_eur: fxRateToEur,
  };
}

function replayUnits(
  rows: readonly { type?: string; units?: DecimalInput }[],
): number {
  let net = toDecimal(0);
  for (const row of rows) {
    const units = toDecimal(row.units || 0);
    if (row.type === "buy" || row.type === "gift" || row.type === "transfer_in")
      net = net.plus(units);
    else if (
      row.type === "transfer_out" ||
      row.type === "asset_fee" ||
      row.type === "unit_reversal"
    )
      net = net.minus(units);
    else if (row.type === "sell")
      net = toDecimal(Math.max(0, toNumber(net.minus(units))));
    else if (row.type === "split" && units.gt(0) && net.gt(0)) net = units; // absolute new total
  }
  return toNumber(net);
}

function onOrBefore<R extends { date?: string | null }>(
  rows: R[],
  date: string | undefined,
): R[] {
  return rows.filter((row) => !row.date || String(row.date) <= String(date));
}

/** Display label for a broker account, for user-facing validation errors. */
async function getAccountLabel(accountId: number): Promise<string> {
  try {
    return await loadAccountLabel(accountId);
  } catch (error) {
    // A contract violation is a data fault, not a lookup miss: surface it.
    if (error instanceof RowContractError) throw error;
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
 */
export async function validatePortfolioUnitMutation({
  investmentId,
  assetClass,
  type,
  date,
  units,
  accountId,
  candidate = {},
  excludeTransactionId,
  excludeTransactionIds = [],
  omitCandidate = false,
  checkProjectedHistory = false,
}: UnitMutationParams): Promise<void> {
  if (assetClass === undefined || !UNIT_BASED_ASSET_CLASSES.has(assetClass))
    return;
  if (
    (type === "buy" || type === "gift") &&
    accountId == null &&
    !omitCandidate &&
    !checkProjectedHistory &&
    investmentId &&
    (await hasAssetTransfersForInvestment(investmentId))
  )
    throw makeValidationError(
      "Acquisitions must name their custody account when asset transfer history exists",
    );
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
  const projectedRows: (PortfolioUnitEventRow | ProjectedUnitEvent)[] =
    omitCandidate
      ? retainedRows
      : [
          ...retainedRows,
          {
            ...candidate,
            id: excludedIds.has(numericExcludedId)
              ? numericExcludedId
              : Number.MAX_SAFE_INTEGER,
            type,
            date: String(date),
            units: Number(units) || 0,
            account_id: accountId == null ? null : Number(accountId),
          },
        ];

  if (
    projectedRows.some(
      (row) => row.type === "asset_transfer" || row.type === "asset_adjustment",
    ) &&
    !areLotsFullyAssigned(asPartitionedTxns(projectedRows))
  )
    throw makeValidationError(
      "Acquisitions and sales must name their custody account when asset transfer history exists",
    );

  const sellUnits = Number(units) || 0;
  const numericAccountId = accountId == null ? undefined : Number(accountId);
  const accountScoped =
    type === "sell" &&
    sellUnits > 0 &&
    numericAccountId !== undefined &&
    Number.isInteger(numericAccountId) &&
    numericAccountId > 0 &&
    areLotsFullyAssigned(asPartitionedTxns(projectedRows));

  if (!omitCandidate && type === "sell" && sellUnits > 0) {
    const priorRows = onOrBefore(retainedRows, date);
    let availableUnits;
    if (accountScoped) {
      // accountScoped implies numericAccountId is a positive integer (above).
      const accountRows =
        partitionTxnsByAccount(asPartitionedTxns(priorRows)).get(
          numericAccountId!,
        ) ?? [];
      availableUnits = replayUnits(accountRows);
    } else {
      availableUnits = replayUnits(priorRows);
    }
    if (sellUnits - availableUnits > EPSILON) {
      if (!accountScoped) {
        throw makeValidationError("sell units exceed available holdings");
      }
      const label = await getAccountLabel(numericAccountId!);
      throw makeValidationError(
        `sell units exceed available holdings at ${label} ` +
          `(${toNumber(roundMoney(availableUnits, 8))} units held there)`,
      );
    }
  }

  if (checkProjectedHistory || type === "sell") {
    const before = partitionOversellDeficits(asPartitionedTxns(rows));
    const after = partitionOversellDeficits(asPartitionedTxns(projectedRows));
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

/** Parameters of {@link validatePortfolioUnitMutation}. */
export interface UnitMutationParams {
  investmentId: number;
  assetClass: string | undefined;
  type?: string;
  /** 'YYYY-MM-DD' */
  date?: string;
  units?: number | string | null;
  accountId?: number | string | null;
  /** The would-be row merged into the projected history. */
  candidate?: Record<string, unknown>;
  excludeTransactionId?: number | string;
  excludeTransactionIds?: readonly (number | string)[];
  omitCandidate?: boolean;
  checkProjectedHistory?: boolean;
}

export const __validateSellUnitsAvailability = validatePortfolioUnitMutation;
