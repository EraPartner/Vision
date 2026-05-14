/**
 * Watchlist routes — CRUD for prospective investments.
 */

import { Router } from 'express';
// eslint-disable-next-line vision-local/no-repo-direct-from-route
import { watchlistRepository } from '../repositories/watchlistRepository.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam } from '../middleware/validation.js';

const router = Router();

function parseWatchlistLimit(limit) {
  const parsed = parseInt(limit, 10);
  return Math.min(Math.max(Number.isNaN(parsed) ? 50 : parsed, 1), 5000);
}

function parseWatchlistOffset(offset) {
  const parsed = parseInt(offset, 10);
  return Math.max(Number.isNaN(parsed) ? 0 : parsed, 0);
}

router.get('/', async (req, res) => {
  const { limit = 50, offset = 0, asset_class } = req.query;
  const opts = {
    limit: parseWatchlistLimit(limit),
    offset: parseWatchlistOffset(offset),
    assetClass: asset_class || null,
  };
  const result = await watchlistRepository.getAllWithCount(opts);
  res.ok({
    items: result.rows,
    total: result.total,
    limit: opts.limit,
    offset: opts.offset,
  });
});

router.get('/:id', validateIdParam, async (req, res) => {
  const item = await watchlistRepository.getById(parseInt(req.params.id, 10));
  if (!item) throw new NotFoundError('Watchlist item not found');
  res.ok(item);
});

router.post('/', async (req, res) => {
  const { name, symbol, asset_class, target_price, currency, notes, price_provider_id } = req.body;
  if (!name || !asset_class || target_price == null) {
    throw new ValidationError('name, asset_class, and target_price are required');
  }
  const item = await watchlistRepository.create({
    name, symbol, asset_class, target_price, currency, notes, price_provider_id,
  });
  res.status(201);
  res.ok(item);
});

router.patch('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = await watchlistRepository.update(id, req.body);
  if (!item) throw new NotFoundError('Watchlist item not found');
  res.ok(item);
});

router.delete('/:id', validateIdParam, async (req, res) => {
  const deleted = await watchlistRepository.delete(parseInt(req.params.id, 10));
  if (!deleted) throw new NotFoundError('Watchlist item not found');
  res.status(204).send();
});

export default router;
