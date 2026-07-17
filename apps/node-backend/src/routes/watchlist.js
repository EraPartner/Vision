/**
 * Watchlist routes — CRUD for prospective investments.
 */

import { Router } from 'express';
import { watchlistRepository } from '../services/watchlistService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam, validateNumber, assertMaxLength, assertCurrency } from '../middleware/validation.js';
import { parsePagination } from '../lib/pagination.js';

const router = Router();

const WATCHLIST_ASSET_CLASSES = new Set(['stock', 'etf', 'crypto', 'metals']);

// NUMERIC(18,6) price columns hold at most 12 integer digits — anything
// larger (or Infinity) previously surfaced as a DB overflow error → 500.
const MAX_PRICE = 999_999_999_999;

// Type-check the fields the repository forwards to typed columns; without
// this a string target_price surfaces as a DB error (500) instead of a 400.
// Presence requirements stay in the POST handler — PATCH allows partials.
// `context` distinguishes create from update: added_price is an add-time
// snapshot that is not PATCH-updatable (see below).
function validateWatchlistFields(body, { context = 'create' } = {}) {
  // An empty / whitespace-only name is not a valid item label. On PATCH `name`
  // is optional (partial update), so only reject it when actually provided;
  // this also closes the POST whitespace hole ('   ' is truthy so the POST
  // presence check let it through).
  if (body.name !== undefined) {
    if (body.name === null || String(body.name).trim() === '') {
      throw new ValidationError('name cannot be empty');
    }
  }
  // VARCHAR column widths (migration 0001): a provider-/market-prefilled value
  // can exceed the HTML maxLength cap (which only clamps typed input), reaching
  // the column as a raw 22001 500 instead of a clean 400.
  assertMaxLength(body.name, 200, 'name');
  assertMaxLength(body.symbol, 20, 'symbol');
  assertMaxLength(body.price_provider_id, 200, 'price_provider_id');
  if (body.target_price !== undefined && body.target_price !== null) {
    const result = validateNumber(body.target_price, { min: 0, max: MAX_PRICE, fieldName: 'target_price' });
    if (!result.valid) throw new ValidationError(result.error);
    // A 0 target is meaningless for the at-or-below alert check.
    if (result.value === 0) throw new ValidationError('target_price must be greater than 0');
    body.target_price = result.value;
  }
  // Snapshot of the live price when the item was added (ADR-097 backtest); optional.
  // It is captured once at creation and is NOT PATCH-updatable — the repository
  // update allow-list omits it, so validating it on PATCH was dead code that
  // silently accepted-then-dropped the value. Reject it explicitly on update so
  // the caller gets a 400 instead of a no-op.
  if (body.added_price !== undefined && body.added_price !== null) {
    if (context === 'update') {
      throw new ValidationError('added_price cannot be updated after creation');
    }
    const result = validateNumber(body.added_price, { min: 0, max: MAX_PRICE, fieldName: 'added_price' });
    if (!result.valid) throw new ValidationError(result.error);
    body.added_price = result.value;
  }
  if (body.asset_class !== undefined && !WATCHLIST_ASSET_CLASSES.has(body.asset_class)) {
    throw new ValidationError(
      `asset_class must be one of: ${[...WATCHLIST_ASSET_CLASSES].join(', ')}`
    );
  }
  if (body.currency !== undefined && body.currency !== null) {
    // Shared ISO-4217 guard — validates AND uppercases, so a lower-case 'usd'
    // can't be stored and then mismatch the uppercase codes every
    // FX/conversion path expects. '' still rejects (an explicit currency key
    // must carry a real code), matching the old inline regex.
    const c = assertCurrency(body.currency);
    if (c === undefined) throw new ValidationError('currency must be a 3-letter ISO code');
    body.currency = c;
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
  validateWatchlistFields(req.body, { context: 'update' });
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
