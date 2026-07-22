/**
 * Planned-execution service.
 *
 * Single source of truth for "execute a planned transaction against a real
 * transaction". Shared by the POST /:id/execute route and the auto-link path
 * (plannedMatchService) so both compute the same updateFields, advance
 * recurring rows identically, and inherit tags the same way.
 *
 * Idempotency is delegated to plannedTransactionRepository.executeAndAdvance,
 * which guards on the UNIQUE (planned_transaction_id, executed_transaction_id)
 * index — re-running the same (planned, tx) pair is a no-op (duplicate: true).
 */

import plannedTransactionRepository from '../repositories/plannedTransactionRepository.js';
import { calculateNextDate } from '../lib/calculations/recurrence.js';
import { NotFoundError } from '../middleware/errorHandler.js';
import { toAppDateString, todayAppDateString } from '../lib/timezone.js';
import { toWireDate } from '../lib/dateFormat.js';

/**
 * Execute a planned transaction against an existing real transaction.
 *
 * @param {{ id: number, executedTransactionId: number, executionDate?: string }} args
 * @returns {Promise<{ current: object, duplicate: boolean }>} the refreshed
 *          planned-transaction row (raw, unformatted) and whether the execute
 *          was a duplicate replay.
 */
export async function executePlanned({ id, executedTransactionId, executionDate }) {
  const existing = await plannedTransactionRepository.getById(id);
  if (!existing) throw new NotFoundError(`Planned transaction ${id} not found`);

  const execDate = executionDate || todayAppDateString();
  const updateFields = {
    is_executed: !existing.is_recurring,
    last_executed_date: execDate,
  };

  if (existing.is_recurring && existing.recurrence_pattern) {
    // Recurrence bounds (migration 0071): the series COMPLETES — is_executed
    // stays true, planned_date stays put — when this execution reaches
    // max_occurrences, or when the next occurrence would fall past
    // recurrence_end_date. These bounds were collected by the form but dropped
    // at every layer, so bounded recurrences generated due bills forever.
    const priorExecutions = Number(existing.execution_count || 0);
    const reachedMaxOccurrences =
      existing.max_occurrences != null && priorExecutions + 1 >= Number(existing.max_occurrences);

    const baseDate = new Date(existing.planned_date);
    const nextDate = calculateNextDate(baseDate, existing.recurrence_pattern);
    if (nextDate) {
      // calculateNextDate returns a UTC instant for start-of-day in APP_TIMEZONE.
      // toISOString() takes the UTC calendar day, which is the *previous* day in
      // a UTC+ zone — moving a monthly payment one day earlier per cycle.
      // toAppDateString reads the date back in APP_TIMEZONE. (Day-of-month anchor
      // is intentionally sticky-clamped — see docs/features planned-transactions.)
      const nextYmd = toAppDateString(nextDate);
      const endYmd = toWireDate(existing.recurrence_end_date);
      const pastEndDate = endYmd != null && nextYmd > endYmd;

      if (reachedMaxOccurrences || pastEndDate) {
        updateFields.is_executed = true;
      } else {
        updateFields.planned_date = nextYmd;
        updateFields.is_executed = false;
      }
    }
  }

  const tagIdsToInherit = (existing.tags || []).map((t) => t.id);
  const { duplicate } = await plannedTransactionRepository.executeAndAdvance(
    id,
    executedTransactionId,
    execDate,
    updateFields,
    tagIdsToInherit,
  );

  const current = await plannedTransactionRepository.getById(id);
  return { current, duplicate };
}

export default { executePlanned };
