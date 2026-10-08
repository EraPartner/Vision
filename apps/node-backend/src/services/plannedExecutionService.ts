/**
 * Planned-execution service.
 *
 * Single source of truth for "execute a planned transaction against a real
 * transaction". Shared by the POST /:id/execute route and the auto-link path
 * (plannedMatchService) so both compute the same updateFields, advance
 * recurring rows identically, and inherit tags the same way.
 *
 * The parent row is locked before reading recurrence state. The replay check
 * and UNIQUE (planned_transaction_id, executed_transaction_id) index ensure
 * re-running the same pair is a no-op, including after series completion.
 */

import plannedTransactionService from "./plannedTransactionService.ts";
import { withTransaction } from "../database/connection.ts";
import { nextOccurrenceYmd } from "../lib/calculations/recurrence.ts";
import { ConflictError, NotFoundError } from "../middleware/errorHandler.ts";
import { todayAppDateString } from "../lib/timezone.ts";
import { toWireDate } from "../lib/dateFormat.ts";
import type { HydratedPlannedTransactionRow } from "../types/rows.ts";

export interface ExecutePlannedArgs {
  id: number;
  executedTransactionId: number;
  /** 'YYYY-MM-DD'; defaults to today in the app timezone. */
  executionDate?: string;
}

/**
 * Execute a planned transaction against an existing real transaction.
 *
 * @returns the refreshed planned-transaction row (raw, unformatted) and
 *          whether the execute was a duplicate replay.
 */
export async function executePlanned({
  id,
  executedTransactionId,
  executionDate,
}: ExecutePlannedArgs): Promise<{
  current: HydratedPlannedTransactionRow | null;
  duplicate: boolean;
}> {
  return withTransaction(async () => {
    await plannedTransactionService.lockForExecution(id);
    const existing = await plannedTransactionService.getById(id);
    if (!existing)
      throw new NotFoundError(`Planned transaction ${id} not found`);

    // A completed series still accepts a replay of its final execution.
    if (
      (existing.executions || []).some(
        (execution) =>
          Number(execution.executed_transaction_id) ===
          Number(executedTransactionId),
      )
    ) {
      return { current: existing, duplicate: true };
    }
    if (
      existing.is_recurring &&
      ((existing.max_occurrences != null &&
        Number(existing.execution_count || 0) >=
          Number(existing.max_occurrences)) ||
        (existing.is_executed &&
          (existing.max_occurrences != null ||
            existing.recurrence_end_date != null)))
    ) {
      throw new ConflictError("Recurring planned transaction is complete");
    }

    const execDate = executionDate || todayAppDateString();
    /**
     * Sanitized update payload for `plannedTransactionService.executeAndAdvance`
     * — write-side values, NOT the read-side row shape: both dates go in as
     * 'YYYY-MM-DD' strings (pg coerces on bind), whereas a fetched row's same
     * columns come back as `Date` (see `PlannedTransactionRow` in types/rows.ts).
     */
    const updateFields: {
      is_executed: boolean;
      last_executed_date: string;
      planned_date?: string;
    } = {
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
        existing.max_occurrences != null &&
        priorExecutions + 1 >= Number(existing.max_occurrences);

      // pg DATE values represent local calendar days, not instants in APP_TIMEZONE.
      // Preserve the stored day before applying the shared calendar recurrence.
      // planned_date is NOT NULL, so plannedYmd is always a string here.
      const plannedYmd = toWireDate(existing.planned_date);
      const nextYmd = plannedYmd
        ? nextOccurrenceYmd(plannedYmd, existing.recurrence_pattern)
        : undefined;
      if (nextYmd) {
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
    const { duplicate } = await plannedTransactionService.executeAndAdvance(
      id,
      executedTransactionId,
      execDate,
      updateFields,
      tagIdsToInherit,
    );

    const current = await plannedTransactionService.getById(id);
    return { current, duplicate };
  });
}

export default { executePlanned };
