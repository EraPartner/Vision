/**
 * Split calculations — pure functions for transaction-split math.
 *
 * Phase 4 of the non-portfolio refactor. Centralizes the overpayment /
 * over-allocation guards plus the owed-summary projection so the validation
 * logic can be golden-tested independent of Postgres. Repository layer reads
 * from agg_split_outstanding (trigger-maintained by migration 0026); this
 * module transforms those rows into the API response shape and enforces
 * server-side invariants before writes hit the DB.
 *
 * All functions are pure: no I/O, no mutation of inputs.
 */

import {
  addAll,
  toNumber,
  toDecimal,
  roundToCents as roundToCentsDecimal,
  Decimal,
} from "../money.js";

/**
 * Storage scale of split/payment money columns: NUMERIC(18,4) since migration
 * 0088 (ADR-060 D7 — 18,4 is the domain money precision).
 */
export const MONEY_DECIMALS = 4;

/**
 * Round to the NUMERIC(18,4) storage precision (banker's rounding), as a
 * Decimal. Validation MUST compare at this scale, not at cents: storage keeps
 * 4 decimals, so a cap checked at 2 dp but stored at 4 dp admits sub-cent
 * over-payments/over-allocations (two 25.0025 payments both pass a 50.00 cap
 * rounded to cents, yet their stored sum is 50.0050).
 *
 * @param {number|string|import('decimal.js').default} value
 * @returns {import('decimal.js').default}
 */
export function roundToMoneyPrecision(value) {
  return toDecimal(value).toDecimalPlaces(
    MONEY_DECIMALS,
    Decimal.ROUND_HALF_EVEN,
  );
}

/**
 * Normalize a JS money input to exactly the value NUMERIC(18,4) will store.
 * Apply at the write boundary so the amount that was validated IS the amount
 * that is stored (same idea as the old roundToCents-before-INSERT, but at the
 * domain precision instead of cents — 2-dp inputs pass through unchanged).
 *
 * @param {number|string|import('decimal.js').default} value
 * @returns {number}
 */
export function normalizeMoneyAmount(value) {
  return toNumber(roundToMoneyPrecision(value));
}

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {string | null} error — null when ok === true
 */

/**
 * Raw projection of splitRepository.getOwedSummaryRows' aggregate query — see
 * that file for the SQL. `total_owed`/`total_paid` are `SUM(NUMERIC)`, which
 * pg emits as strings; `split_count` is `COUNT(...)`, also a string (bigint
 * on the wire).
 * @typedef {object} SplitOutstandingRow
 * @property {number} recipient_id
 * @property {string} recipient_name
 * @property {string} total_owed
 * @property {string} total_paid
 * @property {string} split_count
 */

/**
 * @typedef {object} OwedSummaryRow
 * @property {number} recipient_id
 * @property {string} recipient_name
 * @property {number} total_owed
 * @property {number} total_paid
 * @property {number} remaining
 * @property {number} split_count
 */

/**
 * Round to cents using Decimal-backed banker's rounding.
 * @param {number|string|import('decimal.js').default} value
 * @returns {number}
 */
export function roundToCents(value) {
  return toNumber(roundToCentsDecimal(value));
}

/**
 * Validate a candidate split against the transaction's allocation state.
 * Split total across a transaction must never exceed the transaction's
 * absolute amount.
 *
 * @param {{
 *   newSplitAmount: number,
 *   transactionTotal: number,
 *   currentSplitTotal: number,
 * }} input
 * @returns {ValidationResult}
 */
export function validateSplitAllocation({
  newSplitAmount,
  transactionTotal,
  currentSplitTotal,
}) {
  if (!Number.isFinite(newSplitAmount) || newSplitAmount <= 0) {
    return { ok: false, error: "Split amount must be a positive number" };
  }
  // Compare at the NUMERIC(18,4) storage precision: existing totals arrive
  // exact from the DB, and callers normalize the candidate via
  // normalizeMoneyAmount, so projected-vs-limit here is exactly the
  // comparison Postgres would see after INSERT.
  const projected = roundToMoneyPrecision(
    toDecimal(currentSplitTotal).plus(newSplitAmount),
  );
  const limit = roundToMoneyPrecision(transactionTotal);
  if (projected.gt(limit)) {
    return { ok: false, error: "Split amount exceeds transaction total" };
  }
  return { ok: true, error: null };
}

