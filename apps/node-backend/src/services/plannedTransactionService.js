/** Planned-transaction orchestration above parameterized persistence. */

import { withTransaction } from "../database/connection.js";
import { sanitizeUpdateFields } from "../lib/validation.js";
import plannedTransactionRepository, {
  applyPlannedFieldUpdate,
  inheritTransactionTagsInTransaction,
  insertExecutionInTransaction,
  insertLoanScheduleBatch,
  insertPlannedTransactionInTransaction,
  replaceLoanScheduleInTransaction,
  setPlannedTransactionTags,
  updatePlannedFields,
} from "../repositories/plannedTransactionRepository.js";
import { stampAccountIdForUpdate } from "../repositories/transactionRepository.js";

/**
 * @param {Record<string, any>} input
 */
export async function create(input) {
  const normalized = {
    ...input,
    bank_account: input.bank_account ? input.bank_account.toUpperCase() : null,
    memo: input.memo ? input.memo.toUpperCase() : null,
    currency: input.currency ? input.currency.toUpperCase() : "EUR",
    url: input.url || null,
    is_recurring: input.is_recurring || false,
    recurrence_pattern: input.is_loan
      ? "monthly"
      : input.recurrence_pattern || null,
    recurrence_end_date: input.recurrence_end_date || null,
    max_occurrences:
      input.max_occurrences != null ? Number(input.max_occurrences) : null,
    reminder_days_before:
      input.reminder_days_before != null
        ? Number(input.reminder_days_before)
        : null,
    is_loan: input.is_loan || false,
    loan_type: input.loan_type || null,
    loan_principal:
      input.loan_principal != null ? Number(input.loan_principal) : null,
    loan_annual_interest_rate:
      input.loan_annual_interest_rate != null
        ? Number(input.loan_annual_interest_rate)
        : null,
    loan_term_months:
      input.loan_term_months != null ? Number(input.loan_term_months) : null,
    loan_start_date: input.loan_start_date || null,
    loan_payment_day:
      input.loan_payment_day != null ? Number(input.loan_payment_day) : null,
    loan_regular_payment_amount:
      input.loan_regular_payment_amount != null
        ? Number(input.loan_regular_payment_amount)
        : null,
    loan_first_payment_date: input.loan_first_payment_date || null,
  };

  const plannedId = await withTransaction(async (client) => {
    const id = await insertPlannedTransactionInTransaction(client, normalized);
    if (
      normalized.is_loan &&
      Array.isArray(input.loan_schedule) &&
      input.loan_schedule.length > 0
    ) {
      await insertLoanScheduleBatch(client, id, input.loan_schedule);
    }
    if (Array.isArray(input.tags) && input.tags.length > 0) {
      await setPlannedTransactionTags(client, id, input.tags);
    }
    return id;
  });
  return plannedTransactionRepository.getById(plannedId);
}

/** @param {number} id @param {Record<string, any> & {tags?:string[]}} fields */
export async function update(id, fields) {
  const { tags, ...txFields } = fields;
  const sanitized = sanitizeUpdateFields("planned_transactions", txFields);
  await stampAccountIdForUpdate(sanitized);

  if (tags === undefined) {
    return updatePlannedFields(id, sanitized);
  }

  const found = await withTransaction(async (client) => {
    if (!(await applyPlannedFieldUpdate(client, id, sanitized))) return false;
    await setPlannedTransactionTags(client, id, tags);
    return true;
  });
  if (!found) return null;
  return plannedTransactionRepository.getById(id);
}

/**
 * Atomically update a planned row and replace its dependent loan schedule.
 * An empty schedule clears existing installments.
 *
 * @param {number} id
 * @param {Record<string, any> & { tags?: string[] }} fields
 * @param {Array<Record<string, any>>} [scheduleEntries]
 */
export async function updateWithLoanSchedule(id, fields, scheduleEntries = []) {
  const { tags, ...txFields } = fields;
  const sanitized = sanitizeUpdateFields("planned_transactions", txFields);
  await stampAccountIdForUpdate(sanitized);

  const found = await withTransaction(async (client) => {
    if (!(await applyPlannedFieldUpdate(client, id, sanitized))) return false;
    if (tags !== undefined) {
      await setPlannedTransactionTags(client, id, tags);
    }
    await replaceLoanScheduleInTransaction(client, id, scheduleEntries);
    return true;
  });

  if (!found) return null;
  return plannedTransactionRepository.getById(id);
}

/**
 * @param {number} plannedTransactionId
 * @param {number} executedTransactionId
 * @param {string} executionDate
 * @param {Record<string, any>} [updateFields]
 * @param {number[]|null} [tagIdsToInherit]
 */
export async function executeAndAdvance(
  plannedTransactionId,
  executedTransactionId,
  executionDate,
  updateFields = {},
  tagIdsToInherit = null,
) {
  return withTransaction(async (client) => {
    const inserted = await insertExecutionInTransaction(
      client,
      plannedTransactionId,
      executedTransactionId,
      executionDate,
    );
    if (!inserted) return { duplicate: true };

    const sanitized = sanitizeUpdateFields(
      "planned_transactions",
      updateFields,
    );
    if (Object.keys(sanitized).length > 0) {
      await applyPlannedFieldUpdate(client, plannedTransactionId, sanitized);
    }
    if (Array.isArray(tagIdsToInherit) && tagIdsToInherit.length > 0) {
      await inheritTransactionTagsInTransaction(
        client,
        executedTransactionId,
        tagIdsToInherit,
      );
    }
    return { duplicate: false };
  });
}

/** @param {number} id @param {Array<Record<string, any>>} [scheduleEntries] */
export async function replaceLoanSchedule(id, scheduleEntries = []) {
  return withTransaction((client) =>
    replaceLoanScheduleInTransaction(client, id, scheduleEntries),
  );
}

export default {
  ...plannedTransactionRepository,
  create,
  update,
  updateWithLoanSchedule,
  executeAndAdvance,
  replaceLoanSchedule,
};
