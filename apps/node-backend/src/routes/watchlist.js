/**
 * Watchlist routes — CRUD for prospective investments.
 */

import { Router } from 'express';
import { watchlistRepository } from '../repositories/watchlistRepository.js';
import { logger } from '../config/logger.js';

const router = Router();

// GET /api/watchlist
router.get('/', async (req, res) => {
  try {
    const { limit = 50, offset = 0, asset_class } = req.query;
    const opts = { limit: parseInt(limit, 10), offset: parseInt(offset, 10), assetClass: asset_class || null };
    const [items, total] = await Promise.all([
      watchlistRepository.getAll(opts),
      watchlistRepository.getCount(opts),
    ]);
    res.json({ items, total, limit: opts.limit, offset: opts.offset });
  } catch (err) {
    logger.error('Failed to list watchlist', { error: err.message });
    res.status(500).json({ detail: 'Failed to list watchlist items' });
  }
});

// GET /api/watchlist/:id
router.get('/:id', async (req, res) => {
  try {
    const item = await watchlistRepository.getById(parseInt(req.params.id, 10));
    if (!item) return res.status(404).json({ detail: 'Watchlist item not found' });
    res.json(item);
  } catch (err) {
    logger.error('Failed to get watchlist item', { error: err.message });
    res.status(500).json({ detail: 'Failed to get watchlist item' });
  }
});

// POST /api/watchlist
router.post('/', async (req, res) => {
  try {
    const { name, symbol, asset_class, target_price, currency, notes, price_provider_id } = req.body;
    if (!name || !asset_class || target_price == null) {
      return res.status(400).json({ detail: 'name, asset_class, and target_price are required' });
    }
    const item = await watchlistRepository.create({ name, symbol, asset_class, target_price, currency, notes, price_provider_id });
    res.status(201).json(item);
  } catch (err) {
    logger.error('Failed to create watchlist item', { error: err.message });
    res.status(500).json({ detail: 'Failed to create watchlist item' });
  }
});

// PATCH /api/watchlist/:id
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = await watchlistRepository.update(id, req.body);
    if (!item) return res.status(404).json({ detail: 'Watchlist item not found' });
    res.json(item);
  } catch (err) {
    logger.error('Failed to update watchlist item', { error: err.message });
    res.status(500).json({ detail: 'Failed to update watchlist item' });
  }
});

// DELETE /api/watchlist/:id
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await watchlistRepository.delete(parseInt(req.params.id, 10));
    if (!deleted) return res.status(404).json({ detail: 'Watchlist item not found' });
    res.status(204).send();
  } catch (err) {
    logger.error('Failed to delete watchlist item', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete watchlist item' });
  }
});

export default router;
