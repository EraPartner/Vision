/**
 * Saved Charts routes.
 *
 * Bodies are validated with zod through parseInput (ADR-193).
 */

import { Router } from "express";
import { z } from "zod";
import savedChartsService from "../services/savedChartsService.ts";
import {
  validateIntArray,
  validateIdParam,
  assertIdParam,
} from "../middleware/validation.ts";
import { NotFoundError } from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";
import { listBody, parseOptionalPagination } from "../lib/pagination.ts";

const router = Router();

const VALID_CHART_TYPES: [string, ...string[]] = ["line", "bar", "area"];
// 'ranked' aggregates each entity's total over the whole range into one bar
// (Most-Spent-Recipients style); it only applies to bar charts.
const VALID_CHART_VARIANTS: [string, ...string[]] = [
  "default",
  "stacked",
  "grouped",
  "ranked",
];
const VALID_TIME_BUCKETS: [string, ...string[]] = ["monthly", "yearly"];

// Disallowed (chart_type, chart_variant) pairs
const INVALID_COMBINATIONS = new Set([
  "line:stacked",
  "line:grouped",
  "area:grouped",
  "line:ranked",
  "area:ranked",
]);

/* ── Zod schemas ───────────────────────────────────────────────────────────── */

const enumField = (field: string, values: [string, ...string[]]) =>
  z.enum(values, { error: `"${field}" must be one of: ${values.join(", ")}` });

// z.enum wants a non-empty tuple type; the arrays above are declared as
// `[string, ...string[]]` rather than `as const` because they're also
// `.join(', ')`'d into error messages, where plain strings read better.
const chartTypeField = enumField("chartType", VALID_CHART_TYPES);
const chartVariantField = enumField("chartVariant", VALID_CHART_VARIANTS);
const timeBucketField = enumField("timeBucket", VALID_TIME_BUCKETS);

const boolField = (field: string) =>
  z.boolean({ error: `"${field}" must be a boolean` });

// Shares validateIntArray with settings.js's dashboard exclusion lists so
// accepted shapes stay identical (scalar wrapped to array, then validateId per
// element: a plain digit string or integer number, 1..2^31-1 — no trailing
// garbage, decimals or exponents); the coerced ints replace the raw input in
// the value handed to the repository.
const intArrayField = (field: string) =>
  z.unknown().transform((value, ctx) => {
    const result = validateIntArray(value, field);
    if (!result.valid) {
      ctx.addIssue({ code: "custom", message: result.error });
      return z.NEVER;
    }
    return result.value;
  });

// Distinguish "absent" (leave the stored value untouched) from "clear" (write
// NULL). The edit modal sends null to clear a chart's date range; older code
// mapped null/'' to undefined, which the repository skips, so a cleared range
// silently kept its old value.
const dateField = (field: string) =>
  z
    .unknown()
    .transform((value, ctx) => {
      if (value === null || value === "") return null;
      // Request-body boundary: Date accepts any value at runtime; the
      // getTime() check below is the validation.
      if (Number.isNaN(new Date(value as string | number | Date).getTime())) {
        ctx.addIssue({
          code: "custom",
          message: `Invalid date for "${field}"`,
        });
        return z.NEVER;
      }
      // savedChartsService's SavedChartInput declares dateRangeStart/End as
      // `string|null` ('YYYY-MM-DD'); the Date parse above only validates the
      // input, it does not reshape it — the raw value (whatever shape the caller
      // sent) is what the repository has always received.
      return value as string;
    })
    .optional();

const nameField = (message: string) =>
  z
    .string({ error: message })
    .refine((s) => s.trim().length > 0, message)
    .transform((s) => s.trim());

// Cross-field rule: runs after per-field parsing (and after create defaults),
// so on POST the resolved defaults participate in the combination check, while
// on PATCH it only fires when both fields are present in the body.
const assertValidCombination = (
  data: { chartType?: string; chartVariant?: string },
  ctx: z.RefinementCtx,
) => {
  const { chartType, chartVariant } = data;
  if (!chartType || !chartVariant) return;
  if (INVALID_COMBINATIONS.has(`${chartType}:${chartVariant}`)) {
    ctx.addIssue({
      code: "custom",
      message: `Invalid combination: chartType="${chartType}" with chartVariant="${chartVariant}"`,
    });
  }
};

const createChartSchema = z
  .object({
    name: nameField('Missing or invalid "name"'),
    chartType: chartTypeField.default("line"),
    chartVariant: chartVariantField.default("default"),
    timeBucket: timeBucketField.default("monthly"),
    categoryIds: intArrayField("categoryIds"),
    recipientIds: intArrayField("recipientIds").optional(),
    tagIds: intArrayField("tagIds").optional(),
    allCategories: boolField("allCategories").default(false),
    allRecipients: boolField("allRecipients").default(false),
    allTags: boolField("allTags").default(false),
    dateRangeStart: dateField("dateRangeStart"),
    dateRangeEnd: dateField("dateRangeEnd"),
  })
  .superRefine(assertValidCombination);

const updateChartSchema = z
  .object({
    name: nameField('Invalid "name"').optional(),
    chartType: chartTypeField.optional(),
    chartVariant: chartVariantField.optional(),
    timeBucket: timeBucketField.optional(),
    categoryIds: intArrayField("categoryIds").optional(),
    recipientIds: intArrayField("recipientIds").optional(),
    tagIds: intArrayField("tagIds").optional(),
    allCategories: boolField("allCategories").optional(),
    allRecipients: boolField("allRecipients").optional(),
    allTags: boolField("allTags").optional(),
    dateRangeStart: dateField("dateRangeStart"),
    dateRangeEnd: dateField("dateRangeEnd"),
  })
  .superRefine(assertValidCombination);

// Canonical collection shape `{items, total}`. Pagination is opt-in: without
// limit/offset this still answers every saved chart (the chart picker lists them
// all), and `total` is the row count — no COUNT round-trip needed.
router.get("/", async (req, res) => {
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const charts = await savedChartsService.getAll(page ?? {});
  const total = page ? await savedChartsService.getCount() : charts.length;
  res.ok(listBody(charts, total, page));
});

router.post("/", async (req, res) => {
  const data = parseInput(createChartSchema, req.body);
  const chart = await savedChartsService.create(data);
  res.status(201);
  res.ok(chart);
});

router.patch("/:id", validateIdParam, async (req, res) => {
  const id = assertIdParam(req);
  // Only fields present in the body reach the repository — buildSetClauses
  // skips absent/undefined fields, so partial updates stay partial.
  const data = parseInput(updateChartSchema, req.body);
  const updated = await savedChartsService.update(id, data);
  if (!updated) throw new NotFoundError("Saved chart not found");
  res.ok(updated);
});

router.delete("/:id", validateIdParam, async (req, res) => {
  const id = assertIdParam(req);
  const deleted = await savedChartsService.delete(id);
  if (!deleted) throw new NotFoundError("Saved chart not found");
  res.status(204).send();
});

export default router;
