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

// Currency amounts in this app are stored as NUMERIC(15, 2). Use 1 cent as
// the tolerance for float-rounding artifacts after JSON round-tripping.
const CENT_TOLERANCE = 0.005;

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {string | null} error — null when ok === true
 */

/**
 * Round to cents to avoid binary-float drift when summing many payments.
 * @param {number} value
 * @returns {number}
 */
export function roundToCents(value) {
  return Math.round(value * 100) / 100;
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
    return { ok: false, error: 'Split amount must be a positive number' };
  }
  const projected = roundToCents(currentSplitTotal + newSplitAmount);
  if (projected > roundToCents(transactionTotal) + CENT_TOLERANCE) {
    return { ok: false, error: 'Split amount exceeds transaction total' };
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
    return { ok: false, error: 'Splits must be a non-empty array' };
  }
  let sum = 0;
  for (const split of splits) {
    const amount = Number(split?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: 'Split amount must be a positive number' };
    }
    sum += amount;
  }
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
    return { ok: false, error: 'Payment amount must be a positive number' };
  }
  const projected = roundToCents(alreadyPaid + paymentAmount);
  if (projected > roundToCents(splitAmount) + CENT_TOLERANCE) {
    return { ok: false, error: 'Payment would exceed split outstanding balance' };
  }
  return { ok: true, error: null };
}

/**
 * Compute the remaining balance on a single split.
 * @param {{ amount: number, amount_paid?: number }} split
 * @returns {number}
 */
export function computeSplitRemaining(split) {
  const amount = Number(split?.amount) || 0;
  const paid = Number(split?.amount_paid) || 0;
  return roundToCents(Math.max(0, amount - paid));
}

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
 * @param {Array<object>} rows
 * @returns {Array<object>}
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
    .filter((row) => row.remaining > CENT_TOLERANCE)
    .sort((a, b) => b.remaining - a.remaining);
}

export default {
  roundToCents,
  validateSplitAllocation,
  validateBatchSplitAllocation,
  validatePaymentAmount,
  computeSplitRemaining,
  computeOwedSummary,
};
