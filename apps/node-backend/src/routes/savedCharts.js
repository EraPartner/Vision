/**
 * Saved Charts routes.
 */

import { Router } from 'express';
import savedChartsRepository from '../repositories/savedChartsRepository.js';
import { validateIntArray } from '../middleware/validation.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const router = Router();

const VALID_CHART_TYPES = ['line', 'bar', 'area'];

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

function parseCategoryIds(raw) {
  const r = validateIntArray(raw, 'categoryIds');
  if (!r.valid) throw new ValidationError(r.error);
  return r.value;
}

router.get('/', async (req, res) => {
  const charts = await savedChartsRepository.getAll();
  res.ok(charts);
});

router.post('/', async (req, res) => {
  const { name, chartType, categoryIds } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('Missing or invalid "name"');
  }
  const normalizedCategoryIds = parseCategoryIds(categoryIds);
  assertChartType(chartType);

  const chart = await savedChartsRepository.create({
    name: name.trim(),
    chartType: chartType || 'line',
    categoryIds: normalizedCategoryIds,
  });
  res.status(201);
  res.ok(chart);
});

router.patch('/:id', async (req, res) => {
  const id = parseChartId(req);
  const { name, chartType } = req.body;
  let { categoryIds } = req.body;

  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    throw new ValidationError('Invalid "name"');
  }
  assertChartType(chartType);
  if (categoryIds !== undefined) categoryIds = parseCategoryIds(categoryIds);

  const updated = await savedChartsRepository.update(id, {
    name: name?.trim(),
    chartType,
    categoryIds,
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
