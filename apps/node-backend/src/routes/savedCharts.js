/**
 * Saved Charts routes.
 *
 * GET    /api/saved-charts         — list all saved chart configs
 * POST   /api/saved-charts         — create a new saved chart config
 * PATCH  /api/saved-charts/:id     — update name/chartType/categoryIds
 * DELETE /api/saved-charts/:id     — delete a saved chart config
 */

import { Router } from 'express';
import savedChartsRepository from '../repositories/savedChartsRepository.js';
import { validateIntArray } from '../middleware/validation.js';
import { logger } from '../config/logger.js';

const router = Router();

function parseChartIdParam(req) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return { error: 'Invalid chart id' };
  }
  return { id };
}

function validateChartType(chartType, { required = false } = {}) {
  const validTypes = ['line', 'bar', 'area'];
  if ((required && !chartType) || (chartType !== undefined && !validTypes.includes(chartType))) {
    return `"chartType" must be one of: ${validTypes.join(', ')}`;
  }
  return null;
}

function validateCategoryIds(categoryIds) {
  const validated = validateIntArray(categoryIds, 'categoryIds');
  if (!validated.valid) {
    return { error: validated.error };
  }
  return { value: validated.value };
}

// GET /api/saved-charts
router.get('/', async (req, res) => {
  try {
    const charts = await savedChartsRepository.getAll();
    res.json(charts);
  } catch (err) {
    logger.error('Failed to fetch saved charts', { error: err.message });
    res.status(500).json({ detail: 'Failed to fetch saved charts' });
  }
});

// POST /api/saved-charts
router.post('/', async (req, res) => {
  try {
    const { name, chartType, categoryIds } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0)
      return res.status(400).json({ detail: 'Missing or invalid "name"' });
    // categoryIds must be an array of positive integers
    const categoryIdsResult = validateCategoryIds(categoryIds);
    if (categoryIdsResult.error) return res.status(400).json({ detail: categoryIdsResult.error });
    // use normalized numeric array
    const normalizedCategoryIds = categoryIdsResult.value;
    const chartTypeError = validateChartType(chartType);
    if (chartTypeError) return res.status(400).json({ detail: chartTypeError });

    const chart = await savedChartsRepository.create({
      name: name.trim(),
      chartType: chartType || 'line',
      categoryIds: normalizedCategoryIds,
    });
    res.status(201).json(chart);
  } catch (err) {
    logger.error('Failed to create saved chart', { error: err.message });
    res.status(500).json({ detail: 'Failed to create saved chart' });
  }
});

// PATCH /api/saved-charts/:id
router.patch('/:id', async (req, res) => {
  try {
    const parsedChartId = parseChartIdParam(req);
    if (parsedChartId.error) return res.status(400).json({ detail: parsedChartId.error });
    const { id } = parsedChartId;

    const { name, chartType } = req.body;
    let { categoryIds } = req.body;
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0))
      return res.status(400).json({ detail: 'Invalid "name"' });
    const chartTypeError = validateChartType(chartType);
    if (chartTypeError) return res.status(400).json({ detail: chartTypeError });
    // If provided, categoryIds must be an array of positive integers
    if (categoryIds !== undefined) {
      const categoryIdsResult = validateCategoryIds(categoryIds);
      if (categoryIdsResult.error) return res.status(400).json({ detail: categoryIdsResult.error });
      // replace with normalized array
      categoryIds = categoryIdsResult.value;
    }

    const updated = await savedChartsRepository.update(id, {
      name: name?.trim(),
      chartType,
      categoryIds,
    });
    if (!updated) return res.status(404).json({ detail: 'Saved chart not found' });
    res.json(updated);
  } catch (err) {
    logger.error('Failed to update saved chart', { error: err.message });
    res.status(500).json({ detail: 'Failed to update saved chart' });
  }
});

// DELETE /api/saved-charts/:id
router.delete('/:id', async (req, res) => {
  try {
    const parsedChartId = parseChartIdParam(req);
    if (parsedChartId.error) return res.status(400).json({ detail: parsedChartId.error });
    const { id } = parsedChartId;

    const deleted = await savedChartsRepository.delete(id);
    if (!deleted) return res.status(404).json({ detail: 'Saved chart not found' });
    res.status(204).send();
  } catch (err) {
    logger.error('Failed to delete saved chart', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete saved chart' });
  }
});

export default router;
