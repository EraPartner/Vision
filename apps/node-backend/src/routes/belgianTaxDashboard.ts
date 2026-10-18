import { Router } from "express";
import { z } from "zod";
import { parseInput } from "../lib/zodInput.ts";
import { parseAggregationDateRange } from "../lib/aggregationDateRange.ts";
import { validateIntArray } from "../lib/validation.ts";
import { getTaxDashboard } from "../services/tax/dashboardService.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import { ymdToEpochDay } from "../lib/timezone.ts";

const router = Router();
const schema = z
  .object({
    year: z
      .string()
      .regex(/^\d{4}$/)
      .transform(Number)
      .pipe(z.number().int().min(1900).max(2200))
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .transform((s) => s.toUpperCase())
      .default("EUR"),
  })
  .passthrough();
function ids(raw: unknown, name: string) {
  if (raw === undefined || raw === "") return [];
  const parsed = validateIntArray(Array.isArray(raw) ? raw : [raw], name);
  if (!parsed.valid) throw new ValidationError(parsed.error);
  return parsed.value;
}
router.get("/dashboard", async (req, res) => {
  const parsed = parseInput(schema, req.query);
  const range = parseAggregationDateRange(parsed);
  for (const value of [range.startDate, range.endDate]) {
    if (value) {
      try {
        ymdToEpochDay(value);
      } catch {
        throw new ValidationError("Date bounds must be valid calendar dates");
      }
    }
  }
  res.ok(
    await getTaxDashboard({
      year: parsed.year,
      targetCurrency: parsed.currency,
      ...range,
      excludedCategoryIds: ids(
        parsed.excluded_category_ids,
        "excluded_category_ids",
      ),
      excludedRecipientIds: ids(
        parsed.excluded_recipient_ids,
        "excluded_recipient_ids",
      ),
    }),
  );
});
export default router;
