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

import transactionRepository from "../repositories/transactionRepository.js";
import {
  isManualDuplicate,
  recordManualRawTransaction,
} from "./deduplication.js";
import { autoLinkTransactions } from "./plannedMatchService.js";
import { scheduleReconcile } from "./transferReconciliationService.js";
import {
  getTransferSuggestions,
  markTransfer as markTransferRecord,
  unmarkTransfer as unmarkTransferRecord,
} from "./transferReconciliationService.js";
import { resolveRecipientIdByName } from "./recipientService.js";
import { resolveCategoryIdByName } from "./categoryService.js";
import { attachmentRepository } from "./attachmentRecordService.js";
import { removeAttachmentFilesBestEffort } from "./attachmentCleanup.js";
import { ConflictError } from "../middleware/errorHandler.js";
import { logger } from "../config/logger.js";

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
 * @param {{
 *   transaction_date?: string,
 *   date?: string,
 *   bank_account?: string|null,
 *   recipient_id?: number|null,
 *   amount: number|string,
 *   memo?: string|null,
 *   currency?: string|null,
 *   category_id?: number|null,
 *   comment?: string|null,
 *   tags?: string[]|null,
 * }} data zod-validated POST body — loose passthrough (see module doc above).
 * @returns {Promise<{ transaction: object, autoLink: { autoLinkedCount: number, links: Array<{ plannedTransactionId?: number }> } }>}
 */
async function createManualTransaction(data) {
  const txDate = data.transaction_date || data.date;

  const dupCheck = await isManualDuplicate({
    date: txDate,
    amount: data.amount,
    recipientId: data.recipient_id,
    memo: data.memo || "",
    bankAccount: data.bank_account,
  });

  if (dupCheck.isDuplicate) {
    throw new ConflictError("Duplicate transaction detected", {
      details: { existing_transaction_id: dupCheck.existingTransactionId },
    });
  }

  const transaction = await transactionRepository.create({
    transaction_date: txDate,
    bank_account: data.bank_account,
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

  await recordManualRawTransaction({
    date: txDate,
    amount: data.amount,
    recipientId: data.recipient_id,
    memo: data.memo || "",
    bankAccount: data.bank_account,
    categoryId: data.category_id || null,
    comment: data.comment || null,
    transactionId: transaction.id,
  });

  // Auto-clear a matching planned payment if this transaction unambiguously
  // matches one. Never let an auto-link failure fail the create.
  /** @type {{ autoLinkedCount: number, links: Array<{ plannedTransactionId?: number, transactionId?: number }> }} */
  let autoLink = { autoLinkedCount: 0, links: [] };
  try {
    autoLink = await autoLinkTransactions([transaction]);
  } catch (err) {
    logger.warn("Auto-link after manual create failed", {
      id: transaction.id,
      error: err?.message,
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
 * @param {number} id
 * @returns {Promise<boolean>} whether a row was deleted
 */
async function hardDeleteWithCleanup(id) {
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
 *
 * @param {number} id
 * @param {Record<string, any> & { tags?: string[] }} fields
 * @returns {Promise<object|null>}
 */
async function update(id, fields) {
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

/** @returns {ReturnType<typeof getTransferSuggestions>} */
function listTransferSuggestions() {
  return getTransferSuggestions();
}

/** @param {number} aId @param {number} bId */
async function markTransfer(aId, bId) {
  await markTransferRecord(aId, bId);
  scheduleReconcile();
}

/** @param {number} id */
async function unmarkTransfer(id) {
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
