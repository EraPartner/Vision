/**
 * Atomic account merge (ADR-088). Merges one or more SOURCE accounts into a TARGET
 * (survivor): every reference to a source account_id is repointed to the target, then
 * the source rows are deleted — so the accounts become one everywhere.
 *
 * Mirrors the recipient merge (ADR-014) pattern: single transaction, FOR UPDATE locks,
 * repoint-then-delete. The account_id FKs are ON DELETE RESTRICT, so deletion only
 * succeeds once every reference has moved — which is exactly the integrity guarantee.
 *
 * transactions / planned_transactions also get bank_account = target.name so the
 * dual-write trigger (migration 0051) keeps account_id at the target and a later edit
 * can't re-resolve the old name back into a fresh account (un-merge).
 *
 * Overlapping-stamp guard (§1 F2): per-row `balance` stamps are per-source-bank
 * running balances. When two accounts that were BOTH being stamped over the same
 * period merge, the stamps interleave in one partition and the anchor+delta
 * computation (COMPUTED_BALANCE_LATERAL) anchors on whichever source's latest
 * stamp is most recent — silently dropping the other bank's balance — while the
 * survivor's stored `statement_balance` keeps anchoring drift against the shifted
 * figure. The merge detects this (overlapping stamped-date ranges across >1
 * original account) and clears the survivor's now-invalidated statement anchor.
 * Historical per-row stamps are never rewritten (they are historical facts);
 * clearing the statement anchor is the documented, reversible choice — the user
 * can re-reconcile with a fresh statement. Sequential merges (old account closed
 * before the new one opened — the phantom-dedup use case) don't overlap and are
 * untouched.
 */

import { query, withTransaction } from '../database/connection.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { roundMoney } from '../lib/money.js';

/**
 * Stamped-balance date range per original account across the merge set. Runs
 * BEFORE the repoint (rows still carry their original account_id).
 */
const STAMP_RANGES_SQL = `
  SELECT account_id,
         to_char(MIN(date), 'YYYY-MM-DD') AS min_date,
         to_char(MAX(date), 'YYYY-MM-DD') AS max_date
  FROM transactions
  WHERE account_id = ANY($1::int[]) AND is_active = true AND balance IS NOT NULL
  GROUP BY account_id`;

/**
 * Do the stamped-balance histories of >1 original account overlap in time?
 * True ⇒ the merged partition's anchor is ambiguous (see module header) and
 * the survivor's statement anchor must be cleared. Ranges are 'YYYY-MM-DD'
 * strings (lexicographic compare == date compare). Pairwise over ≤ a handful
 * of accounts — O(n²) is fine and keeps the predicate pure/testable.
 *
 * @param {{ account_id:number, min_date:string, max_date:string }[]} ranges
 * @returns {boolean}
 */
