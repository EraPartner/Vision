/** Split lifecycle, validation, projection, and audit orchestration. */

import crypto from "node:crypto";
import { withTransaction } from "../database/connection.ts";
import { appendAuditEvent } from "../repositories/auditChainRepository.ts";
import type { BulkSplitMode } from "../lib/calculations/splits.ts";
import {
  computeBulkSplitAmount,
  computeOwedSummary,
  normalizeMoneyAmount,
  roundToMoneyPrecision,
  validateBatchSplitAllocation,
  validateSplitAllocation,
} from "../lib/calculations/splits.ts";
import { subtract, toDecimal, toNumber } from "../lib/money.ts";
import { toAppDateString } from "../lib/timezone.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import splitRepository, {
  formatSplit,
  getPaidAmountInTransaction,
  insertPaymentInTransaction,
  insertSplitInTransaction,
  insertSplitsBatchInTransaction,
  lockAndGetTotals,
  lockSplitForPayment,
  markSettledIfCovered,
  recipientExistsInTransaction,
} from "../repositories/splitRepository.ts";
import type { FormattedSplit } from "../types/rows.ts";

type SplitAuditInput = Parameters<typeof splitRepository.writeAudit>[0];

async function writeSplitAudit(input: SplitAuditInput) {
  const row = await splitRepository.writeAudit(input);
  if (!row) throw new Error("Split audit insert did not return a row");
  const auditDigest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        input.split_id === null ? null : String(input.split_id),
        input.action,
        input.actor ?? null,
        row.payload_text ?? null,
        row.occurred_at,
      ]),
    )
    .digest("hex");
  await appendAuditEvent({
    stream: "split",
    event: input.action,
    auditRowId: String(row.id),
    splitId: input.split_id === null ? null : String(input.split_id),
    actor: input.actor ?? null,
    occurred_at: row.occurred_at,
    auditDigest,
  });
  return row;
}

export async function createSplitAtomic(input: {
  transaction_id: number;
  recipient_id: number;
  amount: number | string;
  note?: string | null;
  actor?: string | null;
}) {
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
    await writeSplitAudit({
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
}: {
  transaction_id: number;
  splits: Array<{
    recipient_id: number;
    amount: number | string;
    note?: string | null;
  }>;
  actor?: string | null;
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
      await writeSplitAudit({
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

/**
 * Bulk split: give ONE other person a preset share of MANY transactions in
 * one atomic write (POST /api/splits/bulk).
 *
 * Per transaction the share is `computeBulkSplitAmount` (equal = half,
 * full = the whole amount). Rows the preset cannot apply to are skipped and
 * counted rather than failing the batch: an id that no longer exists, a
 * transaction that already carries a split (a preset on top of an existing
 * allocation has no single right answer — the user edits those one by one),
 * and a zero-amount transaction. Ids are deduplicated and locked in
 * ascending order so two overlapping bulk calls cannot deadlock.
 */
export async function createBulkSplitsAtomic({
  transaction_ids,
  recipient_id,
  mode,
  note,
  actor = null,
}: {
  transaction_ids: number[];
  recipient_id: number;
  mode: BulkSplitMode;
  note?: string | null;
  actor?: string | null;
}) {
  const ids = Array.from(new Set(transaction_ids)).sort((a, b) => a - b);
  const requested = transaction_ids.length;
  return withTransaction(async (client) => {
    if (!(await recipientExistsInTransaction(client, recipient_id)))
      throw new NotFoundError("Recipient not found");

    const items: FormattedSplit[] = [];
    const result = {
      requested,
      split: 0,
      skipped_already_split: 0,
      skipped_zero_amount: 0,
      skipped_missing: 0,
      items,
    };

    for (const transaction_id of ids) {
      const totals = await lockAndGetTotals(client, transaction_id);
      if (!totals) {
        result.skipped_missing += 1;
        continue;
      }
      if (totals.current_split_total > 0) {
        result.skipped_already_split += 1;
        continue;
      }
      const amount = computeBulkSplitAmount({
        transactionTotal: totals.transaction_total,
        mode,
      });
      if (amount <= 0) {
        result.skipped_zero_amount += 1;
        continue;
      }
      const check = validateSplitAllocation({
        newSplitAmount: amount,
        transactionTotal: totals.transaction_total,
        currentSplitTotal: totals.current_split_total,
      });
      if (!check.ok) throw new ValidationError(check.error);
      const split = await insertSplitInTransaction(client, {
        transaction_id,
        recipient_id,
        amount,
        note,
      });
      await writeSplitAudit({
        split_id: split.id,
        action: "create",
        actor,
        payload: {
          transaction_id,
          recipient_id,
          amount,
          note: note || null,
          bulk: true,
          mode,
        },
        client,
      });
      result.items.push(split);
      result.split += 1;
    }
    return result;
  });
}

export async function getOwedSummary() {
  const rows = await splitRepository.getOwedSummaryRows();
  return computeOwedSummary(rows);
}

export async function getOwedByRecipient(
  recipientId: number,
  page: { limit?: number | null; offset?: number } = {},
) {
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

export async function addPayment(input: {
  split_id: number;
  amount: number | string;
  note?: string | null;
  paid_at?: string | null;
  actor?: string | null;
}) {
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
    await writeSplitAudit({
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

export async function settleSplit(
  splitId: number,
  actor: string | null = null,
) {
  return withTransaction(async (client) => {
    const split = await splitRepository.settleSplit(splitId, client);
    if (!split) return null;
    await writeSplitAudit({
      split_id: splitId,
      action: "settle",
      actor,
      payload: { manual: true },
      client,
    });
    return split;
  });
}

export async function settleAllByRecipient(
  recipientId: number,
  actor: string | null = null,
) {
  return withTransaction(async (client) => {
    const result = await splitRepository.settleAllByRecipient(
      recipientId,
      client,
    );
    if (result.settled_count > 0)
      await writeSplitAudit({
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

export async function deleteSplit(
  splitId: number,
  actor: string | null = null,
) {
  return withTransaction(async (client) => {
    const split = await splitRepository.getSplitById(splitId, client);
    if (!split) return false;
    if (!(await splitRepository.deleteSplit(splitId, client))) return false;
    await writeSplitAudit({
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
  createBulkSplitsAtomic,
  getOwedSummary,
  getOwedByRecipient,
  addPayment,
  settleSplit,
  settleAllByRecipient,
  deleteSplit,
};
