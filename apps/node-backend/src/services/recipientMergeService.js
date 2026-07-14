/**
 * Recipient merge — Phase 6 of the non-portfolio refactor.
 *
 * Previously the merge endpoint only stamped `primary_recipient_id` on alias
 * rows, leaving every downstream FK (transactions, splits, planned, bank
 * accounts) still pointing at the alias. That made reporting wrong and
 * forced callers to walk the primary_recipient_id chain on every read.
 *
 * This service performs an *atomic* merge: a single DB transaction
 * reassigns all FK references from each alias onto the primary, then
 * stamps `primary_recipient_id` on the alias rows so the historical alias
 * relationship is preserved. If any step fails, the entire merge rolls
 * back.
 *
 * Tables touched (in order, to respect FK dependencies):
 *   1. transactions.recipient_id          → primary
 *   2. transaction_splits.recipient_id    → primary
 *   3. planned_transactions.recipient_id  → primary (guarded: column may not exist on very old schemas)
 *   4. recipient_bank_accounts.recipient_id → primary (unless that would create a dupe account_number)
 *   5. recipients.primary_recipient_id    → primary (aliases now officially point at it)
 */
import { withTransaction } from '../database/connection.js';

/**
 * Merge a set of alias recipients into a primary recipient.
 *
 * @param {number} primaryId
 * @param {number[]} aliasIds  — ids to merge *into* primary. primaryId is filtered out if present.
 * @returns {Promise<{ mergedAliasIds: number[], reassigned: {
 *   transactions: number,
 *   splits: number,
 *   planned: number,
 *   bankAccounts: number,
 * }}>}
 */
export async function mergeRecipients(primaryId, aliasIds) {
  if (!Number.isInteger(primaryId)) {
    throw new Error('mergeRecipients: primaryId must be an integer');
  }
  const ids = (aliasIds || [])
    .filter((id) => Number.isInteger(id) && id !== primaryId);
  if (!ids.length) {
    return { mergedAliasIds: [], reassigned: { transactions: 0, splits: 0, planned: 0, bankAccounts: 0 } };
  }

  return withTransaction(async (client) => {
    // Sanity: the primary must exist. We lock it FOR UPDATE so concurrent
    // merges into the same primary serialize cleanly.
    const primaryCheck = await client.query(
      `SELECT id FROM recipients WHERE id = $1 FOR UPDATE`,
      [primaryId],
    );
    if (!primaryCheck.rows.length) {
      throw new Error(`mergeRecipients: primary recipient ${primaryId} not found`);
    }

    // 1. transactions
    const txRes = await client.query(
      `UPDATE transactions
          SET recipient_id = $1
        WHERE recipient_id = ANY($2::int[])`,
      [primaryId, ids],
    );

    // 2. transaction_splits
    const splitRes = await client.query(
      `UPDATE transaction_splits
          SET recipient_id = $1
        WHERE recipient_id = ANY($2::int[])`,
      [primaryId, ids],
    );

    // 3. planned_transactions — guarded: older schemas may not have the column.
    const colCheck = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'planned_transactions' AND column_name = 'recipient_id'
       LIMIT 1`,
    );
    let plannedRowCount = 0;
    if (colCheck.rows.length > 0) {
      const plannedRes = await client.query(
        `UPDATE planned_transactions
            SET recipient_id = $1
          WHERE recipient_id = ANY($2::int[])`,
        [primaryId, ids],
      );
      plannedRowCount = plannedRes.rowCount ?? 0;
    }

    // 4. recipient_bank_accounts — guard against collisions on
    // uq_rba_account_number (added in migration 0029). If the primary
    // already owns an account with the same number we keep its row and
    // delete the alias's row instead of reassigning.
    await client.query(
      `DELETE FROM recipient_bank_accounts rba
        USING recipient_bank_accounts keep
        WHERE rba.recipient_id = ANY($2::int[])
          AND keep.recipient_id = $1
          AND keep.account_number = rba.account_number`,
      [primaryId, ids],
    );
    const bankRes = await client.query(
      `UPDATE recipient_bank_accounts
          SET recipient_id = $1
        WHERE recipient_id = ANY($2::int[])`,
      [primaryId, ids],
    );

    // 5. flag aliases as pointing at the primary. This preserves the
    // historical relationship for the Recipients UI + /:id/aliases.
    const aliasRes = await client.query(
      `UPDATE recipients
          SET primary_recipient_id = $1,
              updated_at = NOW()
        WHERE id = ANY($2::int[])
          AND id <> $1
        RETURNING id`,
      [primaryId, ids],
    );

    // 5b. Re-point any GRANDCHILDREN — recipients whose primary_recipient_id was
    // one of the now-merged aliases — onto the new primary. Without this, merging
    // C→B then B→A leaves C pointing at B (a depth-2 chain) that the one-level
    // read layer (getAliases, recipientGroupId filter) cannot resolve, so C
    // vanishes from A's group and future imports of C divert away from A.
    await client.query(
      `UPDATE recipients
          SET primary_recipient_id = $1,
              updated_at = NOW()
        WHERE primary_recipient_id = ANY($2::int[])
          AND id <> $1`,
      [primaryId, ids],
    );

    return {
      mergedAliasIds: aliasRes.rows.map((r) => r.id),
      reassigned: {
        transactions: txRes.rowCount ?? 0,
        splits: splitRes.rowCount ?? 0,
        planned: plannedRowCount,
        bankAccounts: bankRes.rowCount ?? 0,
      },
    };
  });
}

export default { mergeRecipients };