export function stampRangesOverlap(ranges) {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      // Two closed ranges [minA,maxA] and [minB,maxB] overlap iff each starts
      // on or before the other ends.
      if (ranges[i].min_date <= ranges[j].max_date && ranges[j].min_date <= ranges[i].max_date) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {number} targetId  the survivor
 * @param {number[]} sourceIds  accounts to merge into the target and delete
 * @returns {Promise<{ into:number, merged:number[], reassigned:{transactions:number,planned:number,portfolio:number,funding:number}, stampsInterleaved:boolean }>}
 */
export async function mergeAccounts(targetId, sourceIds) {
  if (!Number.isInteger(targetId)) throw new ValidationError('target account id must be an integer');
  const ids = [...new Set((sourceIds || []).filter((id) => Number.isInteger(id) && id !== targetId))];
  if (!ids.length) throw new ValidationError('Provide at least one distinct source account to merge');

  return withTransaction(async (client) => {
    // Lock the survivor + sources so concurrent merges serialize.
    const tgt = await client.query('SELECT id, name FROM accounts WHERE id = $1 FOR UPDATE', [targetId]);
    if (!tgt.rows[0]) throw new NotFoundError(`Account ${targetId} not found`);
    const targetName = tgt.rows[0].name;

    const srcRows = await client.query('SELECT id FROM accounts WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
    const found = new Set(srcRows.rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new NotFoundError(`Account(s) not found: ${missing.join(', ')}`);

    // Overlapping-stamp guard (§1 F2, module header): capture per-original-
    // account stamped ranges before the repoint erases the provenance.
    const stampRanges = await client.query(STAMP_RANGES_SQL, [[targetId, ...ids]]);
    const stampsInterleaved = stampRangesOverlap(stampRanges.rows);

    const txRes = await client.query(
      `UPDATE transactions SET account_id = $1, bank_account = $2 WHERE account_id = ANY($3::int[])`,
      [targetId, targetName, ids],
    );
    const plannedRes = await client.query(
      `UPDATE planned_transactions SET account_id = $1, bank_account = $2 WHERE account_id = ANY($3::int[])`,
      [targetId, targetName, ids],
    );

    // Portfolio lots: account_id lives on the inheritance base (an UPDATE cascades to the child
    // tables) or, in the flat schema, on the table itself. (portfolio_transactions is a view in the
    // inheritance schema and is not updatable.)
    const baseReg = await client.query(`SELECT to_regclass('public.portfolio_transactions_base') AS r`);
    const portRes = baseReg.rows[0]?.r
      ? await client.query(
          `UPDATE portfolio_transactions_base SET account_id = $1 WHERE account_id = ANY($2::int[])`,
          [targetId, ids],
        )
      : await client.query(
          `UPDATE portfolio_transactions SET account_id = $1 WHERE account_id = ANY($2::int[])`,
          [targetId, ids],
        );

    // Accounts that used a merged source as their funding/settlement account.
    const fundRes = await client.query(
      `UPDATE accounts SET funding_account_id = $1 WHERE funding_account_id = ANY($2::int[])`,
      [targetId, ids],
    );

    // Interleaved stamps invalidate the survivor's statement anchor: drift
    // would be computed against a figure reconciled for a pre-merge partition.
    // Clear it (reversible — the user re-reconciles with a fresh statement);
    // per-row balance stamps stay untouched (historical facts).
    if (stampsInterleaved) {
      await client.query(
        `UPDATE accounts SET statement_balance = NULL, statement_balance_date = NULL, updated_at = NOW()
         WHERE id = $1`,
        [targetId],
      );
    }

    await client.query('DELETE FROM accounts WHERE id = ANY($1::int[]) AND id <> $2', [ids, targetId]);

    return {
      into: targetId,
      merged: ids,
      reassigned: {
        transactions: txRes.rowCount ?? 0,
        planned: plannedRes.rowCount ?? 0,
        portfolio: portRes.rowCount ?? 0,
        funding: fundRes.rowCount ?? 0,
      },
      // Surfaced so the merge dialog (WP-B5) can warn that the statement
      // anchor was cleared and the merged history interleaves two banks.
      stampsInterleaved,
    };
  });
}

/**
 * Read-only preview of merging `sourceId` INTO `targetId` (the survivor) —
 * backs GET /api/accounts/:id/merge-preview?into=. No mutation, no locks:
 *   - reassigned.* — row counts that WOULD move (same categories mergeAccounts
 *     repoints).
 *   - projectedBalance — the post-merge computed balance: the anchor+delta
 *     definition (COMPUTED_BALANCE_LATERAL semantics) evaluated over the UNION
 *     of survivor + source active rows as if they were already one account.
 *     Reported in the survivor's native currency (projectedBalanceCurrency),
 *     mirroring how the hub reports computed_balance.
 *   - stampsInterleaved — same detection the merge guard uses (would the merge
 *     invalidate the survivor's statement anchor).
 *
 * @param {number} sourceId  the account that would be merged away
 * @param {number} targetId  the survivor (`?into=`)
 * @returns {Promise<{ into:number, source:number, reassigned:{transactions:number,planned:number,portfolio:number,funding:number}, projectedBalance:number, projectedBalanceCurrency:string, stampsInterleaved:boolean }>}
 */
export async function previewMerge(sourceId, targetId) {
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new ValidationError('source account id must be a positive integer');
  }
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new ValidationError('into must be a positive integer account id');
  }
  if (targetId === sourceId) {
    throw new ValidationError('An account cannot be merged into itself');
  }

  const accounts = await query(
    'SELECT id, currency FROM accounts WHERE id = ANY($1::int[])',
    [[sourceId, targetId]],
  );
  const byId = new Map(accounts.rows.map((r) => [r.id, r]));
  if (!byId.has(targetId)) throw new NotFoundError(`Account ${targetId} not found`);
  if (!byId.has(sourceId)) throw new NotFoundError(`Account ${sourceId} not found`);

  // Same table set mergeAccounts repoints, as COUNTs.
  const baseReg = await query(`SELECT to_regclass('public.portfolio_transactions_base') AS r`);
  const portfolioTable = baseReg.rows[0]?.r ? 'portfolio_transactions_base' : 'portfolio_transactions';

  const unionIds = [targetId, sourceId];
  const [txCount, plannedCount, portfolioCount, fundingCount, projected, stampRanges] = await Promise.all([
    query('SELECT COUNT(*) AS n FROM transactions WHERE account_id = $1', [sourceId]),
    query('SELECT COUNT(*) AS n FROM planned_transactions WHERE account_id = $1', [sourceId]),
    query(`SELECT COUNT(*) AS n FROM ${portfolioTable} WHERE account_id = $1`, [sourceId]),
    query('SELECT COUNT(*) AS n FROM accounts WHERE funding_account_id = $1', [sourceId]),
    // Anchor+delta over the union set: the most recent stamped row across BOTH
    // accounts anchors, every active row after it (from either account) is the
    // delta; with no stamp anywhere it degrades to Σ(amount) over the union —
    // exactly COMPUTED_BALANCE_LATERAL's semantics with
    // `account_id IN (target, source)` substituted for `account_id = a.id`.
    query(
      `WITH anchor AS (
         SELECT t.balance, t.date, t.id
         FROM transactions t
         WHERE t.account_id = ANY($1::int[]) AND t.is_active = true AND t.balance IS NOT NULL
         ORDER BY t.date DESC, t.id DESC
         LIMIT 1
       ),
       delta AS (
         SELECT COALESCE(SUM(t2.amount), 0) AS amount
         FROM transactions t2
         WHERE t2.account_id = ANY($1::int[]) AND t2.is_active = true
           AND (
             NOT EXISTS (SELECT 1 FROM anchor)
             OR (t2.date, t2.id) > (SELECT date, id FROM anchor)
           )
       )
       SELECT COALESCE((SELECT balance FROM anchor), 0)
            + (SELECT amount FROM delta) AS balance`,
      [unionIds],
    ),
    query(STAMP_RANGES_SQL, [unionIds]),
  ]);

  return {
    into: targetId,
    source: sourceId,
    reassigned: {
      transactions: parseInt(txCount.rows[0].n, 10),
      planned: parseInt(plannedCount.rows[0].n, 10),
      portfolio: parseInt(portfolioCount.rows[0].n, 10),
      funding: parseInt(fundingCount.rows[0].n, 10),
    },
    // pg NUMERIC arrives as a string; emit a rounded number (banker's, cents).
    projectedBalance: roundMoney(projected.rows[0]?.balance ?? 0),
    projectedBalanceCurrency: byId.get(targetId).currency,
    stampsInterleaved: stampRangesOverlap(stampRanges.rows),
  };
}

export default { mergeAccounts, previewMerge, stampRangesOverlap };
