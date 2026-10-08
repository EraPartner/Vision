/**
 * Transaction service — the route-facing seam over transactionRepository.
 * Routes delegate here instead of importing the repository directly
 * (eslint vision-local/no-repo-direct-from-route).
 *
 * Besides the pass-through repository methods, this module owns the write
 * orchestration moved out of routes/transactions.js (ADR-067): the manual
 * create flow (duplicate guard → insert → raw-mirror record → planned-payment
 * auto-link → reconcile), PATCH name resolution/update/reconcile, transfer
 * marking/reconcile, and hard delete with attachment-file cleanup.
 */

import transactionRepository from "../repositories/transactionRepository.ts";
import { accountRepository } from "../repositories/accountRepository.ts";
import {
  isManualDuplicate,
  lockManualTransactionIdentity,
  recordManualTransactionDedupClaim,
} from "./deduplication.ts";
import { withTransaction } from "../database/connection.ts";
import { autoLinkTransactions } from "./plannedMatchService.ts";
import { scheduleReconcile } from "./transferReconciliationService.ts";
import {
  getTransferSuggestions,
  markTransfer as markTransferRecord,
  unmarkTransfer as unmarkTransferRecord,
} from "./transferReconciliationService.ts";
import { resolveRecipientIdByName } from "./recipientService.ts";
import { resolveCategoryIdByName } from "./categoryService.ts";
import { attachmentRepository } from "./attachmentRecordService.ts";
import { removeAttachmentFilesBestEffort } from "./attachmentCleanup.ts";
import { ConflictError, ValidationError } from "../middleware/errorHandler.ts";
import { logger } from "../config/logger.ts";
import type { EnrichedTransactionRow } from "../types/rows.ts";

/**
 * The zod-validated manual-create POST body — loose passthrough (see
 * createManualTransaction). The route schema guarantees that one of
 * `transaction_date`/`date` is present.
 */
export type ManualTransactionInput = {
  transaction_date?: string;
  date?: string;
  account_id?: number | null;
  recipient_id?: number | null;
  amount: number | string;
  memo?: string | null;
  currency?: string | null;
  category_id?: number | null;
  comment?: string | null;
  tags?: string[] | null;
  allow_duplicate?: boolean;
};

export interface ManualAutoLinkResult {
  autoLinkedCount: number;
  links: Array<{ plannedTransactionId?: number; transactionId?: number }>;
}

/**
 * Create a manual transaction with its full side-effect chain.
 *
 * `data` is the zod-validated POST body (loose passthrough semantics — raw
 * values are forwarded to the repository exactly as accepted; only currency
 * arrives pre-coerced). Throws ConflictError when the manual-dedup hash
 * matches an existing live row.
 *
 * The auto-link step clears a matching planned payment when this transaction
 * unambiguously matches one; an auto-link failure must never fail the create,
 * so it is caught and logged.
 *
 * @param data zod-validated POST body — loose passthrough (see module doc above).
 */
