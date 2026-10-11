import { z } from "zod";

import {
  IdSchema,
  WireDateSchema,
  WireLinkSchema,
  WireTimestampSchema,
  wireCollectionOf,
  wirePageOf,
} from "./common.ts";
import { TransactionTagRefSchema } from "./transactions.ts";

/** One `loan_schedule` installment: NUMERIC columns converted to numbers. */
export const LoanScheduleEntrySchema = z.looseObject({
  installment_number: z.number().int(),
  due_date: WireDateSchema,
  payment_amount: z.number(),
  principal_amount: z.number(),
  interest_amount: z.number(),
  remaining_principal: z.number(),
});

/** One `planned_transaction_executions` row as the formatter emits it. */
export const PlannedExecutionSchema = z.looseObject({
  id: IdSchema,
  executed_transaction_id: IdSchema,
  execution_date: WireDateSchema,
  /** Nullable/optional in `plannedExecutionRowSchema`; an absent value drops the key. */
  created_at: WireTimestampSchema.nullable().optional(),
});

/**
 * `formatPlannedTransaction` (routes/plannedTransactions.ts): the body of the
 * list items, `POST`, `PATCH`, `GET /:id` and `POST /:id/execute`. DATE columns
 * are calendar-day strings, NUMERIC columns numbers. `bank_account`,
 * `recurrence_end_date` and the timestamps are optional in the row schema, so
 * their keys can be absent.
 */
export const PlannedTransactionSchema = z.looseObject({
  id: IdSchema,
  planned_date: WireDateSchema,
  bank_account: z.string().nullable().optional(),
  recipient_id: IdSchema.nullable(),
  recipient_name: z.string().nullable(),
  memo: z.string().nullable(),
  amount: z.number(),
  currency: z.string().nullable(),
  category_id: IdSchema.nullable(),
  category_name: z.string().nullable(),
  comment: z.string().nullable(),
  url: z.string().nullable(),
  is_recurring: z.boolean(),
  recurrence_pattern: z.string().nullable(),
  recurrence_end_date: WireDateSchema.nullable().optional(),
  max_occurrences: z.number().int().nullable(),
  reminder_days_before: z.number().int().nullable(),
  is_executed: z.boolean(),
  last_executed_date: WireDateSchema.nullable(),
  is_loan: z.boolean(),
  loan_type: z.string().nullable(),
  loan_principal: z.number().nullable(),
  loan_annual_interest_rate: z.number().nullable(),
  loan_term_months: z.number().int().nullable(),
  loan_start_date: WireDateSchema.nullable(),
  loan_payment_day: z.number().int().nullable(),
  loan_regular_payment_amount: z.number().nullable(),
  loan_first_payment_date: WireDateSchema.nullable(),
  loan_schedule: z.array(LoanScheduleEntrySchema),
  executed_transaction_id: IdSchema.nullable(),
  execution_count: z.number().int().nonnegative(),
  executions: z.array(PlannedExecutionSchema),
  tags: z.array(TransactionTagRefSchema),
  is_active: z.boolean(),
  created_at: WireTimestampSchema.nullable().optional(),
  updated_at: WireTimestampSchema.nullable().optional(),
  links: z.array(WireLinkSchema),
});

/** `GET /api/planned-transactions` — always paginated. */
export const PlannedTransactionListSchema = wirePageOf(
  PlannedTransactionSchema,
);

/** `getMatchSuggestions` (services/plannedMatchService.ts). */
export const PlannedMatchSuggestionSchema = z.looseObject({
  planned: z.looseObject({
    id: IdSchema,
    recipient_id: IdSchema.nullable(),
    recipient_name: z.string().nullable(),
    amount: z.number(),
    planned_date: WireDateSchema,
    currency: z.string().nullable(),
    is_recurring: z.boolean(),
  }),
  candidates: z.array(
    z.looseObject({
      id: IdSchema,
      recipient_name: z.string().nullable(),
      amount: z.number(),
      transaction_date: WireDateSchema,
      currency: z.string().nullable(),
      memo: z.string().nullable(),
    }),
  ),
});

/** `GET /api/planned-transactions/match-suggestions`. */
export const PlannedMatchSuggestionListSchema = wireCollectionOf(
  PlannedMatchSuggestionSchema,
);
