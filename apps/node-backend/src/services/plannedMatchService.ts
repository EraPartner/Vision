/**
 * Planned-match service.
 *
 * Decides when an incoming real transaction should auto-clear a planned
 * payment, and surfaces near-misses as confirm-able suggestions.
 *
 * Auto-link safety rule (confirmed product decision): a (tx, planned) pair is
 * auto-executed ONLY when the match is mutually unambiguous —
 *   1. the transaction matches exactly one active, unexecuted planned payment, and
 *   2. that planned payment is matched by exactly one transaction in the batch.
 * Anything else is left untouched and shows up under getMatchSuggestions().
 *
 * Match tolerance (moderate): same recipient cluster and currency, same sign, amount within
 * ±5%, transaction date within ±5 days of the planned date.
 */

import plannedTransactionRepository from "../repositories/plannedTransactionRepository.ts";
import transactionRepository from "../repositories/transactionRepository.ts";
import recipientRepository from "../repositories/recipientRepository.ts";
import settingsRepository, {
  settingField,
} from "../repositories/settingsRepository.ts";
import { executePlanned } from "./plannedExecutionService.ts";
import { addDaysYmd, todayAppDateString } from "../lib/timezone.ts";
import { toDecimal, toNumber } from "../lib/money.ts";
import { normalizeDateLikeToYmd } from "../lib/dateFormat.ts";
import { logger } from "../config/logger.ts";
import type { PlannedMatchCandidateRow } from "../types/rows.ts";
import type {
  PlannedTransactionId,
  RecipientId,
  TransactionId,
} from "@vision/types/brands";

import { matchesTolerance, DATE_WINDOW_DAYS } from "../lib/plannedMatching.ts";
const SUGGESTION_LOOKBACK_DAYS = 45;

function calendarDayOrdinal(value: unknown): number | undefined {
  const day = normalizeDateLikeToYmd(value);
  if (!day) return undefined;
  // Normalize pg DATE values with local getters first, then use a UTC day grid.
  // Integer offsets cannot cross a daylight-saving boundary by 23 or 25 hours.
  const ordinal = Date.parse(`${day}T00:00:00.000Z`) / 86_400_000;
  return Number.isInteger(ordinal) ? ordinal : undefined;
}

/** An ingested transaction offered to `autoLinkTransactions`. */
export type AutoLinkTxRow = {
  id: TransactionId;
  currency?: string | null;
  recipient_id?: RecipientId | null;
  amount: number | string;
  transaction_date?: Date | string | null;
  date?: Date | string | null;
};

export interface AutoLinkResult {
  autoLinkedCount: number;
  links: Array<{
    plannedTransactionId: PlannedTransactionId;
    transactionId: TransactionId;
  }>;
}

export interface PlannedMatchSuggestion {
  planned: {
    id: number;
    recipient_id: number | null;
    recipient_name: string | null;
    amount: number;
    planned_date: string | undefined;
    currency: string | null;
    is_recurring: boolean;
  };
  candidates: Array<{
    id: number;
    recipient_name: string | null;
    amount: number;
    transaction_date: string | undefined;
    currency: string | null;
    memo: string | null;
  }>;
}

/**
 * Pure predicate: does `tx` fall within tolerance of planned payment `planned`?
 * Both objects must carry `recipient_cluster_id`, `amount`, and a date
 * (`planned_date` / `transaction_date`).
 */
export { matchesTolerance as __matchesTolerance };

// NOTE: a findAutoLinkTarget(tx, activePlanned) helper used to live here, but
// it only checked single-direction uniqueness while the real rule inside
// autoLinkTransactions is mutual uniqueness (both match directions). It had no
// production callers and its passing tests created false confidence that the
// weaker rule was the live one, so it was removed.

async function isAutoClearEnabled() {
  try {
    const settings = await settingsRepository.get("app_settings");
    return settingField(settings, "autoClearPlannedOnMatch") !== false; // default ON
  } catch {
    return true;
  }
}

/**
 * Auto-link a batch of freshly-ingested transactions to matching planned
 * payments. Each input row needs at least `{ id, recipient_id, amount }` plus a
 * date (`transaction_date` or `date`). Never throws — per-pair failures are
 * logged and skipped so an import/create never fails because of auto-link.
 */
