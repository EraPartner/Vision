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
 * Match tolerance (moderate): same recipient cluster, same sign, amount within
 * ±5%, transaction date within ±5 days of the planned date.
 */

import plannedTransactionRepository from '../repositories/plannedTransactionRepository.js';
import transactionRepository from '../repositories/transactionRepository.js';
import recipientRepository from '../repositories/recipientRepository.js';
import settingsRepository from '../repositories/settingsRepository.js';
import { executePlanned } from './plannedExecutionService.js';
import { addDaysYmd, todayAppDateString } from '../lib/timezone.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { logger } from '../config/logger.js';

const AMOUNT_TOLERANCE_PCT = 5;
const DATE_WINDOW_DAYS = 5;
const SUGGESTION_LOOKBACK_DAYS = 45;

// Normalize a DATE-ish value (pg Date at local midnight, or a 'YYYY-MM-DD' /
// ISO string) to a plain 'YYYY-MM-DD' string. pg returns DATE columns as a JS
// Date built from local Y/M/D, so local getters recover the calendar date.
function toYmd(value) {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function ymdDiffDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

/**
 * Pure predicate: does `tx` fall within tolerance of planned payment `planned`?
 * Both objects must carry `recipient_cluster_id`, `amount`, and a date
 * (`planned_date` / `transaction_date`).
 */
export function matchesTolerance(planned, tx) {
  if (planned?.recipient_cluster_id == null || tx?.recipient_cluster_id == null) return false;
  if (Number(planned.recipient_cluster_id) !== Number(tx.recipient_cluster_id)) return false;

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

  const pDate = toYmd(planned.planned_date);
  const tDate = toYmd(tx.transaction_date);
  if (!pDate || !tDate) return false;
  if (Math.abs(ymdDiffDays(pDate, tDate)) > DATE_WINDOW_DAYS) return false;

  return true;
}

// NOTE: a findAutoLinkTarget(tx, activePlanned) helper used to live here, but
// it only checked single-direction uniqueness while the real rule inside
// autoLinkTransactions is mutual uniqueness (both match directions). It had no
// production callers and its passing tests created false confidence that the
// weaker rule was the live one, so it was removed.

async function isAutoClearEnabled() {
  try {
    const settings = await settingsRepository.get('app_settings');
    return settings?.autoClearPlannedOnMatch !== false; // default ON
  } catch {
    return true;
  }
}

/**
 * Auto-link a batch of freshly-ingested transactions to matching planned
 * payments. Each input row needs at least `{ id, recipient_id, amount }` plus a
 * date (`transaction_date` or `date`). Never throws — per-pair failures are
 * logged and skipped so an import/create never fails because of auto-link.
 *
 * @returns {Promise<{ autoLinkedCount: number, links: Array<{plannedTransactionId:number, transactionId:number}> }>}
 */
export async function autoLinkTransactions(txRows) {
  const result = { autoLinkedCount: 0, links: [] };
  if (!Array.isArray(txRows) || txRows.length === 0) return result;
  if (!(await isAutoClearEnabled())) return result;

  const activePlanned = await plannedTransactionRepository.listActiveUnexecuted();
  if (activePlanned.length === 0) return result;

  const clusterMap = await recipientRepository.getClusterRootMap(
    txRows.map((t) => t?.recipient_id),
  );

  const txs = txRows
    .filter((t) => t && t.id != null && t.recipient_id != null)
    .map((t) => ({
      id: t.id,
      amount: t.amount,
      transaction_date: t.transaction_date ?? t.date,
      recipient_cluster_id: clusterMap.get(t.recipient_id) ?? t.recipient_id,
    }));

  // Build both match directions so a pair only auto-links when it is mutually
  // unambiguous (see the safety rule at the top of this file).
  const candidatesByTx = new Map();
  const txIdsByPlanned = new Map();
  for (const tx of txs) {
    const matches = activePlanned.filter((planned) => matchesTolerance(planned, tx));
    candidatesByTx.set(tx.id, matches);
    for (const planned of matches) {
      if (!txIdsByPlanned.has(planned.id)) txIdsByPlanned.set(planned.id, []);
      txIdsByPlanned.get(planned.id).push(tx.id);
    }
  }

  for (const tx of txs) {
    const matches = candidatesByTx.get(tx.id);
    if (!matches || matches.length !== 1) continue;
    const planned = matches[0];
    if ((txIdsByPlanned.get(planned.id) || []).length !== 1) continue;

    try {
      const { duplicate } = await executePlanned({
        id: planned.id,
        executedTransactionId: tx.id,
        executionDate: toYmd(tx.transaction_date),
      });
      if (!duplicate) {
        result.autoLinkedCount += 1;
        result.links.push({ plannedTransactionId: planned.id, transactionId: tx.id });
      }
    } catch (err) {
      logger.warn('[auto-link] execute failed', {
        plannedId: planned.id,
        txId: tx.id,
        error: err?.message,
      });
    }
  }

  return result;
}

/**
 * Read-time view of planned payments that have one or more matching unlinked
 * transactions but were not auto-cleared (ambiguous matches, or auto-clear off).
 * The user confirms which transaction clears each planned payment.
 *
 * @returns {Promise<Array<{ planned: object, candidates: object[] }>>}
 */
export async function getMatchSuggestions() {
  const activePlanned = await plannedTransactionRepository.listActiveUnexecuted();
  if (activePlanned.length === 0) return [];

  const sinceDate = addDaysYmd(todayAppDateString(), -SUGGESTION_LOOKBACK_DAYS);
  const recentTx = await transactionRepository.listRecentUnlinked({ sinceDate });
  if (recentTx.length === 0) return [];

  const suggestions = [];
  for (const planned of activePlanned) {
    const candidates = recentTx.filter((tx) => matchesTolerance(planned, tx));
    if (candidates.length === 0) continue;
    suggestions.push({
      planned: {
        id: planned.id,
        recipient_id: planned.recipient_id,
        recipient_name: planned.recipient_name ?? null,
        amount: toNumber(toDecimal(planned.amount)),
        planned_date: toYmd(planned.planned_date),
        currency: planned.currency ?? null,
        is_recurring: planned.is_recurring,
      },
      candidates: candidates.map((tx) => ({
        id: tx.id,
        recipient_name: tx.recipient_name ?? null,
        amount: toNumber(toDecimal(tx.amount)),
        transaction_date: toYmd(tx.transaction_date),
        currency: tx.currency ?? null,
        memo: tx.memo ?? null,
      })),
    });
  }
  return suggestions;
}

export default { matchesTolerance, autoLinkTransactions, getMatchSuggestions };
