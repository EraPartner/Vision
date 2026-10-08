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

import type { DecimalInput } from "../money.ts";
import {
  addAll,
  toNumber,
  toDecimal,
  roundToCents as roundToCentsDecimal,
  Decimal,
} from "../money.ts";

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
 */
export function roundToMoneyPrecision(value: number | string | Decimal): Decimal {
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
 */
export function normalizeMoneyAmount(value: number | string | Decimal): number {
  return toNumber(roundToMoneyPrecision(value));
}

/** `error` is null when ok === true. */
export type ValidationResult =
  | { ok: true; error: null }
  | { ok: false; error: string };

/**
 * Raw projection of splitRepository.getOwedSummaryRows' aggregate query — see
 * that file for the SQL. `total_owed`/`total_paid` are `SUM(NUMERIC)`, which
 * pg emits as strings; `split_count` is `COUNT(...)`, also a string (bigint
 * on the wire).
 */
export interface SplitOutstandingRow {
  recipient_id: number;
  recipient_name: string;
  total_owed: string;
  total_paid: string;
  split_count: string;
}

export interface OwedSummaryRow {
  recipient_id: number;
  recipient_name: string;
  total_owed: number;
  total_paid: number;
  remaining: number;
  split_count: number;
}

/**
 * Round to cents using Decimal-backed banker's rounding.
 */
export function roundToCents(value: DecimalInput): number {
  return toNumber(roundToCentsDecimal(value));
}

/**
 * Validate a candidate split against the transaction's allocation state.
 * Split total across a transaction must never exceed the transaction's
 * absolute amount.
 */
export function validateSplitAllocation({
  newSplitAmount,
  transactionTotal,
  currentSplitTotal,
}: {
  newSplitAmount: number;
  transactionTotal: number;
  currentSplitTotal: number;
}): ValidationResult {
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
 */
export function validateBatchSplitAllocation({
  splits,
  transactionTotal,
  currentSplitTotal,
}: {
  splits: Array<{ amount: number }>;
  transactionTotal: number;
  currentSplitTotal: number;
}): ValidationResult {
  if (!Array.isArray(splits) || splits.length === 0) {
    return { ok: false, error: "Splits must be a non-empty array" };
  }
  const amounts: number[] = [];
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
 * Preset shares for the bulk split action (POST /api/splits/bulk) and the
 * split dialog's presets. One other person is always assumed on the bulk
 * route; the dialog generalizes "full" to N others.
 *
 *   - `equal`: the other person owes half (50/50).
 *   - `full`:  the other person owes the whole amount (0/100 — the caller
 *              pays nothing).
 */
export type BulkSplitMode = "equal" | "full";

export const BULK_SPLIT_MODES: readonly BulkSplitMode[] = ["equal", "full"];

/**
 * The amount one other person owes on a transaction under a preset, rounded
 * to cents (banker's rounding). Returns 0 for a zero or non-finite total so
 * callers can skip the row instead of writing a non-positive split.
 */
export function computeBulkSplitAmount({
  transactionTotal,
  mode,
}: {
  transactionTotal: number;
  mode: BulkSplitMode;
}): number {
  const total = toDecimal(transactionTotal).abs();
  if (!total.isFinite() || total.isZero()) return 0;
  return roundToCents(mode === "full" ? total : total.div(2));
}

/**
 * Validate a candidate payment against a split's paid state.
 * Sum of payments against a split must never exceed the split's amount.
 */
export function validatePaymentAmount({
  paymentAmount,
  splitAmount,
  alreadyPaid,
}: {
  paymentAmount: number;
  splitAmount: number;
  alreadyPaid: number;
}): ValidationResult {
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
 */
function computeSplitRemaining(split: {
  amount: number;
  amount_paid?: number;
}): number {
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
 */
export function computeOwedSummary(rows: SplitOutstandingRow[]): OwedSummaryRow[] {
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
  computeBulkSplitAmount,
  roundToMoneyPrecision,
  normalizeMoneyAmount,
  validateSplitAllocation,
  validateBatchSplitAllocation,
  validatePaymentAmount,
  computeSplitRemaining,
  computeOwedSummary,
};
