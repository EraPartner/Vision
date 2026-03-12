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
import { logger } from '../config/logger.js';

const router = Router();

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
    if (!Array.isArray(categoryIds))
      return res.status(400).json({ detail: '"categoryIds" must be an array' });
    const validTypes = ['line', 'bar', 'area'];
    if (chartType && !validTypes.includes(chartType))
      return res.status(400).json({ detail: `"chartType" must be one of: ${validTypes.join(', ')}` });

    const chart = await savedChartsRepository.create({
      name: name.trim(),
      chartType: chartType || 'line',
      categoryIds,
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
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ detail: 'Invalid chart id' });

    const { name, chartType, categoryIds } = req.body;
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0))
      return res.status(400).json({ detail: 'Invalid "name"' });
    const validTypes = ['line', 'bar', 'area'];
    if (chartType !== undefined && !validTypes.includes(chartType))
      return res.status(400).json({ detail: `"chartType" must be one of: ${validTypes.join(', ')}` });
    if (categoryIds !== undefined && !Array.isArray(categoryIds))
      return res.status(400).json({ detail: '"categoryIds" must be an array' });

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
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ detail: 'Invalid chart id' });

    const deleted = await savedChartsRepository.delete(id);
    if (!deleted) return res.status(404).json({ detail: 'Saved chart not found' });
    res.status(204).send();
  } catch (err) {
    logger.error('Failed to delete saved chart', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete saved chart' });
  }
});

export default router;
