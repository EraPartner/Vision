/**
 * Saved Charts routes.
 */

import { Router } from 'express';
import savedChartsRepository from '../services/savedChartsService.js';
import { validateIntArray } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const router = Router();

const VALID_CHART_TYPES = ['line', 'bar', 'area'];
const VALID_CHART_VARIANTS = ['default', 'stacked', 'grouped'];
const VALID_TIME_BUCKETS = ['monthly', 'yearly'];

// Disallowed (chart_type, chart_variant) pairs
const INVALID_COMBINATIONS = new Set(['line:stacked', 'line:grouped', 'area:grouped']);

function parseChartId(req) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) throw new ValidationError('Invalid chart id');
  return id;
}

function assertChartType(chartType, { required = false } = {}) {
  if (required && !chartType) throw new ValidationError(`"chartType" must be one of: ${VALID_CHART_TYPES.join(', ')}`);
  if (chartType !== undefined && !VALID_CHART_TYPES.includes(chartType)) {
    throw new ValidationError(`"chartType" must be one of: ${VALID_CHART_TYPES.join(', ')}`);
  }
}

function assertChartVariant(chartVariant) {
  if (chartVariant !== undefined && !VALID_CHART_VARIANTS.includes(chartVariant)) {
    throw new ValidationError(`"chartVariant" must be one of: ${VALID_CHART_VARIANTS.join(', ')}`);
  }
}

function assertTimeBucket(timeBucket) {
  if (timeBucket !== undefined && !VALID_TIME_BUCKETS.includes(timeBucket)) {
    throw new ValidationError(`"timeBucket" must be one of: ${VALID_TIME_BUCKETS.join(', ')}`);
  }
}

function assertChartTypeCombination(chartType, chartVariant) {
  if (!chartType || !chartVariant) return;
  const key = `${chartType}:${chartVariant}`;
  if (INVALID_COMBINATIONS.has(key)) {
    throw new ValidationError(`Invalid combination: chartType="${chartType}" with chartVariant="${chartVariant}"`);
  }
}

function parseIntIds(raw, fieldName) {
  const r = validateIntArray(raw, fieldName);
  if (!r.valid) throw new ValidationError(r.error);
  return r.value;
}

function parseDateOrNull(value, fieldName) {
  // Distinguish "absent" (leave the stored value untouched) from "clear"
  // (write NULL). The edit modal sends null to clear a chart's date range; the
  // old code mapped null/'' to undefined, which the repository skips, so a
  // cleared range silently kept its old value.
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`Invalid date for "${fieldName}"`);
  return value;
}

router.get('/', async (req, res) => {
  const charts = await savedChartsRepository.getAll();
  res.ok(charts);
});

router.post('/', async (req, res) => {
  const { name, chartType, categoryIds, recipientIds, chartVariant, timeBucket, dateRangeStart, dateRangeEnd } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('Missing or invalid "name"');
  }

  const normalizedCategoryIds = parseIntIds(categoryIds, 'categoryIds');
  const normalizedRecipientIds = recipientIds !== undefined ? parseIntIds(recipientIds, 'recipientIds') : undefined;
  assertChartType(chartType);
  assertChartVariant(chartVariant);
  assertTimeBucket(timeBucket);

  const resolvedType = chartType || 'line';
  const resolvedVariant = chartVariant || 'default';
  assertChartTypeCombination(resolvedType, resolvedVariant);

  const chart = await savedChartsRepository.create({
    name: name.trim(),
    chartType: resolvedType,
    categoryIds: normalizedCategoryIds,
    recipientIds: normalizedRecipientIds,
    chartVariant: resolvedVariant,
    timeBucket: timeBucket || 'monthly',
    dateRangeStart: parseDateOrNull(dateRangeStart, 'dateRangeStart'),
    dateRangeEnd: parseDateOrNull(dateRangeEnd, 'dateRangeEnd'),
  });
  res.status(201);
  res.ok(chart);
});

router.patch('/:id', async (req, res) => {
  const id = parseChartId(req);
  const { name, chartType, chartVariant, timeBucket } = req.body;
  let { categoryIds, recipientIds, dateRangeStart, dateRangeEnd } = req.body;

  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    throw new ValidationError('Invalid "name"');
  }
  assertChartType(chartType);
  assertChartVariant(chartVariant);
  assertTimeBucket(timeBucket);
  assertChartTypeCombination(chartType, chartVariant);

  if (categoryIds !== undefined) categoryIds = parseIntIds(categoryIds, 'categoryIds');
  if (recipientIds !== undefined) recipientIds = parseIntIds(recipientIds, 'recipientIds');
  dateRangeStart = parseDateOrNull(dateRangeStart, 'dateRangeStart');
  dateRangeEnd = parseDateOrNull(dateRangeEnd, 'dateRangeEnd');

  const updated = await savedChartsRepository.update(id, {
    name: name?.trim(),
    chartType,
    categoryIds,
    recipientIds,
    chartVariant,
    timeBucket,
    dateRangeStart,
    dateRangeEnd,
  });
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
