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
import { scheduleRefresh } from './materializedViewService.js';
import { logger } from '../config/logger.js';

const DEFAULT_WINDOW_DAYS = 3;

// Candidate (outflow, inflow) pairs among open rows: equal-and-opposite amount,
// same currency, two different own accounts, within ±windowDays. Fixing the
// outflow side (amount < 0) yields each pair exactly once. Uses the
// (amount, date) index added in migration 0044.
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
        AND a.amount < 0`,
    [windowDays],
  );
  return rows;
}

// Auto-transfers whose peer was deleted (the FK set transfer_peer_id NULL) are
// no longer valid pairs — release them so they re-enter income/spending and can
// be re-matched. Manual marks are left untouched (the user's explicit choice).
async function releaseOrphans() {
  await query(
    `UPDATE transactions
        SET is_transfer = false, transfer_source = NULL
      WHERE is_transfer = true AND transfer_source = 'auto' AND transfer_peer_id IS NULL`,
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
        const r1 = await client.query(
          `UPDATE transactions SET is_transfer = true, transfer_peer_id = $2, transfer_source = 'auto'
            WHERE id = $1 AND is_transfer = false AND transfer_source IS NULL`,
          [outId, inId],
        );
        const r2 = await client.query(
          `UPDATE transactions SET is_transfer = true, transfer_peer_id = $2, transfer_source = 'auto'
            WHERE id = $1 AND is_transfer = false AND transfer_source IS NULL`,
          [inId, outId],
        );
        if (r1.rowCount && r2.rowCount) created += 1;
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
 */
export async function markTransfer(aId, bId) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE transactions SET is_transfer = true, transfer_peer_id = $2, transfer_source = 'manual' WHERE id = $1`,
      [aId, bId],
    );
    await client.query(
      `UPDATE transactions SET is_transfer = true, transfer_peer_id = $1, transfer_source = 'manual' WHERE id = $2`,
      [aId, bId],
    );
  });
  return { ok: true };
}

/**
 * Clear a transfer mark on a transaction and its peer (handles false positives
 * and single-leg un-marking).
 */
export async function unmarkTransfer(id) {
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT transfer_peer_id FROM transactions WHERE id = $1', [id]);
    const peer = rows[0]?.transfer_peer_id;
    await client.query(
      `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL WHERE id = $1`,
      [id],
    );
    if (peer) {
      await client.query(
        `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL WHERE id = $1`,
        [peer],
      );
    }
  });
  return { ok: true };
}

/**
 * Release auto-pairings touching the given transaction ids (and their peers) so
 * a subsequent reconcile can re-evaluate them — used when a leg is edited.
 * Manual marks are preserved.
 * @param {number[]} ids
 */
export async function releaseAutoPairsFor(ids) {
  if (!ids?.length) return;
  await query(
    `UPDATE transactions SET is_transfer = false, transfer_peer_id = NULL, transfer_source = NULL
      WHERE transfer_source = 'auto' AND (id = ANY($1) OR transfer_peer_id = ANY($1))`,
    [ids],
  );
}

let reconcileTimer;

/**
 * Debounced reconcile after single-row mutations (coalesces rapid edits), then
 * schedules a materialized-view refresh so the transfer exclusion is reflected.
 * Mirrors materializedViewService.scheduleRefresh's 1s debounce.
 */
export function scheduleReconcile() {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined;
    reconcileTransfers()
      .catch((err) => logger.warn('[transfers] debounced reconcile failed', { err: err?.message }))
      .finally(() => scheduleRefresh());
  }, 1000);
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
