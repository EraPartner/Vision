/** Split lifecycle, validation, projection, and audit orchestration. */

import { withTransaction } from "../database/connection.js";
import {
  computeOwedSummary,
  normalizeMoneyAmount,
  roundToMoneyPrecision,
  validateBatchSplitAllocation,
  validateSplitAllocation,
} from "../lib/calculations/splits.js";
import { subtract, toDecimal, toNumber } from "../lib/money.js";
import { toAppDateString } from "../lib/timezone.js";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.js";
import splitRepository, {
  formatSplit,
  getPaidAmountInTransaction,
  insertPaymentInTransaction,
  insertSplitInTransaction,
  insertSplitsBatchInTransaction,
  lockAndGetTotals,
  lockSplitForPayment,
  markSettledIfCovered,
} from "../repositories/splitRepository.js";

/**
 * @param {{transaction_id:number, recipient_id:number, amount:number|string, note?:string|null, actor?:string|null}} input
 */
export async function createSplitAtomic(input) {
  const { transaction_id, recipient_id, amount, note, actor = null } = input;
  return withTransaction(async (client) => {
    const totals = await lockAndGetTotals(client, transaction_id);
    if (!totals) throw new NotFoundError("Transaction not found");
    const normalizedAmount = normalizeMoneyAmount(Number(amount));
    const check = validateSplitAllocation({
      newSplitAmount: normalizedAmount,
      transactionTotal: totals.transaction_total,
      currentSplitTotal: totals.current_split_total,
    });
    if (!check.ok) throw new ValidationError(check.error);
    const split = await insertSplitInTransaction(client, {
      transaction_id,
      recipient_id,
      amount: normalizedAmount,
      note,
    });
    await splitRepository.writeAudit({
      split_id: split.id,
      action: "create",
      actor,
      payload: {
        transaction_id,
        recipient_id,
        amount: normalizedAmount,
        note: note || null,
      },
      client,
    });
    return split;
  });
}

export async function createSplitsBatchAtomic({
  transaction_id,
  splits,
  actor = null,
}) {
  if (!Array.isArray(splits) || splits.length === 0) return [];
  return withTransaction(async (client) => {
    const totals = await lockAndGetTotals(client, transaction_id);
    if (!totals) throw new NotFoundError("Transaction not found");
    const prepared = splits.map((split) => ({
      recipient_id: split.recipient_id,
      amount: normalizeMoneyAmount(Number(split.amount)),
      note: split.note || null,
    }));
    const check = validateBatchSplitAllocation({
      splits: prepared,
      transactionTotal: totals.transaction_total,
      currentSplitTotal: totals.current_split_total,
    });
    if (!check.ok) throw new ValidationError(check.error);
    const created = await insertSplitsBatchInTransaction(
      client,
      transaction_id,
      prepared,
    );
    for (const split of created) {
      await splitRepository.writeAudit({
        split_id: split.id,
        action: "create",
        actor,
        payload: {
          transaction_id,
          recipient_id: split.recipient_id,
          amount: split.amount,
          note: split.note || null,
          batch: true,
        },
        client,
      });
    }
    return created;
  });
}

export async function getOwedSummary() {
  const rows = await splitRepository.getOwedSummaryRows();
  return computeOwedSummary(/** @type {any} */ (rows));
}

export async function getOwedByRecipient(recipientId, page = {}) {
  const rows = await splitRepository.getOwedByRecipientRows(recipientId, page);
  return rows.map((row) => ({
    ...formatSplit(row),
    transaction_date: row.transaction_date,
    transaction_memo: row.transaction_memo,
    transaction_amount: toNumber(toDecimal(row.transaction_amount)),
    transaction_currency: row.transaction_currency,
    bank_account: row.bank_account,
    transaction_recipient_name: row.transaction_recipient_name,
    amount_paid: toNumber(toDecimal(row.amount_paid)),
    remaining: toNumber(subtract(row.amount, row.amount_paid)),
  }));
}

/**
 * @param {{split_id:number, amount:number|string, note?:string|null, paid_at?:string|null, actor?:string|null}} input
 */
export async function addPayment(input) {
  const { split_id, amount, note, paid_at, actor = null } = input;
  return withTransaction(async (client) => {
    const split = await lockSplitForPayment(client, split_id);
    if (!split) throw new NotFoundError("Split not found");
    if (split.is_settled) throw new ValidationError("Split is already settled");
    const normalizedAmount = normalizeMoneyAmount(amount);
    const alreadyPaid = await getPaidAmountInTransaction(client, split_id);
    const projected = roundToMoneyPrecision(
      toDecimal(alreadyPaid).plus(normalizedAmount),
    );
    if (projected.gt(roundToMoneyPrecision(split.amount)))
      throw new ValidationError(
        "Payment would exceed split outstanding balance",
      );
    const payment = await insertPaymentInTransaction(client, {
      split_id,
      amount: normalizedAmount,
      note,
      paid_at: paid_at || toAppDateString(new Date()),
    });
    const autoSettled = await markSettledIfCovered(client, split_id);
    await splitRepository.writeAudit({
      split_id,
      action: "payment",
      actor,
      payload: {
        payment_id: payment.id,
        amount: normalizedAmount,
        paid_at: payment.paid_at,
        note: note || null,
        auto_settled: autoSettled,
      },
      client,
    });
    return payment;
  });
}

export async function settleSplit(splitId, actor = null) {
  return withTransaction(async (client) => {
    const split = await splitRepository.settleSplit(splitId, client);
    if (!split) return null;
    await splitRepository.writeAudit({
      split_id: splitId,
      action: "settle",
      actor,
      payload: { manual: true },
      client,
    });
    return split;
  });
}

export async function settleAllByRecipient(recipientId, actor = null) {
  return withTransaction(async (client) => {
    const result = await splitRepository.settleAllByRecipient(
      recipientId,
      client,
    );
    if (result.settled_count > 0)
      await splitRepository.writeAudit({
        split_id: null,
        action: "settle_all",
        actor,
        payload: {
          recipient_id: recipientId,
          settled_count: result.settled_count,
        },
        client,
      });
    return result;
  });
}

export async function deleteSplit(splitId, actor = null) {
  return withTransaction(async (client) => {
    const split = await splitRepository.getSplitById(splitId, client);
    if (!split) return false;
    if (!(await splitRepository.deleteSplit(splitId, client))) return false;
    await splitRepository.writeAudit({
      split_id: null,
      action: "delete",
      actor,
      payload: {
        split_id: splitId,
        transaction_id: split.transaction_id,
        recipient_id: split.recipient_id,
        amount: split.amount,
      },
      client,
    });
    return true;
  });
}

export default {
  ...splitRepository,
  createSplitAtomic,
  createSplitsBatchAtomic,
  getOwedSummary,
  getOwedByRecipient,
  addPayment,
  settleSplit,
  settleAllByRecipient,
  deleteSplit,
};
