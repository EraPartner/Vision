/** Planned-transaction orchestration above parameterized persistence. */

import { withTransaction } from "../database/connection.ts";
import { sanitizeUpdateFields } from "../lib/validation.ts";
import plannedTransactionRepository, {
  applyPlannedFieldUpdate,
  inheritTransactionTagsInTransaction,
  insertExecutionInTransaction,
  insertLoanScheduleBatch,
  insertPlannedTransactionInTransaction,
  replaceLoanScheduleInTransaction,
  setPlannedTransactionTags,
} from "../repositories/plannedTransactionRepository.ts";
import type { LoanScheduleEntryInput } from "../repositories/plannedTransactionRepository.ts";
import { stampAccountIdForUpdate } from "../repositories/transactionRepository.ts";

/**
 * @param input route-validated body; the create schema is a loose passthrough,
 *   so field types are not known here.
 */
export async function create(input: Record<string, any>) {
  const normalized = {
    ...input,
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
    // Validate the canonical account identity inside the write transaction.
    await stampAccountIdForUpdate(normalized, client);
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

export async function update(
  id: number,
  fields: Record<string, unknown> & { tags?: string[] },
) {
  const { tags, ...txFields } = fields;
  const sanitized = sanitizeUpdateFields("planned_transactions", txFields);

  const found = await withTransaction(async (client) => {
    await stampAccountIdForUpdate(sanitized, client);
    if (!(await applyPlannedFieldUpdate(client, id, sanitized))) return false;
    if (tags !== undefined) {
      await setPlannedTransactionTags(client, id, tags);
    }
    return true;
  });
  if (!found) return null;
  return plannedTransactionRepository.getById(id);
}

/**
 * Atomically update a planned row and replace its dependent loan schedule.
 * An empty schedule clears existing installments.
 */
export async function updateWithLoanSchedule(
  id: number,
  fields: Record<string, unknown> & { tags?: string[] },
  scheduleEntries: ReadonlyArray<LoanScheduleEntryInput> = [],
) {
  const { tags, ...txFields } = fields;
  const sanitized = sanitizeUpdateFields("planned_transactions", txFields);

  const found = await withTransaction(async (client) => {
    await stampAccountIdForUpdate(sanitized, client);
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

export async function executeAndAdvance(
  plannedTransactionId: number,
  executedTransactionId: number,
  executionDate: string,
  updateFields: Record<string, unknown> = {},
  tagIdsToInherit: number[] | null = null,
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
    await stampAccountIdForUpdate(sanitized, client);
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

export async function replaceLoanSchedule(
  id: number,
  scheduleEntries: ReadonlyArray<LoanScheduleEntryInput> = [],
) {
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
