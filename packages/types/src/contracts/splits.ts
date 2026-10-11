import { z } from "zod";

import { IdSchema, WireTimestampSchema, wireListOf } from "./common.ts";

/**
 * `formatSplit` (repositories/splitRepository.ts): NUMERIC `amount` and
 * `amount_paid` as numbers (`amount_paid` is 0 on `RETURNING *` rows), the
 * timestamps as serialized pg `Date`s.
 */
export const SplitSchema = z.looseObject({
  id: IdSchema,
  transaction_id: IdSchema,
  recipient_id: IdSchema,
  recipient_name: z.string().nullable(),
  amount: z.number(),
  amount_paid: z.number(),
  note: z.string().nullable(),
  is_settled: z.boolean(),
  created_at: WireTimestampSchema,
  updated_at: WireTimestampSchema,
});

/** `GET /api/splits/transaction/:id`. */
export const SplitListSchema = wireListOf(SplitSchema);

/** `computeOwedSummary` (lib/calculations/splits.ts). */
export const OwedSummaryItemSchema = z.looseObject({
  recipient_id: IdSchema,
  recipient_name: z.string(),
  total_owed: z.number(),
  total_paid: z.number(),
  remaining: z.number(),
  split_count: z.number().int().nonnegative(),
});

/** `GET /api/splits/owed`. */
export const OwedSummaryListSchema = wireListOf(OwedSummaryItemSchema);

/**
 * `splitService.getOwedByRecipient`: a split plus its parent transaction.
 * `transaction_date` is the raw pg `Date`, so it serializes as a timestamp.
 */
export const OwedDetailItemSchema = SplitSchema.extend({
  transaction_date: WireTimestampSchema,
  transaction_memo: z.string().nullable(),
  transaction_amount: z.number(),
  transaction_currency: z.string().nullable(),
  bank_account: z.string().nullable(),
  transaction_recipient_name: z.string().nullable(),
  remaining: z.number(),
});

/** `GET /api/splits/owed/:recipientId`. */
export const OwedDetailListSchema = wireListOf(OwedDetailItemSchema);

/** `createBulkSplitsAtomic` (services/splitService.ts). */
export const BulkSplitResultSchema = z.looseObject({
  requested: z.number().int().nonnegative(),
  split: z.number().int().nonnegative(),
  skipped_already_split: z.number().int().nonnegative(),
  skipped_zero_amount: z.number().int().nonnegative(),
  skipped_missing: z.number().int().nonnegative(),
  items: z.array(SplitSchema),
});

/** `POST /api/splits/owed/:recipientId/settle-all`. */
export const SettleAllResultSchema = z.looseObject({
  settled_count: z.number().int().nonnegative(),
});
