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

import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { db } from "../database/db.ts";
import { transactionRepository } from "../repositories/transactionRepository.ts";
import { scheduleAggregationRefresh } from "./aggregationRefresh.ts";
import { invalidateStatisticsCaches } from "./info/cache.ts";
import { logger } from "../config/logger.ts";
import { ValidationError, NotFoundError } from "../middleware/errorHandler.ts";
import type { TransactionId } from "@vision/types/brands";

const DEFAULT_WINDOW_DAYS = 3;

/**
 * Reconcile the corpus: release invalidated/orphaned pairs, then auto-pair
 * unambiguous matches. Safe to call after any mutation — fully idempotent.
 */
export async function reconcileTransfers({
  windowDays = DEFAULT_WINDOW_DAYS,
}: { windowDays?: number } = {}): Promise<{ pairsCreated: number }> {
  await transactionRepository.releaseInvalidAutoTransferPairs(windowDays);
  await transactionRepository.releaseOrphanedTransfers();
  const autoPairs =
    await transactionRepository.listUniqueTransferPairs(windowDays);
  let created = 0;
  if (autoPairs.length > 0) {
    await withTransaction(async () => {
      // Lock all proposed legs in the same order as manual edits. An edit that
      // won the lock is visible to the fresh uniqueness statement below.
      await transactionRepository.lockTransferLegs(
        [
          ...new Set(autoPairs.flatMap(({ outId, inId }) => [outId, inId])),
        ].sort((a, b) => a - b),
      );
      const currentPairs = new Set(
        (await transactionRepository.listUniqueTransferPairs(windowDays)).map(
          ({ outId, inId }) => `${outId}:${inId}`,
        ),
      );
      for (const { outId, inId } of autoPairs) {
        if (!currentPairs.has(`${outId}:${inId}`)) continue;
        // Re-check open state inside the txn so we never clobber a concurrent
        // manual mark or an already-paired row.
        const r1 = await transactionRepository.markAutoTransferLeg(outId, inId);
        const r2 = await transactionRepository.markAutoTransferLeg(inId, outId);
        if (r1 > 0 && r2 > 0) {
          created += 1;
        } else {
          // Exactly one leg was marked (the other lost its guarded UPDATE to a
          // concurrent mark). Revert the leg we did mark so we never commit a
          // one-way transfer pointing at a peer that points elsewhere — the
          // pair re-evaluates cleanly on the next reconcile.
          if (r1 > 0)
            await transactionRepository.revertAutoTransferLeg(outId, inId);
          if (r2 > 0)
            await transactionRepository.revertAutoTransferLeg(inId, outId);
        }
      }
    });
  }
  if (created > 0) logger.info(`[transfers] auto-paired ${created} transfer(s)`);
  return { pairsCreated: created };
}

/**
 * Ambiguous matches for the user to resolve — computed on demand, not stored.
 */
