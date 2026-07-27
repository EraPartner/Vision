/**
 * Internal-transfer reconciliation (ADR-083).
 *
 * Detection is NOT scoped to an import batch: it matches candidate rows against
 * the whole recent corpus, so the cross-bank case (the two legs arriving in
 * separate imports days apart) is handled — the late-arriving leg pairs with the
 * still-open earlier one. Runs after every import commit and on manual
 * transaction mutations.
 *
 * High-confidence (mutually unambiguous) pairs are auto-marked; ambiguous ones
 * are surfaced as suggestions (computed on demand, not persisted). Manual marks
 * are sticky and never overwritten by auto-detection.
 */

import { query, withTransaction } from '../database/connection.js';
import { transactionRepository } from '../repositories/transactionRepository.js';
import { resolveTransferMatches } from './calculations/transfers.js';
import { scheduleAggregationRefresh } from './aggregationRefresh.js';
import { invalidateStatisticsCaches } from './info/cache.js';
import { logger } from '../config/logger.js';
import { ValidationError, NotFoundError } from '../middleware/errorHandler.js';

const DEFAULT_WINDOW_DAYS = 3;

/**
 * Reconcile the corpus: release invalidated/orphaned pairs, then auto-pair
 * unambiguous matches. Safe to call after any mutation — fully idempotent.
 * @param {{windowDays?:number}} [opts]
 * @returns {Promise<{pairsCreated:number}>}
 */
