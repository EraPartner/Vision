import { z } from "zod";

import { IdSchema, wireListOf } from "./common.ts";

/*
 * Wire contracts for /api/saved-charts (routes/savedCharts.ts). The type,
 * variant and bucket columns carry no CHECK constraint, so they stay strings
 * here; the route validates them on write.
 */

/** One `saved_charts` row (database/rows/catalog.ts savedChartRowSchema). */
export const SavedChartSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  chart_type: z.string(),
  category_ids: z.array(IdSchema),
  recipient_ids: z.array(IdSchema),
  tag_ids: z.array(IdSchema),
  all_categories: z.boolean(),
  all_recipients: z.boolean(),
  all_tags: z.boolean(),
  chart_variant: z.string(),
  time_bucket: z.string(),
  date_range_start: z.string().nullable(),
  date_range_end: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** `GET /api/saved-charts` — `{items, total}`, plus limit/offset when paginated. */
export const SavedChartListSchema = wireListOf(SavedChartSchema);
