import { z } from "zod";

import {
  CategoryIdSchema,
  RecipientIdSchema,
  SplitIdSchema,
} from "../brands.ts";
import { IdSchema, WireDateSchema, WireTimestampSchema } from "./common.ts";
import { SplitSchema } from "./splits.ts";

/** `POST /api/transactions/bulk-tag` — `bulkTagTransactions` counts. */
export const BulkTagResultSchema = z.looseObject({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  transactions_affected: z.number().int().nonnegative(),
});

/** `POST /api/splits/batch` — `{ items, total }` of formatted splits. */
export const SplitBatchResultSchema = z.looseObject({
  items: z.array(SplitSchema),
  total: z.number().int().nonnegative(),
});

/** `POST /api/splits/:id/pay` — `formatPayment` of the inserted `split_payments` row. */
export const SplitPaymentSchema = z.looseObject({
  id: IdSchema,
  split_id: SplitIdSchema,
  amount: z.number(),
  note: z.string().nullable(),
  paid_at: WireDateSchema,
  created_at: WireTimestampSchema,
});

/** `POST /api/admin/database/vacuum`. */
export const VacuumResultSchema = z.looseObject({ vacuumed: z.string() });

/** `POST /api/analysis/cancel/:requestId`; `reason` only when no query was running. */
export const AnalysisCancelResultSchema = z.looseObject({
  cancelled: z.boolean(),
  reason: z.string().optional(),
});

/** `POST /api/import/batches/:id/rows/:rowId/override`. */
export const ImportRowRecipientOverrideSchema = z.looseObject({
  row_id: IdSchema,
  user_override_recipient_id: RecipientIdSchema.nullable(),
});

/** `POST /api/import/batches/:id/rows/:rowId/category-override`. */
export const ImportRowCategoryOverrideSchema = z.looseObject({
  row_id: IdSchema,
  override_category_id: CategoryIdSchema.nullable(),
});

/** `POST /api/recipients/:id/patterns`. */
export const RecipientPatternCreatedSchema = z.looseObject({ id: IdSchema });

/** `PATCH /api/recipients/:id/patterns/:patternId`. */
export const RecipientPatternUpdatedSchema = z.looseObject({
  patternId: IdSchema,
});