export async function reconcileTransfers({ windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  await transactionRepository.releaseInvalidAutoTransferPairs(windowDays);
  await transactionRepository.releaseOrphanedTransfers();
  const { autoPairs } = resolveTransferMatches(
    await transactionRepository.listTransferCandidatePairs(windowDays),
  );
  let created = 0;
  if (autoPairs.length) {
    await withTransaction(async () => {
      for (const { outId, inId } of autoPairs) {
        // Re-check open state inside the txn so we never clobber a concurrent
        // manual mark or an already-paired row.
        const r1 = await transactionRepository.markAutoTransferLeg(outId, inId);
        const r2 = await transactionRepository.markAutoTransferLeg(inId, outId);
        if (r1 && r2) {
          created += 1;
        } else {
          // Exactly one leg was marked (the other lost its guarded UPDATE to a
          // concurrent mark). Revert the leg we did mark so we never commit a
          // one-way transfer pointing at a peer that points elsewhere — the
          // pair re-evaluates cleanly on the next reconcile.
          if (r1) await transactionRepository.revertAutoTransferLeg(outId, inId);
          if (r2) await transactionRepository.revertAutoTransferLeg(inId, outId);
        }
      }
    });
  }
  if (created) logger.info(`[transfers] auto-paired ${created} transfer(s)`);
  return { pairsCreated: created };
}

/**
 * Ambiguous matches for the user to resolve — computed on demand, not stored.
 * @param {{windowDays?:number}} [opts]
 */
export async function getTransferSuggestions({ windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const { suggestions } = resolveTransferMatches(
    await transactionRepository.listTransferCandidatePairs(windowDays),
  );
  if (!suggestions.length) return [];
  const ids = [...new Set(suggestions.flatMap((s) => [s.outId, ...s.candidateInIds]))];
  const rows = await transactionRepository.listTransferSuggestionRows(ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return suggestions.map((s) => ({
    outflow: byId.get(s.outId),
    candidates: s.candidateInIds.map((id) => byId.get(id)).filter(Boolean),
  }));
}

/**
 * Manually confirm a transfer pair (sticky — survives auto-reconciliation).
 *
 * Validates the real invariants of a transfer before marking, so a stray manual
 * mark can't create a nonsensical pair (the route only checked aId !== bId).
 * Unlike auto-detection it does NOT require equal-and-opposite amounts or the
 * same currency — manual marks exist precisely to confirm cross-currency / FX
 * transfers that auto-detection rejects. What it does enforce:
 *   - both rows exist and are active
 *   - the two legs sit on different accounts (a transfer moves money between
 *     accounts; same-account is meaningless)
 *   - opposite signs (one outflow, one inflow)
 */
export async function markTransfer(aId, bId) {
  await withTransaction(async () => {
    const rows = await transactionRepository.lockTransferLegs([aId, bId]);
    const a = rows.find((r) => r.id === aId);
    const b = rows.find((r) => r.id === bId);
    if (!a || !b) {
      throw new NotFoundError('Both transactions must exist to mark a transfer');
    }
    if (!a.is_active || !b.is_active) {
      throw new ValidationError('Both transactions must be active to mark a transfer');
    }
    if (a.account_id === null || b.account_id === null || a.account_id === b.account_id) {
      throw new ValidationError('A transfer must link two different accounts');
    }
    const aAmt = Number(a.amount);
    const bAmt = Number(b.amount);
    if (!((aAmt < 0 && bAmt > 0) || (aAmt > 0 && bAmt < 0))) {
      throw new ValidationError('A transfer needs one outflow and one inflow (opposite signs)');
    }
    // Release any existing peer of A or B before re-pairing them together, so a
    // prior counterpart (e.g. an auto pair A↔C) isn't stranded as a phantom
    // one-way transfer. The stranded peer goes back to open (NULL), not
    // dismissed — releasing it is a side effect, not a user dismissal.
    await transactionRepository.releaseTransferPeersOf([aId, bId]);
    await transactionRepository.markManualTransferLeg(aId, bId);
    await transactionRepository.markManualTransferLeg(bId, aId);
  });
  return { ok: true };
}

/**
 * Clear a transfer mark on a transaction and its peer (handles false positives
 * and single-leg un-marking).
 *
 * The dismissal is STICKY and PER-PAIR (migration 0070): the rejected pairing
 * is recorded in transfer_dismissals, then both legs reset to open (NULL).
 * Resetting alone re-opened them as candidates, so the reconcile the caller
 * triggers ~1s later re-paired the exact pair the user just rejected; stamping
 * the ROWS 'dismissed' (the first fix) over-corrected — it removed each leg
 * from the candidate pool entirely, so a leg wrongly paired with B could never
 * auto-pair with its true counterpart C. Excluding just the pair gives both: A↔B
 * never comes back on its own, A↔C still can. A manual markTransfer of a
 * dismissed pair still works — dismissals only gate auto-detection.
 */
export async function unmarkTransfer(id) {
  await withTransaction(async () => {
    // Lock the target row before reading its peer (mirrors markTransfer's
    // FOR UPDATE). Without the lock, a concurrent markTransfer could re-point the
    // peer at a third row Q between this SELECT and the reset below, stranding Q
    // as a phantom one-way manual transfer that no cleanup path releases.
    const peer = await transactionRepository.lockTransferPeerPointer(id);

    // Lock the peer too and re-read its pointer under the lock: only reset it if
    // it still points back at `id`. If markTransfer already re-paired it to Q,
    // leave that legitimate pairing (and Q) untouched — we just reset our leg.
    let peerPointsBack = false;
    if (peer) {
      peerPointsBack = (await transactionRepository.lockTransferPeerPointer(peer)) === id;
    }

    if (peer && peerPointsBack) {
      await transactionRepository.insertTransferDismissal(id, peer);
    }
    await transactionRepository.clearTransferMark(id);
    if (peer && peerPointsBack) {
      await transactionRepository.clearTransferMark(peer);
    }
  });
  return { ok: true };
}

/**
 * Debounced reconcile after single-row mutations (coalesces rapid edits), then
 * schedules a materialized-view refresh so the transfer exclusion is reflected.
 *
 * Trailing 5s debounce + 10s max-wait, mirroring
 * materializedViewService.scheduleRefresh: the previous 1s window only
 * coalesced edits made <1s apart, so human editing cadence paid a
 * full-corpus reconcile (3 UPDATE scans + self-join) per save; trailing-only
 * debounce also let a machine-cadence mutation stream defer the reconcile
 * indefinitely.
 */
export const RECONCILE_DEBOUNCE_MS = 5000;
export const RECONCILE_MAX_WAIT_MS = 10000;

let reconcileTimer;
let reconcileDeadline = null; // epoch ms the current burst must flush by

export function scheduleReconcile() {
  // Transaction CRUD funnels here (the reconcile itself is debounced). Drop the
  // statistics-pivot cache immediately so an edited/added/deleted transaction is
  // reflected on the next statistics request rather than after the reconcile tail.
  invalidateStatisticsCaches();
  const now = Date.now();
  if (reconcileTimer) clearTimeout(reconcileTimer);
  if (reconcileDeadline === null) reconcileDeadline = now + RECONCILE_MAX_WAIT_MS;
  const delay = Math.max(0, Math.min(RECONCILE_DEBOUNCE_MS, reconcileDeadline - now));
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined;
    reconcileDeadline = null;
    reconcileTransfers()
      .catch((err) => logger.warn('[transfers] debounced reconcile failed', { err: err?.message }))
      .finally(() => scheduleAggregationRefresh());
  }, delay);
}

/**
 * One-time backfill over existing transactions, run on upgrade (ADR-083). Gated
 * by a settings flag so it runs once; thereafter detection is incremental via
 * the import-commit and mutation hooks.
 * @returns {Promise<{skipped:boolean, pairsCreated?:number}>}
 */
export async function backfillTransfersOnce() {
  const { rows } = await query("SELECT 1 FROM user_settings WHERE key = 'transfers_backfilled' LIMIT 1");
  if (rows.length) return { skipped: true };
  const result = await reconcileTransfers();
  await query(
    "INSERT INTO user_settings (key, value) VALUES ('transfers_backfilled', 'true'::jsonb) ON CONFLICT (key) DO NOTHING",
  );
  logger.info(`[transfers] one-time backfill complete: ${result.pairsCreated} pair(s)`);
  return { skipped: false, ...result };
}