async function createManualTransaction(data: ManualTransactionInput): Promise<{
  transaction: EnrichedTransactionRow;
  autoLink: ManualAutoLinkResult;
}> {
  // The route schema's superRefine rejects a body carrying neither date field.
  const txDate = (data.transaction_date || data.date) as string;
  const requestedIdentity = {
    date: txDate,
    amount: data.amount,
    recipientId: data.recipient_id,
    memo: data.memo || "",
    accountId: data.account_id,
  };

  const transaction = await withTransaction(async (client) => {
    const accountId = data.account_id ?? null;
    if (accountId != null) {
      if (!(await accountRepository.findActiveId(accountId, { client }))) {
        throw new ValidationError(
          "account_id must reference an active account",
        );
      }
    } else {
      throw new ValidationError("account_id must reference an active account");
    }
    const identity = {
      ...requestedIdentity,
      // Manual writes serialize on the canonical account identity.
      bankAccount: undefined,
      accountId,
    };
    await lockManualTransactionIdentity(identity);
    const dupCheck = await isManualDuplicate(identity);

    if (dupCheck.isDuplicate && data.allow_duplicate !== true) {
      throw new ConflictError("Duplicate transaction detected", {
        details: { existing_transaction_id: dupCheck.existingTransactionId },
      });
    }
    if (dupCheck.isDuplicate) {
      logger.info("Manual duplicate explicitly allowed", {
        existingTransactionId: dupCheck.existingTransactionId,
      });
    }

    const created = await transactionRepository.create({
      transaction_date: txDate,
      account_id: accountId,
      recipient_id: data.recipient_id,
      amount: data.amount,
      memo: data.memo,
      currency: data.currency,
      // `balance` intentionally not accepted: manual entries leave it NULL so the
      // account balance (ADR-094) anchors only on imported, bank-stamped rows.
      category_id: data.category_id,
      comment: data.comment,
      // Route schema guarantees array-or-absent; absent stays null as before.
      tags: data.tags ?? null,
    });
    // INSERT … RETURNING always yields the row; the guard only narrows the
    // repository's nullable return type.
    if (!created) throw new Error("Transaction insert did not return a row");

    await recordManualTransactionDedupClaim({
      ...identity,
      categoryId: data.category_id || null,
      comment: data.comment || null,
      transactionId: created.id,
    });
    return created;
  });

  // Auto-clear a matching planned payment if this transaction unambiguously
  // matches one. Never let an auto-link failure fail the create.
  let autoLink: ManualAutoLinkResult = { autoLinkedCount: 0, links: [] };
  try {
    autoLink = await autoLinkTransactions([transaction]);
  } catch (err) {
    logger.warn("Auto-link after manual create failed", {
      id: transaction.id,
      error: (err as { message?: string } | null | undefined)?.message,
    });
  }

  logger.info("Transaction created", { id: transaction.id });
  scheduleReconcile();
  return { transaction, autoLink };
}

/**
 * Hard-delete one transaction and clean up its attachment files.
 *
 * Stored paths are collected BEFORE the delete (the DB CASCADE removes the
 * attachments rows that know them), files are removed best-effort after.
 * Returns false when the transaction does not exist — in that case nothing is
 * removed and no reconcile is scheduled.
 *
 * @returns whether a row was deleted
 */
async function hardDeleteWithCleanup(id: number): Promise<boolean> {
  const attachmentPaths = await attachmentRepository.listPathsByTransactionIds([
    id,
  ]);
  const deleted = await transactionRepository.hardDelete(id);
  if (!deleted) return false;
  await removeAttachmentFilesBestEffort(attachmentPaths);
  scheduleReconcile();
  return true;
}

/**
 * Update one transaction with name resolution and the reconcile side effect.
 * The route passes its validated PATCH model here; this service strips the
 * convenience name fields and resolves them in parallel before persistence.
 */
async function update(
  id: number,
  fields: Record<string, unknown> & {
    tags?: string[];
    recipient_name?: string;
    recipient_id?: number | null;
    category_name?: string;
    category_id?: number | null;
  },
): Promise<EnrichedTransactionRow | null> {
  const [recipientId, categoryId] = await Promise.all([
    fields.recipient_name && !fields.recipient_id
      ? resolveRecipientIdByName(fields.recipient_name)
      : fields.recipient_id,
    fields.category_name && !fields.category_id
      ? resolveCategoryIdByName(fields.category_name)
      : fields.category_id,
  ]);

  const {
    recipient_name: _recipientName,
    category_name: _categoryName,
    ...patch
  } = fields;
  if (recipientId !== undefined) patch.recipient_id = recipientId;
  if (categoryId !== undefined) patch.category_id = categoryId;

  const updated = await transactionRepository.update(id, patch);
  if (updated) scheduleReconcile();
  return updated;
}

function listTransferSuggestions(): ReturnType<typeof getTransferSuggestions> {
  return getTransferSuggestions();
}

async function markTransfer(aId: number, bId: number) {
  await markTransferRecord(aId, bId);
  scheduleReconcile();
}

async function unmarkTransfer(id: number) {
  await unmarkTransferRecord(id);
  scheduleReconcile();
}

export const transactionService = {
  ...transactionRepository,
  createManualTransaction,
  update,
  hardDeleteWithCleanup,
  getTransferSuggestions: listTransferSuggestions,
  markTransfer,
  unmarkTransfer,
};

export default transactionService;
