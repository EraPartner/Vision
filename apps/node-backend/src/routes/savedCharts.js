/**
 * Saved Charts routes.
 *
 * Bodies are validated with zod (schema → safeParse → ValidationError), the
 * idiom established in settings.js/reports.js.
 */

import { Router } from 'express';
import { z } from 'zod';
import savedChartsRepository from '../services/savedChartsService.js';
import { validateIntArray } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const router = Router();

const VALID_CHART_TYPES = ['line', 'bar', 'area'];
// 'ranked' aggregates each entity's total over the whole range into one bar
// (Most-Spent-Recipients style); it only applies to bar charts.
const VALID_CHART_VARIANTS = ['default', 'stacked', 'grouped', 'ranked'];
const VALID_TIME_BUCKETS = ['monthly', 'yearly'];

// Disallowed (chart_type, chart_variant) pairs
const INVALID_COMBINATIONS = new Set([
  'line:stacked', 'line:grouped', 'area:grouped',
  'line:ranked', 'area:ranked',
]);

/* ── Zod schemas ───────────────────────────────────────────────────────────── */

const enumField = (field, values) =>
  z.enum(values, { error: `"${field}" must be one of: ${values.join(', ')}` });

const chartTypeField = enumField('chartType', VALID_CHART_TYPES);
const chartVariantField = enumField('chartVariant', VALID_CHART_VARIANTS);
const timeBucketField = enumField('timeBucket', VALID_TIME_BUCKETS);

const boolField = (field) => z.boolean({ error: `"${field}" must be a boolean` });

// Shares validateIntArray with the query-param routes so accepted shapes stay
// identical (scalar wrapped to array, parseInt coercion, 1..2^31-1 bounds); the
// coerced ints replace the raw input in the value handed to the repository.
const intArrayField = (field) => z.unknown().transform((value, ctx) => {
  const result = validateIntArray(value, field);
  if (!result.valid) {
    ctx.addIssue({ code: 'custom', message: result.error });
    return z.NEVER;
  }
  return result.value;
});

// Distinguish "absent" (leave the stored value untouched) from "clear" (write
// NULL). The edit modal sends null to clear a chart's date range; older code
// mapped null/'' to undefined, which the repository skips, so a cleared range
// silently kept its old value.
const dateField = (field) => z.unknown().transform((value, ctx) => {
  if (value === null || value === '') return null;
  if (Number.isNaN(new Date(/** @type {string|number|Date} */ (value)).getTime())) {
    ctx.addIssue({ code: 'custom', message: `Invalid date for "${field}"` });
    return z.NEVER;
  }
  return value;
}).optional();

const nameField = (message) => z.string({ error: message })
  .refine((s) => s.trim().length > 0, message)
  .transform((s) => s.trim());

// Cross-field rule: runs after per-field parsing (and after create defaults),
// so on POST the resolved defaults participate in the combination check, while
// on PATCH it only fires when both fields are present in the body.
const assertValidCombination = (data, ctx) => {
  const { chartType, chartVariant } = data;
  if (!chartType || !chartVariant) return;
  if (INVALID_COMBINATIONS.has(`${chartType}:${chartVariant}`)) {
    ctx.addIssue({
      code: 'custom',
      message: `Invalid combination: chartType="${chartType}" with chartVariant="${chartVariant}"`,
    });
  }
};

const createChartSchema = z.object({
  name: nameField('Missing or invalid "name"'),
  chartType: chartTypeField.default('line'),
  chartVariant: chartVariantField.default('default'),
  timeBucket: timeBucketField.default('monthly'),
  categoryIds: intArrayField('categoryIds'),
  recipientIds: intArrayField('recipientIds').optional(),
  tagIds: intArrayField('tagIds').optional(),
  allCategories: boolField('allCategories').default(false),
  allRecipients: boolField('allRecipients').default(false),
  allTags: boolField('allTags').default(false),
  dateRangeStart: dateField('dateRangeStart'),
  dateRangeEnd: dateField('dateRangeEnd'),
}).superRefine(assertValidCombination);

const updateChartSchema = z.object({
  name: nameField('Invalid "name"').optional(),
  chartType: chartTypeField.optional(),
  chartVariant: chartVariantField.optional(),
  timeBucket: timeBucketField.optional(),
  categoryIds: intArrayField('categoryIds').optional(),
  recipientIds: intArrayField('recipientIds').optional(),
  tagIds: intArrayField('tagIds').optional(),
  allCategories: boolField('allCategories').optional(),
  allRecipients: boolField('allRecipients').optional(),
  allTags: boolField('allTags').optional(),
  dateRangeStart: dateField('dateRangeStart'),
  dateRangeEnd: dateField('dateRangeEnd'),
}).superRefine(assertValidCombination);

function parseChartBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new ValidationError(msg);
  }
  return result.data;
}

function parseChartId(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid chart id');
  return id;
}

router.get('/', async (req, res) => {
  const charts = await savedChartsRepository.getAll();
  res.ok(charts);
});

router.post('/', async (req, res) => {
  const data = parseChartBody(createChartSchema, req.body);
  const chart = await savedChartsRepository.create(data);
  res.status(201);
  res.ok(chart);
});

router.patch('/:id', async (req, res) => {
  const id = parseChartId(req);
  // Only fields present in the body reach the repository — buildSetClauses
  // skips absent/undefined fields, so partial updates stay partial.
  const data = parseChartBody(updateChartSchema, req.body);
  const updated = await savedChartsRepository.update(id, data);
  if (!updated) throw new NotFoundError('Saved chart not found');
  res.ok(updated);
});

router.delete('/:id', async (req, res) => {
  const id = parseChartId(req);
  const deleted = await savedChartsRepository.delete(id);
  if (!deleted) throw new NotFoundError('Saved chart not found');
  res.status(204).send();
});

export default router;