export async function autoLinkTransactions(
  txRows: AutoLinkTxRow[],
): Promise<AutoLinkResult> {
  const result: AutoLinkResult = { autoLinkedCount: 0, links: [] };
  if (!Array.isArray(txRows) || txRows.length === 0) return result;
  if (!(await isAutoClearEnabled())) return result;

  const activePlanned =
    await plannedTransactionRepository.listActiveUnexecuted();
  if (activePlanned.length === 0) return result;

  const clusterMap = await recipientRepository.getClusterRootMap(
    txRows.map((t) => t?.recipient_id),
  );

  const txs = txRows
    .filter(
      (t): t is AutoLinkTxRow & { recipient_id: RecipientId } =>
        Boolean(t) && t.id != null && t.recipient_id != null,
    )
    .map((t) => ({
      id: t.id,
      amount: t.amount,
      currency: t.currency,
      transaction_date: t.transaction_date ?? t.date,
      recipient_cluster_id: clusterMap.get(t.recipient_id) ?? t.recipient_id,
    }));

  // Build both match directions so a pair only auto-links when it is mutually
  // unambiguous (see the safety rule at the top of this file).
  const candidatesByTx = new Map<TransactionId, PlannedMatchCandidateRow[]>();
  const txIdsByPlanned = new Map<PlannedTransactionId, TransactionId[]>();
  const buckets = new Map<string, PlannedMatchCandidateRow[]>();
  for (const planned of activePlanned) {
    const day = calendarDayOrdinal(planned.planned_date);
    if (day === undefined) continue;
    const key = `${planned.recipient_cluster_id}:${planned.currency?.toUpperCase()}:${Math.sign(Number(planned.amount))}:${day}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(planned);
    buckets.set(key, bucket);
  }
  for (const tx of txs) {
    const day = calendarDayOrdinal(tx.transaction_date);
    const matches: PlannedMatchCandidateRow[] = [];
    if (day !== undefined)
      for (
        let offset = -DATE_WINDOW_DAYS;
        offset <= DATE_WINDOW_DAYS;
        offset++
      ) {
        const key = `${tx.recipient_cluster_id}:${tx.currency?.toUpperCase()}:${Math.sign(Number(tx.amount))}:${day + offset}`;
        for (const planned of buckets.get(key) ?? []) {
          if (matchesTolerance(planned, tx)) matches.push(planned);
        }
      }
    candidatesByTx.set(tx.id, matches);
    for (const planned of matches) {
      let txIds = txIdsByPlanned.get(planned.id);
      if (!txIds) {
        txIds = [];
        txIdsByPlanned.set(planned.id, txIds);
      }
      txIds.push(tx.id);
    }
  }

  for (const tx of txs) {
    const matches = candidatesByTx.get(tx.id);
    const planned = matches?.length === 1 ? matches[0] : undefined;
    if (!planned) continue;
    if ((txIdsByPlanned.get(planned.id) ?? []).length !== 1) continue;

    try {
      const { duplicate } = await executePlanned({
        id: planned.id,
        executedTransactionId: tx.id,
        executionDate: normalizeDateLikeToYmd(tx.transaction_date),
        expectedOccurrence: normalizeDateLikeToYmd(planned.planned_date),
        hydrateResult: false,
      });
      if (!duplicate) {
        result.autoLinkedCount += 1;
        result.links.push({
          plannedTransactionId: planned.id,
          transactionId: tx.id,
        });
      }
    } catch (err) {
      logger.warn("[auto-link] execute failed", {
        plannedId: planned.id,
        txId: tx.id,
        error: err instanceof Error ? err.message : undefined,
      });
    }
  }

  return result;
}

/**
 * Read-time view of planned payments that have one or more matching unlinked
 * transactions but were not auto-cleared (ambiguous matches, or auto-clear off).
 * The user confirms which transaction clears each planned payment.
 */
export async function getMatchSuggestions(): Promise<PlannedMatchSuggestion[]> {
  const activePlanned =
    await plannedTransactionRepository.listActiveUnexecuted();
  if (activePlanned.length === 0) return [];

  const sinceDate = addDaysYmd(todayAppDateString(), -SUGGESTION_LOOKBACK_DAYS);
  const recentTx = await transactionRepository.listRecentUnlinked({
    sinceDate,
  });
  if (recentTx.length === 0) return [];

  const suggestions: PlannedMatchSuggestion[] = [];
  for (const planned of activePlanned) {
    const candidates = recentTx.filter((tx) => matchesTolerance(planned, tx));
    if (candidates.length === 0) continue;
    suggestions.push({
      planned: {
        id: planned.id,
        recipient_id: planned.recipient_id,
        recipient_name: planned.recipient_name ?? null,
        amount: toNumber(toDecimal(planned.amount)),
        planned_date: normalizeDateLikeToYmd(planned.planned_date),
        currency: planned.currency ?? null,
        is_recurring: planned.is_recurring,
      },
      candidates: candidates.map((tx) => ({
        id: tx.id,
        recipient_name: tx.recipient_name ?? null,
        amount: toNumber(toDecimal(tx.amount)),
        transaction_date: normalizeDateLikeToYmd(tx.transaction_date),
        currency: tx.currency ?? null,
        memo: tx.memo ?? null,
      })),
    });
  }
  return suggestions;
}
