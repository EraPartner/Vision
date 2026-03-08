/**
 * Category routes.
 *
 * Mirrors: apps/backend/api/api_routes_categories.py
 */

import { Router } from 'express';
import categoryRepository from '../repositories/categoryRepository.js';
import { logger } from '../config/logger.js';
import { validateIdParam, sanitizeString } from '../middleware/validation.js';

const router = Router();

// GET /api/categories
router.get('/', async (req, res) => {
  try {
    const { limit = 50, offset = 0, general, detail, active = 'true' } = req.query;

    const opts = {
      limit: Math.min(parseInt(limit, 10) || 50, 1000),
      offset: parseInt(offset, 10) || 0,
      general: general || null,
      detail: detail || null,
      active: active !== 'false',
    };

    const items = await categoryRepository.getAll(opts);
    const total = await categoryRepository.getCount(opts);

    res.json({
      items: items.map(c => ({ ...c, links: [] })),
      total,
      limit: opts.limit,
      offset: opts.offset,
      links: [],
    });
  } catch (err) {
    logger.error('Error retrieving categories', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve categories' });
  }
});

// POST /api/categories (create or get)
router.post('/', async (req, res) => {
  try {
    const { general, detail, description } = req.body;
    if (!general || !detail) {
      return res.status(400).json({ detail: 'Missing required fields: general, detail' });
    }

    const { category, created } = await categoryRepository.createOrGet({ general, detail, description });
    res.status(created ? 201 : 200).json({ ...category, links: [] });
  } catch (err) {
    logger.error('Error creating category', { error: err.message });
    res.status(500).json({ detail: 'Failed to create category' });
  }
});

// GET /api/categories/:id
router.get('/:id', validateIdParam, async (req, res) => {
  try {
    const category = await categoryRepository.getById(parseInt(req.params.id, 10));
    if (!category) {
      return res.status(404).json({ detail: `Category ${req.params.id} not found` });
    }
    res.json({ ...category, links: [] });
  } catch (err) {
    logger.error('Error retrieving category', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve category' });
  }
});

// PATCH /api/categories/:id
router.patch('/:id', validateIdParam, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const updated = await categoryRepository.update(id, req.body);
    if (!updated) {
      return res.status(404).json({ detail: `Category ${id} not found` });
    }
    res.json({ ...updated, links: [] });
  } catch (err) {
    logger.error('Error updating category', { error: err.message });
    res.status(500).json({ detail: 'Failed to update category' });
  }
});

// DELETE /api/categories/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = await categoryRepository.hardDelete(id);
    if (!deleted) {
      return res.status(404).json({ detail: `Category ${id} not found` });
    }
    res.json({ message: `Category ${id} deleted permanently`, links: [] });
  } catch (err) {
    logger.error('Error deleting category', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete category' });
  }
});

// POST /api/categories/:id/assign
router.post('/:id/assign', validateIdParam, async (req, res) => {
  try {
    const categoryId = parseInt(req.params.id, 10);
    let { recipient_ids } = req.body;
    if (!recipient_ids) {
      return res.status(400).json({ detail: 'Missing recipient_ids' });
    }
    if (!Array.isArray(recipient_ids)) recipient_ids = [recipient_ids];

    const updated = await categoryRepository.assignToRecipients(categoryId, recipient_ids);
    res.json({ updated_recipients: updated, links: [] });
  } catch (err) {
    logger.error('Error assigning category', { error: err.message });
    res.status(500).json({ detail: 'Failed to assign category' });
  }
});

export default router;
