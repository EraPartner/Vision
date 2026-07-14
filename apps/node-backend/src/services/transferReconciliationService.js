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
import { resolveTransferMatches } from './calculations/transfers.js';
import { scheduleAggregationRefresh } from './aggregationRefresh.js';
import { logger } from '../config/logger.js';
import { ValidationError, NotFoundError } from '../middleware/errorHandler.js';

const DEFAULT_WINDOW_DAYS = 3;

// Mark one leg of a transfer pair (SIMP-50). The `auto` variant guards against
// clobbering a concurrent manual mark or already-paired row; the `manual`
// variant is unconditional (the caller has already released prior peers).
const MARK_AUTO_LEG_SQL = `UPDATE transactions SET is_transfer = true, transfer_peer_id = $2, transfer_source = 'auto'
            WHERE id = $1 AND is_transfer = false AND transfer_source IS NULL`;
const MARK_MANUAL_LEG_SQL = `UPDATE transactions SET is_transfer = true, transfer_peer_id = $2, transfer_source = 'manual' WHERE id = $1`;
// Undo a leg WE just auto-marked (guarded on the peer we set + source='auto') so
// a half-applied pair is never committed when the sibling leg's guarded UPDATE misses.
const REVERT_AUTO_LEG_SQL = `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL
            WHERE id = $1 AND transfer_peer_id = $2 AND transfer_source = 'auto'`;
const markAutoLeg = (client, id, peerId) => client.query(MARK_AUTO_LEG_SQL, [id, peerId]);
const markManualLeg = (client, id, peerId) => client.query(MARK_MANUAL_LEG_SQL, [id, peerId]);
const revertAutoLeg = (client, id, peerId) => client.query(REVERT_AUTO_LEG_SQL, [id, peerId]);

// Candidate (outflow, inflow) pairs among open rows: equal-and-opposite amount,
// same currency, two different own accounts, within ±windowDays. Fixing the
// outflow side (amount < 0) yields each pair exactly once. Uses the
// (amount, date) index added in migration 0044. Pairs the user explicitly
// rejected (transfer_dismissals, migration 0070) are excluded — the PAIR, not
// the rows: each leg stays matchable with every other candidate.
async function loadCandidatePairs(windowDays) {
  const { rows } = await query(
    `SELECT a.id AS "outId", b.id AS "inId"
       FROM transactions a
       JOIN transactions b
         ON b.amount = -a.amount
        AND COALESCE(b.currency, 'EUR') = COALESCE(a.currency, 'EUR')
        AND b.account_id IS DISTINCT FROM a.account_id
        AND a.account_id IS NOT NULL AND b.account_id IS NOT NULL
        AND b.date BETWEEN a.date - $1::int AND a.date + $1::int
      WHERE a.is_active AND b.is_active
        AND a.is_transfer = false AND b.is_transfer = false
        AND a.transfer_source IS NULL AND b.transfer_source IS NULL
        AND a.amount < 0
        AND NOT EXISTS (
          SELECT 1 FROM transfer_dismissals d
           WHERE d.txn_a_id = LEAST(a.id, b.id)
             AND d.txn_b_id = GREATEST(a.id, b.id)
        )`,
    [windowDays],
  );
  return rows;
}

// Transfers whose peer was deleted (the FK set transfer_peer_id NULL) are no
// longer valid pairs — a peerless transfer cannot be a transfer — so release
// them back into income/spending. This now covers MANUAL marks too: the sticky
// guarantee is about surviving auto re-matching, not about surviving the
// deletion of the very counterpart that made it a transfer. Without this an
// orphaned manual leg stayed is_transfer=true forever, silently excluded from
// every cash-flow aggregate.
async function releaseOrphans() {
  // Only release rows the reconciler itself owns ('auto'/'manual'). System rows
  // — opening anchors, reconcile adjustments, trade cash legs — are also created
  // with is_transfer=true, transfer_peer_id NULL, but they are NOT reconciler
  // pairs: releasing them would flip an adjustment back into income/spending
  // aggregates (and make it an auto-pair candidate) and strip an opening anchor's
  // 'opening' tag so setOpeningBalance's upsert can never find it again.
  await query(
    `UPDATE transactions
        SET is_transfer = false, transfer_source = NULL
      WHERE is_transfer = true AND transfer_peer_id IS NULL
        AND transfer_source IN ('auto', 'manual')`,
  );
}

