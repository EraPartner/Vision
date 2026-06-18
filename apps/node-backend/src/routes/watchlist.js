/**
 * Watchlist routes — CRUD for prospective investments.
 */

import { Router } from 'express';
import { watchlistRepository } from '../services/watchlistService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam, validateNumber } from '../middleware/validation.js';
import { parsePagination } from '../lib/pagination.js';

const router = Router();

const WATCHLIST_ASSET_CLASSES = new Set(['stock', 'etf', 'crypto', 'metals']);
const CURRENCY_RE = /^[A-Za-z]{3}$/;

// Type-check the fields the repository forwards to typed columns; without
// this a string target_price surfaces as a DB error (500) instead of a 400.
// Presence requirements stay in the POST handler — PATCH allows partials.
function validateWatchlistFields(body) {
  if (body.target_price !== undefined && body.target_price !== null) {
    const result = validateNumber(body.target_price, { min: 0, fieldName: 'target_price' });
    if (!result.valid) throw new ValidationError(result.error);
    body.target_price = result.value;
  }
  // Snapshot of the live price when the item was added (ADR-097 backtest); optional.
  if (body.added_price !== undefined && body.added_price !== null) {
    const result = validateNumber(body.added_price, { min: 0, fieldName: 'added_price' });
    if (!result.valid) throw new ValidationError(result.error);
    body.added_price = result.value;
  }
  if (body.asset_class !== undefined && !WATCHLIST_ASSET_CLASSES.has(body.asset_class)) {
    throw new ValidationError(
      `asset_class must be one of: ${[...WATCHLIST_ASSET_CLASSES].join(', ')}`
    );
  }
  if (body.currency !== undefined && body.currency !== null && !CURRENCY_RE.test(String(body.currency))) {
    throw new ValidationError('currency must be a 3-letter code');
  }
}

router.get('/', async (req, res) => {
  const { asset_class } = req.query;
  const { limit, offset } = parsePagination(req.query, { maxLimit: 5000 });
  const opts = {
    limit,
    offset,
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
  if (!req.body.name || !req.body.asset_class || req.body.target_price == null) {
    throw new ValidationError('name, asset_class, and target_price are required');
  }
  // Coerces target_price in place — destructure only after validation.
  validateWatchlistFields(req.body);
  const { name, symbol, asset_class, target_price, currency, notes, price_provider_id, added_price } = req.body;
  const item = await watchlistRepository.create({
    name, symbol, asset_class, target_price, currency, notes, price_provider_id, added_price,
  });
  res.status(201);
  res.ok(item);
});

router.patch('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  validateWatchlistFields(req.body);
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
