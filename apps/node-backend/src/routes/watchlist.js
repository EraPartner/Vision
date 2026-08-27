/**
 * Watchlist routes — CRUD for prospective investments.
 *
 * Bodies are validated with zod (schema → safeParse → ValidationError), the
 * idiom established in settings.js/reports.js. The schemas are LOOSE: fields
 * without a typed column (notes, ...) pass through untouched and the
 * repository allow-list decides what is written, exactly as before.
 */

import { Router } from 'express';
import { z } from 'zod';
import { watchlistRepository } from '../services/watchlistService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam, validateNumber, assertMaxLength, assertCurrency, assertIdParam } from '../middleware/validation.js';
import { parsePagination } from '../lib/pagination.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

const WATCHLIST_ASSET_CLASSES = ['stock', 'etf', 'crypto', 'metals'];

// NUMERIC(18,6) price columns hold at most 12 integer digits — anything
// larger (or Infinity) previously surfaced as a DB overflow error → 500.
const MAX_PRICE = 999_999_999_999;

/* ── Zod schemas ───────────────────────────────────────────────────────────
 * The fields the repository forwards to typed columns; without these a string
 * target_price surfaces as a DB error (500) instead of a 400. Presence
 * requirements stay in the POST handler — PATCH allows partials. Bridges reuse
 * the shared middleware guards so accepted shapes (String()/Number() coercion,
 * bounds, widths) stay identical to the pre-zod behavior. */

// An empty / whitespace-only name is not a valid item label; VARCHAR(200)
// (migration 0001) caps the width before the column raises a raw 22001 500.
const nameField = z.unknown().transform((value, ctx) => {
  if (value === null || String(value).trim() === '') {
    ctx.addIssue({ code: 'custom', message: 'name cannot be empty' });
    return z.NEVER;
  }
  try {
    // assertMaxLength's declared return is `unknown` (it's a generic
    // length guard shared by many field shapes) but this branch already
    // rejected null/empty above, so the surviving value is the caller-
    // supplied name as-is — narrowed here for watchlistRepository.create's
    // `name: string` param, matching the repository's contract, not a
    // runtime coercion.
    return /** @type {string} */ (assertMaxLength(value, 200, 'name'));
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err.message });
    return z.NEVER;
  }
}).optional();

// VARCHAR column widths: a provider-/market-prefilled value can exceed the
// HTML maxLength cap (which only clamps typed input).
/**
 * @param {number} maxLength
 * @param {string} field
 */
const maxLenField = (maxLength, field) => z.unknown().transform((value, ctx) => {
  try {
    // Same narrowing rationale as nameField above; assertMaxLength passes
    // null/undefined through unchanged, matching watchlistRepository's
    // `string|null` field shapes for symbol/price_provider_id.
    return /** @type {string|null|undefined} */ (assertMaxLength(value, maxLength, field));
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err.message });
    return z.NEVER;
  }
}).optional();

// Numeric prices: Number() coercion + [0, MAX_PRICE] bounds via the shared
// validateNumber guard; the coerced number replaces the raw input. null passes
// through (explicit clear), undefined is absent.
/**
 * @param {string} field
 * @param {{ rejectZero?: boolean }} [opts]
 */
const priceField = (field, { rejectZero = false } = {}) => z.unknown().transform((value, ctx) => {
  if (value === null) return null;
  const result = validateNumber(value, { min: 0, max: MAX_PRICE, fieldName: field });
  if (!result.valid) {
    ctx.addIssue({ code: 'custom', message: result.error });
    return z.NEVER;
  }
  // A 0 target is meaningless for the at-or-below alert check.
  if (rejectZero && result.value === 0) {
    ctx.addIssue({ code: 'custom', message: `${field} must be greater than 0` });
    return z.NEVER;
  }
  return result.value;
}).optional();

// Shared ISO-4217 guard — validates AND uppercases, so a lower-case 'usd'
// can't be stored and then mismatch the uppercase codes every FX/conversion
// path expects. '' still rejects (an explicit currency key must carry a real
// code); null passes through untouched, as before.
const currencyField = z.unknown().transform((value, ctx) => {
  if (value === null) return null;
  let code;
  try {
    code = assertCurrency(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err.message });
    return z.NEVER;
  }
  if (code === undefined) {
    ctx.addIssue({ code: 'custom', message: 'currency must be a 3-letter ISO code' });
    return z.NEVER;
  }
  return code;
}).optional();

const watchlistCreateSchema = z.looseObject({
  name: nameField,
  symbol: maxLenField(20, 'symbol'),
  price_provider_id: maxLenField(200, 'price_provider_id'),
  target_price: priceField('target_price', { rejectZero: true }),
  // Snapshot of the live price when the item was added (ADR-097 backtest); optional.
  added_price: priceField('added_price'),
  asset_class: z.enum(WATCHLIST_ASSET_CLASSES, {
    error: `asset_class must be one of: ${WATCHLIST_ASSET_CLASSES.join(', ')}`,
  }).optional(),
  currency: currencyField,
  // No dedicated width/shape rule (free text) — listed explicitly only so its
  // output type matches watchlistRepository.create's `notes?: string|null`
  // param; `z.looseObject` would otherwise pass it through as `unknown`.
  notes: z.unknown().transform((value) => /** @type {string|null|undefined} */ (value)).optional(),
});

// Partial-update variant: same field rules, except added_price is captured
// once at creation and is NOT PATCH-updatable — the repository update
// allow-list omits it, so accepting it here silently dropped the value.
// Reject it explicitly so the caller gets a 400 instead of a no-op.
const watchlistUpdateSchema = watchlistCreateSchema.extend({
  added_price: z.unknown().superRefine((value, ctx) => {
    if (value != null) {
      ctx.addIssue({ code: 'custom', message: 'added_price cannot be updated after creation' });
    }
  }).optional(),
});

/**
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} body
 * @returns {T}
 */
function parseWatchlistBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new ValidationError(msg);
  }
  return result.data;
}

router.get('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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

router.get('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const item = await watchlistRepository.getById(assertIdParam(req));
  if (!item) throw new NotFoundError('Watchlist item not found');
  res.ok(item);
});

router.post('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  if (!req.body.name || !req.body.asset_class || req.body.target_price == null) {
    throw new ValidationError('name, asset_class, and target_price are required');
  }
  const data = parseWatchlistBody(watchlistCreateSchema, req.body);
  const { name, symbol, asset_class, target_price, currency, notes, price_provider_id, added_price } = data;
  const item = await watchlistRepository.create({
    name, symbol, asset_class, target_price, currency, notes, price_provider_id, added_price,
  });
  res.status(201);
  res.ok(item);
});

router.patch('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = assertIdParam(req);
  const data = parseWatchlistBody(watchlistUpdateSchema, req.body);
  const item = await watchlistRepository.update(id, data);
  if (!item) throw new NotFoundError('Watchlist item not found');
  res.ok(item);
});

router.delete('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const deleted = await watchlistRepository.delete(assertIdParam(req));
  if (!deleted) throw new NotFoundError('Watchlist item not found');
  res.status(204).send();
});

export default router;
