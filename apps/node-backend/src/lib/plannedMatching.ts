import { differenceInCalendarDaysYmd } from "./timezone.ts";
import { normalizeDateLikeToYmd } from "./dateFormat.ts";
const AMOUNT_TOLERANCE_PCT = 5;
export const DATE_WINDOW_DAYS = 5;
export type PlannedLike = {
  recipient_cluster_id?: number | string | null;
  currency?: string | null | undefined;
  amount: number | string;
  planned_date?: Date | string | null;
};

/**
 * The fields `matchesTolerance` reads off a transaction side — same looseness
 * rationale as `PlannedLike`.
 */
export type TxLike = {
  recipient_cluster_id?: number | string | null;
  currency?: string | null | undefined;
  amount: number | string;
  transaction_date?: Date | string | null | undefined;
};

export function matchesTolerance(
  planned: PlannedLike | null | undefined,
  tx: TxLike | null | undefined,
): boolean {
  if (planned?.recipient_cluster_id == null || tx?.recipient_cluster_id == null)
    return false;
  if (Number(planned.recipient_cluster_id) !== Number(tx.recipient_cluster_id))
    return false;

  if (
    !planned.currency ||
    !tx.currency ||
    planned.currency.toUpperCase() !== tx.currency.toUpperCase()
  )
    return false;

  const pAmt = Number(planned.amount);
  const tAmt = Number(tx.amount);
  if (!Number.isFinite(pAmt) || !Number.isFinite(tAmt)) return false;
  if (pAmt === 0 || tAmt === 0) return false;
  if (Math.sign(pAmt) !== Math.sign(tAmt)) return false;

  const p = Math.abs(pAmt);
  const t = Math.abs(tAmt);
  // Mirror LinkTransactionDialog's amount test (max(1, 5%)) so manual and
  // automatic matching agree on what "close enough" means.
  const tol = Math.max(1, p * (AMOUNT_TOLERANCE_PCT / 100));
  if (Math.abs(t - p) > tol) return false;

  const pDate = normalizeDateLikeToYmd(planned.planned_date);
  const tDate = normalizeDateLikeToYmd(tx.transaction_date);
  if (!pDate || !tDate) return false;
  if (Math.abs(differenceInCalendarDaysYmd(pDate, tDate)) > DATE_WINDOW_DAYS)
    return false;

  return true;
}