export async function getTransferSuggestions({
  windowDays = DEFAULT_WINDOW_DAYS,
  cursor,
  limit = 200,
}: {
  windowDays?: number;
  cursor?: string | undefined;
  limit?: number | undefined;
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ValidationError(
      "Suggestion limit must be an integer between 1 and 200",
    );
  }
  const parts = cursor?.split(":").map(Number);
  if (
    cursor !== undefined &&
    (!/^\d+:\d+$/.test(cursor) ||
      parts?.length !== 2 ||
      parts.some(
        (id) => !Number.isSafeInteger(id) || id < 1 || id > 2147483647,
      ))
  ) {
    throw new ValidationError("Invalid transfer suggestion cursor");
  }
  const after: [number, number] = parts ? [parts[0]!, parts[1]!] : [0, 0];
  const pairs = await transactionRepository.listTransferSuggestionPairs(
    windowDays,
    after,
    limit + 1,
  );
  const hasMore = pairs.length > limit;
  const page = pairs.slice(0, limit);
  const ids = [...new Set(page.flatMap((pair) => [pair.outId, pair.inId]))];
  const rows = ids.length > 0
    ? await transactionRepository.listTransferSuggestionRows(ids)
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const grouped = new Map<TransactionId, TransactionId[]>();
  for (const pair of page) {
    const candidates = grouped.get(pair.outId) ?? [];
    candidates.push(pair.inId);
    grouped.set(pair.outId, candidates);
  }
  const last = page.at(-1);
  return {
    items: [...grouped].map(([outId, inIds]) => ({
      outflow: byId.get(outId),
      candidates: inIds.map((id) => byId.get(id)).filter(Boolean),
    })),
    hasMore,
    nextCursor: hasMore && last ? `${last.outId}:${last.inId}` : null,
  };
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
export async function markTransfer(
  aId: TransactionId,
  bId: TransactionId,
): Promise<{ ok: boolean }> {
  await withTransaction(async () => {
    const rows = await transactionRepository.lockTransferGraphForMark([aId, bId]);
    const a = rows.find((r) => r.id === aId);
    const b = rows.find((r) => r.id === bId);
    if (!a || !b) {
      throw new NotFoundError(
        "Both transactions must exist to mark a transfer",
      );
    }
    if (
      [a, b].some(
        (leg) =>
          leg.transfer_source != null &&
          leg.transfer_source !== "" &&
          !["auto", "manual"].includes(leg.transfer_source),
      )
    ) {
      throw new ValidationError(
        "System-owned transactions must be corrected through their original workflow",
      );
    }
    if (!a.is_active || !b.is_active) {
      throw new ValidationError(
        "Both transactions must be active to mark a transfer",
      );
    }
    if (
      a.account_id === null ||
      b.account_id === null ||
      a.account_id === b.account_id
    ) {
      throw new ValidationError("A transfer must link two different accounts");
    }
    const aAmt = Number(a.amount);
    const bAmt = Number(b.amount);
    if (!((aAmt < 0 && bAmt > 0) || (aAmt > 0 && bAmt < 0))) {
      throw new ValidationError(
        "A transfer needs one outflow and one inflow (opposite signs)",
      );
    }
    // Release any existing peer of A or B before re-pairing them together, so a
    // prior counterpart (e.g. an auto pair A↔C) isn't stranded as a phantom
    // one-way transfer. The stranded peer goes back to open (NULL), not
    // dismissed — releasing it is a side effect, not a user dismissal.
    await transactionRepository.releaseTransferPeersOf([aId, bId], rows.map((row) => row.id));
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
export async function unmarkTransfer(
  id: TransactionId,
): Promise<{ ok: boolean }> {
  await withTransaction(async () => {
    const { peer, peerPointsBack } = await transactionRepository.lockTransferPairForUnmark(id);

    if (peer !== undefined && peerPointsBack) {
      await transactionRepository.insertTransferDismissal(id, peer);
    }
    await transactionRepository.clearTransferMark(id);
    if (peer !== undefined && peerPointsBack) {
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

let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
let reconcileDeadline: number | null = null; // epoch ms the current burst must flush by

export function scheduleReconcile() {
  // Transaction CRUD funnels here (the reconcile itself is debounced). Drop the
  // statistics-pivot cache immediately so an edited/added/deleted transaction is
  // reflected on the next statistics request rather than after the reconcile tail.
  invalidateStatisticsCaches();
  const now = Date.now();
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileDeadline ??= now + RECONCILE_MAX_WAIT_MS;
  const delay = Math.max(
    0,
    Math.min(RECONCILE_DEBOUNCE_MS, reconcileDeadline - now),
  );
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined;
    reconcileDeadline = null;
    reconcileTransfers()
      .catch((err) =>
        logger.warn("[transfers] debounced reconcile failed", {
          err: err?.message,
        }),
      )
      .finally(() => scheduleAggregationRefresh());
  }, delay);
}

/**
 * One-time backfill over existing transactions, run on upgrade (ADR-083). Gated
 * by a settings flag so it runs once; thereafter detection is incremental via
 * the import-commit and mutation hooks.
 */
export async function backfillTransfersOnce(): Promise<{
  skipped: boolean;
  pairsCreated?: number;
}> {
  const done = await db
    .selectFrom("user_settings")
    .select("key")
    .where("key", "=", "transfers_backfilled")
    .limit(1)
    .executeTakeFirst();
  if (done) return { skipped: true };
  const result = await reconcileTransfers();
  await db
    .insertInto("user_settings")
    .values({ key: "transfers_backfilled", value: sql`'true'::jsonb` })
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
  logger.info(
    `[transfers] one-time backfill complete: ${result.pairsCreated} pair(s)`,
  );
  return { skipped: false, ...result };
}
