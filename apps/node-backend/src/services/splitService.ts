/** Split lifecycle, validation and projection. */

import { withTransaction } from "../database/connection.ts";
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
  money,
  roundMoney,
  subtract,
  sumMoney,
  toDecimal,
  toNumber,
  type Money,
} from "../lib/money.ts";
import { EUR } from "../lib/currencyCode.ts";
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
import { nanToZero } from "../lib/math.ts";
import type {
  CurrencyCode,
  RecipientId,
  SplitId,
  TransactionId,
} from "@vision/types/brands";

export async function createSplitAtomic(input: {
  transaction_id: TransactionId;
  recipient_id: RecipientId;
  amount: number | string;
  note?: string | null | undefined;
}) {
  const { transaction_id, recipient_id, amount, note } = input;
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
    return insertSplitInTransaction(client, {
      transaction_id,
      recipient_id,
      amount: normalizedAmount,
      note,
    });
  });
}

export async function createSplitsBatchAtomic({
  transaction_id,
  splits,
}: {
  transaction_id: TransactionId;
  splits: Array<{
    recipient_id: RecipientId;
    amount: number | string;
    note?: string | null;
  }>;
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
    return insertSplitsBatchInTransaction(client, transaction_id, prepared);
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
}: {
  transaction_ids: TransactionId[];
  recipient_id: RecipientId;
  mode: BulkSplitMode;
  note?: string | null | undefined;
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
      result.items.push(split);
      result.split += 1;
    }
    return result;
  });
}

/** Unsettled money left out of a converted owed figure for want of a rate. */
interface UnconvertedOwed {
  count: number;
  currencies: Set<CurrencyCode>;
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
  currency = EUR,
}: { currency?: CurrencyCode } = {}) {
  const target = currency;
  const [rows, rates] = await Promise.all([
    splitRepository.getOwedSummaryRows(),
    loadLatestRatesToEur(),
  ]);
  const recipients = new Map<
    RecipientId,
    {
      name: string;
      owed: Money[];
      paid: Money[];
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
    entry.splitCount += nanToZero(parseInt(row.split_count, 10));
    const from = currencyCode(row.currency);
    const owed = convertAtLatestRates(
      money(row.total_owed, from),
      target,
      rates,
    );
    const paid = convertAtLatestRates(
      money(row.total_paid, from),
      target,
      rates,
    );
    if (owed && paid) {
      entry.owed.push(owed);
      entry.paid.push(paid);
    } else if (toDecimal(row.total_owed).gt(toDecimal(row.total_paid))) {
      entry.unconverted.count += nanToZero(parseInt(row.split_count, 10));
      entry.unconverted.currencies.add(from);
    }
  }
  const converted = computeOwedSummary(
    [...recipients].map(([recipientId, entry]) => ({
      recipient_id: recipientId,
      recipient_name: entry.name,
      total_owed: sumMoney(entry.owed, target).amount.toString(),
      total_paid: sumMoney(entry.paid, target).amount.toString(),
      split_count: String(entry.splitCount),
    })),
  );
  const listed = new Set(converted.map((row) => row.recipient_id));
  const unconvertedOf = (recipientId: RecipientId) =>
    recipients.get(recipientId)?.unconverted ?? {
      count: 0,
      currencies: new Set<CurrencyCode>(),
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
  recipientId: RecipientId,
  { currency = EUR }: { currency?: CurrencyCode } = {},
) {
  const target = currency;
  const [rows, rates] = await Promise.all([
    splitRepository.getOwedRemainingByCurrency(recipientId),
    loadLatestRatesToEur(),
  ]);
  const amounts: Money[] = [];
  const unconverted: UnconvertedOwed = { count: 0, currencies: new Set() };
  for (const row of rows) {
    const from = currencyCode(row.currency);
    const remaining = toDecimal(row.remaining);
    const converted = convertAtLatestRates(
      money(remaining, from),
      target,
      rates,
    );
    if (converted) amounts.push(converted);
    else if (!remaining.isZero()) {
      unconverted.count += nanToZero(parseInt(row.split_count, 10));
      unconverted.currencies.add(from);
    }
  }
  return {
    currency: target,
    remaining: roundMoney(sumMoney(amounts, target).amount),
    ...unconvertedFields(unconverted),
  };
}

export async function getOwedByRecipient(
  recipientId: RecipientId,
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
  split_id: SplitId;
  amount: number | string;
  note?: string | null | undefined;
  paid_at?: string | null | undefined;
}) {
  const { split_id, amount, note, paid_at } = input;
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
    await markSettledIfCovered(client, split_id);
    return payment;
  });
}

export async function settleSplit(splitId: SplitId) {
  return splitRepository.settleSplit(splitId);
}

export async function settleAllByRecipient(recipientId: RecipientId) {
  return splitRepository.settleAllByRecipient(recipientId);
}

export async function deleteSplit(splitId: SplitId) {
  return splitRepository.deleteSplit(splitId);
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