/**
 * Validate a batch of candidate splits against the transaction's allocation
 * state. Sums the new splits and delegates to {@link validateSplitAllocation}.
 *
 * @param {{
 *   splits: Array<{ amount: number }>,
 *   transactionTotal: number,
 *   currentSplitTotal: number,
 * }} input
 * @returns {ValidationResult}
 */
export function validateBatchSplitAllocation({
  splits,
  transactionTotal,
  currentSplitTotal,
}) {
  if (!Array.isArray(splits) || splits.length === 0) {
    return { ok: false, error: "Splits must be a non-empty array" };
  }
  const amounts = [];
  for (const split of splits) {
    const amount = Number(split?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "Split amount must be a positive number" };
    }
    amounts.push(amount);
  }
  const sum = toNumber(addAll(amounts));
  return validateSplitAllocation({
    newSplitAmount: sum,
    transactionTotal,
    currentSplitTotal,
  });
}

/**
 * Validate a candidate payment against a split's paid state.
 * Sum of payments against a split must never exceed the split's amount.
 *
 * @param {{
 *   paymentAmount: number,
 *   splitAmount: number,
 *   alreadyPaid: number,
 * }} input
 * @returns {ValidationResult}
 */
export function validatePaymentAmount({
  paymentAmount,
  splitAmount,
  alreadyPaid,
}) {
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    return { ok: false, error: "Payment amount must be a positive number" };
  }
  // Same storage-precision comparison as validateSplitAllocation — a cent-level
  // cap would re-admit the sub-cent over-payment regression (see migration 0088).
  const projected = roundToMoneyPrecision(
    toDecimal(alreadyPaid).plus(paymentAmount),
  );
  const limit = roundToMoneyPrecision(splitAmount);
  if (projected.gt(limit)) {
    return {
      ok: false,
      error: "Payment would exceed split outstanding balance",
    };
  }
  return { ok: true, error: null };
}

/**
 * Compute the remaining balance on a single split.
 * @param {{ amount: number, amount_paid?: number }} split
 * @returns {number}
 */
function computeSplitRemaining(split) {
  const amount = Number(split?.amount) || 0;
  const paid = Number(split?.amount_paid) || 0;
  const remaining = toDecimal(amount).minus(toDecimal(paid));
  return roundToCents(remaining.lessThan(0) ? toDecimal(0) : remaining);
}

export { computeSplitRemaining as __computeSplitRemaining };

/**
 * Project outstanding-balance rows (from agg_split_outstanding joined to
 * recipients) into the owed-summary API shape. Filters out zero-balance
 * rows (fully paid / settled) and sorts by remaining descending.
 *
 * Input row shape:
 *   { recipient_id, recipient_name, total_owed, total_paid, split_count }
 *
 * Output row shape adds `remaining` and is sorted by `remaining DESC`.
 *
 * @param {SplitOutstandingRow[]} rows
 * @returns {OwedSummaryRow[]}
 */
export function computeOwedSummary(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const totalOwed = roundToCents(Number(row.total_owed) || 0);
      const totalPaid = roundToCents(Number(row.total_paid) || 0);
      const remaining = roundToCents(Math.max(0, totalOwed - totalPaid));
      return {
        recipient_id: row.recipient_id,
        recipient_name: row.recipient_name,
        total_owed: totalOwed,
        total_paid: totalPaid,
        remaining,
        split_count: parseInt(row.split_count, 10) || 0,
      };
    })
    .filter((row) => row.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);
}

export default {
  roundToCents,
  roundToMoneyPrecision,
  normalizeMoneyAmount,
  validateSplitAllocation,
  validateBatchSplitAllocation,
  validatePaymentAmount,
  computeSplitRemaining,
  computeOwedSummary,
};
