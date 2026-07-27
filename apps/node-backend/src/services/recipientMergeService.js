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
import { recipientRepository } from '../repositories/recipientRepository.js';
import { transactionRepository } from '../repositories/transactionRepository.js';
import { splitRepository } from '../repositories/splitRepository.js';
import { plannedTransactionRepository } from '../repositories/plannedTransactionRepository.js';
import { recipientBankAccountRepository } from '../repositories/recipientBankAccountRepository.js';

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

  // Composed from repository methods: the ambient transaction context routes
  // each repo call onto this transaction's client, so the whole repoint sequence
  // shares the primary's FOR UPDATE lock and rolls back as one.
  return withTransaction(async () => {
    // Sanity: the primary must exist. We lock it FOR UPDATE so concurrent
    // merges into the same primary serialize cleanly.
    const primary = await recipientRepository.lockByIdForMerge(primaryId);
    if (!primary) {
      throw new Error(`mergeRecipients: primary recipient ${primaryId} not found`);
    }

    // 1. transactions
    const txCount = await transactionRepository.repointRecipient(primaryId, ids);

    // 2. transaction_splits
    const splitCount = await splitRepository.repointRecipient(primaryId, ids);

    // 3. planned_transactions — guarded: older schemas may not have the column.
    let plannedRowCount = 0;
    if (await plannedTransactionRepository.hasRecipientIdColumn()) {
      plannedRowCount = await plannedTransactionRepository.repointRecipient(primaryId, ids);
    }

    // 4. recipient_bank_accounts — guard against collisions on
    // uq_rba_account_number (added in migration 0029). If the primary
    // already owns an account with the same number we keep its row and
    // delete the alias's row instead of reassigning.
    await recipientBankAccountRepository.deleteMergeDuplicates(primaryId, ids);
    const bankCount = await recipientBankAccountRepository.repointRecipient(primaryId, ids);

    // 5. flag aliases as pointing at the primary. This preserves the
    // historical relationship for the Recipients UI + /:id/aliases.
    const mergedAliasIds = await recipientRepository.flagAliasesOf(primaryId, ids);

    // 5b. Re-point any GRANDCHILDREN — recipients whose primary_recipient_id was
    // one of the now-merged aliases — onto the new primary. Without this, merging
    // C→B then B→A leaves C pointing at B (a depth-2 chain) that the one-level
    // read layer (getAliases, recipientGroupId filter) cannot resolve, so C
    // vanishes from A's group and future imports of C divert away from A.
    await recipientRepository.repointGrandchildAliases(primaryId, ids);

    return {
      mergedAliasIds,
      reassigned: {
        transactions: txCount,
        splits: splitCount,
        planned: plannedRowCount,
        bankAccounts: bankCount,
      },
    };
  });
}

export default { mergeRecipients };