// Auto-pairs whose legs no longer satisfy the match rule (e.g. an amount or date
// was edited) are released so they can re-match. The predicate is symmetric, so
// both legs of a now-invalid pair qualify and are released together — this makes
// a plain reconcile fully self-correcting after any edit, no per-id plumbing.
async function releaseInvalidAutoPairs(windowDays) {
  await query(
    `UPDATE transactions t
        SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL
      WHERE t.transfer_source = 'auto' AND t.transfer_peer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM transactions p
           WHERE p.id = t.transfer_peer_id
             -- Reciprocity: the peer must still point back at t. Without this,
             -- when markTransfer re-points one leg elsewhere the stranded auto
             -- leg stayed is_transfer=true forever (a phantom one-way transfer,
             -- excluded from cash-flow aggregates).
             AND p.transfer_peer_id = t.id
             AND p.amount = -t.amount
             AND COALESCE(p.currency, 'EUR') = COALESCE(t.currency, 'EUR')
             AND p.account_id IS DISTINCT FROM t.account_id
             AND p.account_id IS NOT NULL AND t.account_id IS NOT NULL
             AND p.date BETWEEN t.date - $1::int AND t.date + $1::int
             AND p.is_active AND t.is_active
        )`,
    [windowDays],
  );
}

/**
 * Reconcile the corpus: release invalidated/orphaned pairs, then auto-pair
 * unambiguous matches. Safe to call after any mutation — fully idempotent.
 * @param {{windowDays?:number}} [opts]
 * @returns {Promise<{pairsCreated:number}>}
 */
export async function reconcileTransfers({ windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  await releaseInvalidAutoPairs(windowDays);
  await releaseOrphans();
  const { autoPairs } = resolveTransferMatches(await loadCandidatePairs(windowDays));
  let created = 0;
  if (autoPairs.length) {
    await withTransaction(async (client) => {
      for (const { outId, inId } of autoPairs) {
        // Re-check open state inside the txn so we never clobber a concurrent
        // manual mark or an already-paired row.
        const r1 = await markAutoLeg(client, outId, inId);
        const r2 = await markAutoLeg(client, inId, outId);
        if (r1.rowCount && r2.rowCount) {
          created += 1;
        } else {
          // Exactly one leg was marked (the other lost its guarded UPDATE to a
          // concurrent mark). Revert the leg we did mark so we never commit a
          // one-way transfer pointing at a peer that points elsewhere — the
          // pair re-evaluates cleanly on the next reconcile.
          if (r1.rowCount) await revertAutoLeg(client, outId, inId);
          if (r2.rowCount) await revertAutoLeg(client, inId, outId);
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
  const { suggestions } = resolveTransferMatches(await loadCandidatePairs(windowDays));
  if (!suggestions.length) return [];
  const ids = [...new Set(suggestions.flatMap((s) => [s.outId, ...s.candidateInIds]))];
  const { rows } = await query(
    `SELECT id, date, amount, currency, bank_account, memo, recipient_id
       FROM transactions WHERE id = ANY($1)`,
    [ids],
  );
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
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, amount, account_id, is_active FROM transactions WHERE id = ANY($1) FOR UPDATE`,
      [[aId, bId]],
    );
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
    await client.query(
      `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL
        WHERE transfer_peer_id = ANY($1) AND id <> ALL($1)`,
      [[aId, bId]],
    );
    await markManualLeg(client, aId, bId);
    await markManualLeg(client, bId, aId);
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
  await withTransaction(async (client) => {
    // Lock the target row before reading its peer (mirrors markTransfer's
    // FOR UPDATE). Without the lock, a concurrent markTransfer could re-point the
    // peer at a third row Q between this SELECT and the reset below, stranding Q
    // as a phantom one-way manual transfer that no cleanup path releases.
    const { rows } = await client.query(
      'SELECT transfer_peer_id FROM transactions WHERE id = $1 FOR UPDATE',
      [id],
    );
    const peer = rows[0]?.transfer_peer_id ?? null;

    // Lock the peer too and re-read its pointer under the lock: only reset it if
    // it still points back at `id`. If markTransfer already re-paired it to Q,
    // leave that legitimate pairing (and Q) untouched — we just reset our leg.
    let peerPointsBack = false;
    if (peer) {
      const peerRes = await client.query(
        'SELECT transfer_peer_id FROM transactions WHERE id = $1 FOR UPDATE',
        [peer],
      );
      peerPointsBack = peerRes.rows[0]?.transfer_peer_id === id;
    }

    if (peer && peerPointsBack) {
      await client.query(
        `INSERT INTO transfer_dismissals (txn_a_id, txn_b_id)
         VALUES (LEAST($1::int, $2::int), GREATEST($1::int, $2::int))
         ON CONFLICT DO NOTHING`,
        [id, peer],
      );
    }
    await client.query(
      `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL WHERE id = $1`,
      [id],
    );
    if (peer && peerPointsBack) {
      await client.query(
        `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL WHERE id = $1`,
        [peer],
      );
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
