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
import {
  addAll,
  roundMoney,
  subtract,
  toDecimal,
  toNumber,
  type Decimal,
} from "../lib/money.ts";
import {
  convertAtLatestRates,
  currencyCode,
  loadLatestRatesToEur,
} from "./currency/latestRateConversion.ts";
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
  note?: string | null | undefined;
  actor?: string | null | undefined;
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
  note?: string | null | undefined;
  actor?: string | null | undefined;
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

/** Unsettled money left out of a converted owed figure for want of a rate. */
interface UnconvertedOwed {
  count: number;
  currencies: Set<string>;
}

function unconvertedFields(unconverted: UnconvertedOwed) {
  return {
    unconverted_count: unconverted.count,
    unconverted_currencies: [...unconverted.currencies].sort(),
  };
}

/**
 * Who owes what, in `currency`. A split is denominated in its transaction's
 * currency, so each recipient's per-currency owed and paid sums convert at the
 * latest stored rates before they are added up. A currency without a rate is
 * left out of the figures and its open splits are counted per recipient and
 * in `summary`, never added 1:1. `summary.remaining` is the page's total
 * outstanding across recipients.
 */
export async function getOwedSummary({
  currency = "EUR",
}: { currency?: string } = {}) {
  const target = currency.toUpperCase();
  const [rows, rates] = await Promise.all([
    splitRepository.getOwedSummaryRows(),
    loadLatestRatesToEur(),
  ]);
  const recipients = new Map<
    number,
    {
      name: string;
      owed: Decimal[];
      paid: Decimal[];
      splitCount: number;
      unconverted: UnconvertedOwed;
    }
  >();
  for (const row of rows) {
    let entry = recipients.get(row.recipient_id);
    if (!entry) {
      entry = {
        name: row.recipient_name,
        owed: [],
        paid: [],
        splitCount: 0,
        unconverted: { count: 0, currencies: new Set() },
      };
      recipients.set(row.recipient_id, entry);
    }
    entry.splitCount += parseInt(row.split_count, 10) || 0;
    const from = currencyCode(row.currency);
    const owed = convertAtLatestRates(
      toDecimal(row.total_owed),
      from,
      target,
      rates,
    );
    const paid = convertAtLatestRates(
      toDecimal(row.total_paid),
      from,
      target,
      rates,
    );
    if (owed && paid) {
      entry.owed.push(owed);
      entry.paid.push(paid);
    } else if (toDecimal(row.total_owed).gt(toDecimal(row.total_paid))) {
      entry.unconverted.count += parseInt(row.split_count, 10) || 0;
      entry.unconverted.currencies.add(from);
    }
  }
  const converted = computeOwedSummary(
    [...recipients].map(([recipientId, entry]) => ({
      recipient_id: recipientId,
      recipient_name: entry.name,
      total_owed: addAll(entry.owed).toString(),
      total_paid: addAll(entry.paid).toString(),
      split_count: String(entry.splitCount),
    })),
  );
  const listed = new Set(converted.map((row) => row.recipient_id));
  const unconvertedOf = (recipientId: number) =>
    recipients.get(recipientId)?.unconverted ?? {
      count: 0,
      currencies: new Set<string>(),
    };
  // A recipient whose only open splits lack a rate still owes money: keep the
  // row (with zero converted figures) after the convertible ones.
  const unconvertedOnly = [...recipients]
    .filter(([id, entry]) => !listed.has(id) && entry.unconverted.count > 0)
    .map(([id, entry]) => ({
      recipient_id: id,
      recipient_name: entry.name,
      total_owed: 0,
      total_paid: 0,
      remaining: 0,
      split_count: entry.splitCount,
    }));
  const items = [...converted, ...unconvertedOnly].map((row) => ({
    ...row,
    ...unconvertedFields(unconvertedOf(row.recipient_id)),
  }));
  const allUnconverted: UnconvertedOwed = { count: 0, currencies: new Set() };
  for (const [, entry] of recipients) {
    allUnconverted.count += entry.unconverted.count;
    for (const code of entry.unconverted.currencies)
      allUnconverted.currencies.add(code);
  }
  return {
    items,
    summary: {
      currency: target,
      remaining: roundMoney(addAll(items.map((row) => row.remaining))),
      ...unconvertedFields(allUnconverted),
    },
  };
}

/**
 * A recipient group's total outstanding in `currency` (every unsettled split,
 * whatever page of the detail list is shown), converted per transaction
 * currency at the latest stored rates; open splits without a rate are counted.
 */
export async function getOwedRecipientSummary(
  recipientId: number,
  { currency = "EUR" }: { currency?: string } = {},
) {
  const target = currency.toUpperCase();
  const [rows, rates] = await Promise.all([
    splitRepository.getOwedRemainingByCurrency(recipientId),
    loadLatestRatesToEur(),
  ]);
  const amounts: Decimal[] = [];
  const unconverted: UnconvertedOwed = { count: 0, currencies: new Set() };
  for (const row of rows) {
    const from = currencyCode(row.currency);
    const remaining = toDecimal(row.remaining);
    const converted = convertAtLatestRates(remaining, from, target, rates);
    if (converted) amounts.push(converted);
    else if (!remaining.isZero()) {
      unconverted.count += parseInt(row.split_count, 10) || 0;
      unconverted.currencies.add(from);
    }
  }
  return {
    currency: target,
    remaining: roundMoney(addAll(amounts)),
    ...unconvertedFields(unconverted),
  };
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
  note?: string | null | undefined;
  paid_at?: string | null | undefined;
  actor?: string | null | undefined;
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
  getOwedRecipientSummary,
  getOwedByRecipient,
  addPayment,
  settleSplit,
  settleAllByRecipient,
  deleteSplit,
};
