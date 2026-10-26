import { z } from "zod";

import { CategoryIdSchema, RecipientIdSchema, TagIdSchema } from "../brands.ts";
import { IdSchema, wireListOf } from "./common.ts";

/*
 * Wire contracts for /api/saved-charts (routes/savedCharts.ts). The type,
 * variant and bucket columns carry no CHECK constraint, but the route validates
 * them on every write (and openapi.yaml lists the values), so they are enums here.
 */

/** One `saved_charts` row (database/rows/catalog.ts savedChartRowSchema). */
export const SavedChartSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  chart_type: z.enum(["line", "bar", "area"]),
  category_ids: z.array(CategoryIdSchema),
  recipient_ids: z.array(RecipientIdSchema),
  tag_ids: z.array(TagIdSchema),
  all_categories: z.boolean(),
  all_recipients: z.boolean(),
  all_tags: z.boolean(),
  chart_variant: z.enum(["default", "stacked", "grouped", "ranked"]),
  time_bucket: z.enum(["monthly", "yearly"]),
  date_range_start: z.string().nullable(),
  date_range_end: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** `GET /api/saved-charts` — `{items, total}`, plus limit/offset when paginated. */
export const SavedChartListSchema = wireListOf(SavedChartSchema);
