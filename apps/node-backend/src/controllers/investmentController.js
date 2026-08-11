/**
 * Investment Controller
 *
 * Business logic for investment and portfolio transaction endpoints.
 * Routes in routes/investments.js delegate here; this module owns
 * response-shaping, orchestration, and in-memory caching.
 *
 * Emits unified response envelope (ADR-026) via res.ok(data). Typed
 * errors (ValidationError / NotFoundError / AppError) flow through
 * Express 5 async-throw to errorHandler.js for the {ok:false,...} shape.
 */

import { z } from 'zod';
import investmentRepository, { pickInvestmentCreateFields } from '../repositories/investmentRepository.js';
import portfolioTransactionRepository from '../repositories/portfolioTransactionRepository.js';
import { fetchHistoricalPrices, fetchLivePricesDetailed, SUPPORTED_PROVIDERS } from '../services/priceProviderService.js';
import { refreshQuotesForInvestment } from '../services/quoteBackfillService.js';
import { logger } from '../config/logger.js';
import { getKinesisAssetConfig } from '../config/kinesisConfig.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateNumber, assertMaxLength, assertCurrency } from '../middleware/validation.js';
import { invalidatePortfolioCaches } from '../services/info/cache.js';
import { assertPublicHttpUrl } from '../lib/urlSafety.js';
import { autoResolveFxRateToEur } from '../services/portfolio/fxResolve.js';
import { parsePagination, parseIntClamped } from '../lib/pagination.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 * @typedef {import('../types/rows.js').InvestmentRow} InvestmentRow
 * @typedef {import('../types/rows.js').PortfolioTransactionRow} PortfolioTransactionRow
 */

// Custom price-provider URLs are fetched server-side at refresh time, so reject
// non-public targets at the write boundary too (SSRF defense-in-depth). DNS is
// not resolved here — that would couple investment writes to DNS availability;
// the full DNS-resolved check runs at fetch time in priceProviderRegistry.
const PROVIDER_URL_FIELDS = ['price_provider_url', 'price_provider_latest_url', 'price_provider_history_url'];

/**
 * @param {Record<string, unknown>} body
 */
async function validateProviderUrls(body) {
  for (const field of PROVIDER_URL_FIELDS) {
    const value = body?.[field];
    if (value === undefined || value === null || value === '') continue;
    try {
      await assertPublicHttpUrl(/** @type {string} */ (value), { resolveDns: false });
    } catch (err) {
      throw new ValidationError(`Invalid ${field}: ${err.message}`);
    }
  }
}

/* ── Zod body schema ───────────────────────────────────────────────────────
 * Bodies are validated with zod (schema → safeParse → ValidationError), the
 * idiom established in settings.js/reports.js. The schema is LOOSE: fields
 * without a typed guard (notes, price_provider_*, ...) pass through untouched
 * and the repository allow-list decides what is written, exactly as before.
 * Bridges reuse the shared middleware guards so accepted shapes
 * (Number() coercion, bounds, widths) stay identical to the pre-zod behavior. */

// Numeric fields forwarded to typed columns. Bounds keep garbage out of the
// valuation and Belgian property-tax math: without them a non-numeric string
// surfaced as a pg cast error (500 instead of 400) while negatives, 1e15, and
// JSON "Infinity" inserted cleanly. Both rate fields are percentages in the UI.
// null passes through (explicit clear, null-to-clear PATCH semantics); a
// cleared '' form field means "no value", not 0 — and ''::numeric is a pg cast
// error (500) if forwarded raw.
/**
 * @param {string} field
 * @param {number} min
 * @param {number} max
 */
const boundedNumberField = (field, min, max) => z.unknown().transform((value, ctx) => {
  if (value === null || value === '') return null;
  const result = validateNumber(value, { min, max, fieldName: field });
  if (!result.valid) {
    ctx.addIssue({ code: 'custom', message: result.error });
    return z.NEVER;
  }
  return result.value;
}).optional();

// VARCHAR column widths (migration 0001). Provider-/market-prefilled values can
// exceed the frontend maxLength cap (which only clamps typed input) and reach
// the column as a raw 22001 500 instead of a clean 400. Values within the width
// pass through untouched (assertMaxLength never trims or stringifies).
/**
 * @param {string} field
 * @param {number} max
 */
const maxLenField = (field, max) => z.unknown().transform((value, ctx) => {
  try {
    return assertMaxLength(value, max, field);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err.message });
    return z.NEVER;
  }
}).optional();

// ISO-4217 shape guard: a free-typed "euro"/"€"/over-long currency otherwise
// reached the VARCHAR column as a raw 400/500. Absent/empty passes through
// untouched so the column default ('EUR') applies; a valid code is normalised
// to uppercase.
const currencyField = z.unknown().transform((value, ctx) => {
  if (value === null || value === '') return value;
  try {
    return assertCurrency(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err.message });
    return z.NEVER;
  }
}).optional();

const investmentBodySchema = z.looseObject({
  current_price: boundedNumberField('current_price', 0, 1e12),
  interest_rate: boundedNumberField('interest_rate', -100, 100),
  cadastral_income: boundedNumberField('cadastral_income', 0, 1e12),
  municipality_tax_rate: boundedNumberField('municipality_tax_rate', 0, 100),
  name: maxLenField('name', 200),
  symbol: maxLenField('symbol', 20),
  location: maxLenField('location', 300),
  municipality: maxLenField('municipality', 200),
  currency: currencyField,
  // Provider columns (migration 0001): URL shape is checked separately
  // (validateProviderUrls), but an over-length yet valid URL/path still
  // reached the VARCHAR column as a raw 22001 500.
  price_provider_id: maxLenField('price_provider_id', 200),
  price_provider_url: maxLenField('price_provider_url', 500),
  price_provider_latest_url: maxLenField('price_provider_latest_url', 500),
  price_provider_latest_path: maxLenField('price_provider_latest_path', 300),
  price_provider_history_url: maxLenField('price_provider_history_url', 500),
  price_provider_history_path: maxLenField('price_provider_history_path', 300),
  price_provider_history_ts_path: maxLenField('price_provider_history_ts_path', 300),
  price_provider_history_price_path: maxLenField('price_provider_history_price_path', 300),
});

/**
 * @param {unknown} body
 * @returns {any}
 */
function parseInvestmentBody(body) {
  // Non-object bodies skipped field validation pre-zod; keep that boundary.
  if (!body || typeof body !== 'object') return body;
  const result = investmentBodySchema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new ValidationError(msg);
  }
  return result.data;
}

// ── In-memory response caches ────────────────────────────────────────────────

const INVESTMENTS_CACHE_TTL_MS = 60_000;

/** @type {{ data: any, expiresAt: number }} */
let investmentsCache = { data: undefined, expiresAt: 0 };
/** @type {{ data: any, key: string, expiresAt: number }} */
let bulkTxnCache = { data: undefined, key: '', expiresAt: 0 };

export function clearInvestmentsCaches() {
  investmentsCache = { data: undefined, expiresAt: 0 };
  bulkTxnCache = { data: undefined, key: '', expiresAt: 0 };
  invalidatePortfolioCaches();
}

// ── Request parsers ──────────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @returns {number}
 */
function parseInteger(value) {
  return parseInt(/** @type {string} */ (value), 10);
}

/**
 * @param {ExpressRequest} req
 * @returns {number}
 */
export function parseRequestId(req) {
  return parseInteger(req.params.id);
}

/**
 * @param {ExpressRequest} req
 * @returns {number}
 */
export function parseTxnRequestId(req) {
  return parseInteger(req.params.txnId);
}

/**
 * @param {ExpressRequest} req
 * @returns {number}
 */
export function requireTxnId(req) {
  const txnId = parseTxnRequestId(req);
  if (isNaN(txnId) || txnId <= 0) {
    throw new ValidationError('Invalid transaction ID');
  }
  return txnId;
}

/**
 * Translate repository VALIDATION_ERROR into a typed ValidationError so the
 * envelope surfaces a clean 400. Unknown errors propagate unchanged.
 * @param {any} err arbitrary upstream error shape — a thrown repository
 *   error, possibly carrying a `code`, or anything else a repository call
 *   can reject with.
 * @returns {never}
 */
function translateRepoError(err) {
  if (err?.code === 'VALIDATION_ERROR') {
    throw new ValidationError(err.message);
  }
  throw err;
}

/**
 * @param {unknown} rawInvestmentIds
 * @returns {number[]}
 */
function parseInvestmentIdsQuery(rawInvestmentIds) {
  return String(rawInvestmentIds)
    .split(',')
    .map((value) => parseInteger(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function parseDbOnlyQueryValue(raw) {
  return raw === '1' || raw === 'true' || raw === 1 || raw === true;
}

/**
 * @param {unknown} raw
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function parseDbOnlyOrDefault(raw, defaultValue) {
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (raw === '0' || raw === 'false' || raw === 0 || raw === false) return false;
  return parseDbOnlyQueryValue(raw);
}

// Route limit/offset through the canonical parsePagination clamp (used by the
// other list routes) so limit is bounded to maxLimit, a falsy/absent limit falls
// back to the default, and offset can never go negative — instead of the
// hand-rolled arithmetic that left offset unclamped.
/**
 * @param {Record<string, unknown>} query
 * @returns {{ limit: number, offset: number, assetClass: string|null, active: boolean }}
 */
export function parseDefaultListOptions(query) {
  const { asset_class, active = 'true' } = query;
  const { limit, offset } = parsePagination(query, { defaultLimit: 200, maxLimit: 1000 });
  return {
    limit,
    offset,
    assetClass: /** @type {string|null} */ (asset_class || null),
    active: active !== 'false',
  };
}

// Per-route ceilings, unchanged from the hand-rolled clamps they replace.
const BULK_TRANSACTIONS_MAX_LIMIT = 200000;
const BULK_PER_INVESTMENT_MAX_LIMIT = 5000;
const INVESTMENT_TRANSACTIONS_MAX_LIMIT = 1000;

/**
 * @param {Record<string, unknown>} query
 * @param {number[]} investmentIds
 * @returns {{ investmentIds: number[], type: string|null, perInvestmentLimit: number, limit: number|null, offset: number }}
 */
function parseBulkTransactionsOptions(query, investmentIds) {
  const { type, per_investment_limit, limit } = query;
  // `limit` stays opt-in here (absent → null → no outer LIMIT), so this keeps
  // the presence check and only borrows parsePagination's clamp. defaultLimit
  // is 1 to preserve the previous `parseInteger(limit) || 1` fallback for
  // garbage/zero/negative values.
  const page = parsePagination(query, { defaultLimit: 1, maxLimit: BULK_TRANSACTIONS_MAX_LIMIT });
  return {
    investmentIds,
    type: /** @type {string|null} */ (type || null),
    perInvestmentLimit: parseIntClamped(per_investment_limit, {
      max: BULK_PER_INVESTMENT_MAX_LIMIT,
      fallback: 1000,
    }),
    limit: limit == null || limit === '' ? null : page.limit,
    offset: page.offset,
  };
}

/**
 * @param {Record<string, unknown>} query
 * @param {number} investmentId
 * @returns {{ investmentId: number, type: string|null, limit: number, offset: number }}
 */
function parseInvestmentTransactionsOptions(query, investmentId) {
  const { type } = query;
  const { limit, offset } = parsePagination(query, {
    defaultLimit: 200,
    maxLimit: INVESTMENT_TRANSACTIONS_MAX_LIMIT,
  });
  return {
    investmentId,
    type: /** @type {string|null} */ (type || null),
    limit,
    offset,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {InvestmentRow} investment
 * @returns {boolean}
 */
function hasLivePriceRefreshConfig(investment) {
  const provider = investment?.price_provider;
  if (!provider || provider === 'manual') return false;

  if (provider === 'custom') {
    return Boolean(
      investment?.price_provider_latest_url
      || investment?.price_provider_url
      || investment?.price_provider_history_url
    );
  }

  if (provider === 'yahoo') {
    return Boolean(investment?.price_provider_id || investment?.symbol);
  }

  if (provider === 'kinesis') {
    if (investment?.price_provider_id) return true;
    const assetName = (investment?.name || investment?.symbol || '').toLowerCase().trim();
    return Boolean(assetName && getKinesisAssetConfig(assetName));
  }

  return Boolean(investment?.price_provider_id);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function listInvestments(req, res) {
  const opts = parseDefaultListOptions(req.query);

  const isDefaultRequest = opts.limit >= 500 && !opts.assetClass && !opts.active && opts.offset === 0;
  if (isDefaultRequest && investmentsCache.data && investmentsCache.expiresAt > Date.now()) {
    return res.ok(investmentsCache.data);
  }

  const result = await investmentRepository.getAllWithCount(opts);
  const payload = {
    items: result.rows,
    total: result.total,
    limit: opts.limit,
    offset: opts.offset,
    /** @type {any[]} */
    links: [],
  };

  if (isDefaultRequest) {
    investmentsCache = { data: payload, expiresAt: Date.now() + INVESTMENTS_CACHE_TTL_MS };
  }

  res.ok(payload);
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function createInvestment(req, res) {
  const body = parseInvestmentBody(req.body);
  const { name, asset_class } = body;

  if (!name || !asset_class) {
    throw new ValidationError('name and asset_class are required');
  }

  await validateProviderUrls(body);

  let inv;
  try {
    inv = await investmentRepository.create(pickInvestmentCreateFields(body));
  } catch (err) {
    translateRepoError(err);
  }
  clearInvestmentsCaches();
  res.status(201);
  res.ok(inv);
}

/**
 * @param {ExpressRequest} _req
 * @param {ExpressResponse} res
 */
export function listProviders(_req, res) {
  res.ok({ providers: SUPPORTED_PROVIDERS });
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function refreshPrices(req, res) {
  const allInvestments = await investmentRepository.getAll({ limit: 1000, active: true });
  const toRefresh = allInvestments.filter(hasLivePriceRefreshConfig);

  if (toRefresh.length === 0) {
    return res.ok({ updated: 0, message: 'No investments with live price providers' });
  }

  const cachedPricesByInvestmentId = Object.fromEntries(
    toRefresh.map(i => [i.id, Number(i.current_price)])
  );
  const prices = await fetchLivePricesDetailed(toRefresh, { cachedPricesByInvestmentId });
  /** @type {Record<string, string>} */
  const priceSources = {};

  // Collect the fresh prices, then write them in ONE UNNEST-driven UPDATE —
  // the previous per-investment loop (bounded concurrency 10) still paid N
  // round trips per refresh.
  const refreshedAt = new Date().toISOString();
  const priceUpdates = [];
  for (const [investmentId, priceData] of Object.entries(prices)) {
    const { price, source } = priceData || {};
    if (price == null || isNaN(price)) continue;
    priceSources[investmentId] = source || 'live';
    if (source === 'cached' || source === 'historical_fallback') continue;
    priceUpdates.push({
      id: parseInt(investmentId, 10),
      current_price: price,
      price_updated_at: refreshedAt,
    });
  }
  const updated = await investmentRepository.updatePricesBulk(priceUpdates);
  logger.info(`Refreshed prices for ${updated}/${toRefresh.length} investments`);
  clearInvestmentsCaches();

  res.ok({
    updated,
    total: toRefresh.length,
    prices: Object.fromEntries(Object.entries(prices).map(([id, data]) => [id, data.price])),
    priceSources,
  });
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function getBulkTransactions(req, res) {
  const rawInvestmentIds = req.query.investment_ids;
  if (rawInvestmentIds == null || rawInvestmentIds === '') {
    throw new ValidationError('investment_ids is required');
  }

  const investmentIds = parseInvestmentIdsQuery(rawInvestmentIds);
  if (investmentIds.length === 0) {
    throw new ValidationError('investment_ids must include at least one valid id');
  }

  const opts = parseBulkTransactionsOptions(req.query, investmentIds);
  const cacheKey = `${investmentIds.join(',')}:${opts.type || ''}:${opts.perInvestmentLimit}:${opts.limit ?? ''}:${opts.offset}`;

  if (bulkTxnCache.key === cacheKey && bulkTxnCache.data && bulkTxnCache.expiresAt > Date.now()) {
    return res.ok(bulkTxnCache.data);
  }

  const [items, total] = await Promise.all([
    portfolioTransactionRepository.getAllByInvestmentIds(opts),
    portfolioTransactionRepository.getCount({ investmentIds: opts.investmentIds, type: opts.type }),
  ]);

  const payload = {
    items,
    total,
    limit: opts.limit ?? items.length,
    offset: opts.offset,
    /** @type {any[]} */
    links: [],
  };

  bulkTxnCache = { data: payload, key: cacheKey, expiresAt: Date.now() + INVESTMENTS_CACHE_TTL_MS };
  res.ok(payload);
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function getPriceHistory(req, res) {
  const investmentId = parseRequestId(req);
  const inv = await investmentRepository.getById(investmentId);
  if (!inv) throw new NotFoundError('Investment not found');

  const { from_ms: fromMs, to_ms: toMs, db_only: dbOnlyRaw } = req.query;
  const points = await fetchHistoricalPrices(inv, {
    fromMs: fromMs !== undefined ? Number(fromMs) : undefined,
    toMs: toMs !== undefined ? Number(toMs) : undefined,
    dbOnly: parseDbOnlyOrDefault(dbOnlyRaw, true),
  });

  res.ok({ investment_id: investmentId, provider: inv.price_provider, points });
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function getInvestment(req, res) {
  const inv = await investmentRepository.getById(parseRequestId(req));
  if (!inv) throw new NotFoundError('Investment not found');
  res.ok(inv);
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function updateInvestment(req, res) {
  const body = parseInvestmentBody(req.body);
  await validateProviderUrls(body);

  let inv;
  try {
    inv = await investmentRepository.update(parseRequestId(req), body);
  } catch (err) {
    translateRepoError(err);
  }
  if (!inv) throw new NotFoundError('Investment not found');
  clearInvestmentsCaches();
  res.ok(inv);
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function deleteInvestment(req, res) {
  const investmentId = parseRequestId(req);

  const ok = await investmentRepository.hardDelete(investmentId);
  if (!ok) throw new NotFoundError('Investment not found');

  clearInvestmentsCaches();
  res.status(204).send();
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function listTransactions(req, res) {
  const opts = parseInvestmentTransactionsOptions(req.query, parseRequestId(req));
  const result = await portfolioTransactionRepository.getAllWithCount(opts);
  res.ok({
    items: result.rows,
    total: result.total,
    limit: opts.limit,
    offset: opts.offset,
    /** @type {any[]} */
    links: [],
  });
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function createTransaction(req, res) {
  const investment_id = parseRequestId(req);
  const inv = await investmentRepository.getById(investment_id);
  if (!inv) throw new NotFoundError('Investment not found');

  const {
    type, date, amount, units, price_per_unit, fees, taxes,
    currency, note, is_recurring, recurrence_interval,
    recurrence_end_date, account_id,
  } = req.body;
  let { fx_rate_to_eur } = req.body;

  if (!type || !date) {
    throw new ValidationError('type and date are required');
  }

  // Validate a free-typed currency (ISO-4217 shape) before it reaches the
  // VARCHAR column — a "euro"/"€"/4-10-char value otherwise 500'd. Absent/empty
  // falls back to the investment's own currency.
  const effectiveCurrency = assertCurrency(currency) || inv.currency;
  if (fx_rate_to_eur === undefined || fx_rate_to_eur === null) {
    fx_rate_to_eur = await autoResolveFxRateToEur(effectiveCurrency, date);
  }

  let txn;
  try {
    txn = await portfolioTransactionRepository.create({
      investment_id, type, date, amount, units, price_per_unit, fees, taxes,
      currency: effectiveCurrency, note, is_recurring,
      recurrence_interval, recurrence_end_date, fx_rate_to_eur,
      account_id: account_id != null ? Number(account_id) : undefined,
      preloaded_asset_class: inv.asset_class,
    });
  } catch (err) {
    translateRepoError(err);
  }

  clearInvestmentsCaches();
  refreshQuotesForInvestment(investment_id).catch((err) => {
    logger.error('Transaction-triggered quote refresh failed', { investmentId: investment_id, error: err.message });
  });
  res.status(201);
  res.ok(txn);
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function deleteTransaction(req, res) {
  const txnId = requireTxnId(req);

  const existingTxn = await portfolioTransactionRepository.getById(txnId);
  if (!existingTxn) throw new NotFoundError('Portfolio transaction not found');

  const ok = await portfolioTransactionRepository.hardDelete(txnId);
  if (!ok) throw new NotFoundError('Portfolio transaction not found');

  clearInvestmentsCaches();
  refreshQuotesForInvestment(existingTxn.investment_id).catch((err) => {
    logger.error('Transaction-triggered quote refresh failed', { investmentId: existingTxn.investment_id, error: err.message });
  });
  res.status(204).send();
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function updateTransaction(req, res) {
  const txnId = requireTxnId(req);
  const fields = { ...(req.body || {}) };

  // Validate a free-typed currency (ISO shape, uppercased) before it reaches
  // the VARCHAR(10) column — create validates it, but PATCH forwarded the raw
  // value (garbage stored; >10 chars 22001'd). The column is NOT NULL, so an
  // explicit null/'' (clear) rejects instead of 500ing at the constraint.
  if (fields.currency !== undefined) {
    if (fields.currency === null || fields.currency === '') {
      throw new ValidationError('currency cannot be cleared');
    }
    fields.currency = assertCurrency(fields.currency);
  }

  // A date or currency change invalidates the stamped FX rate — recompute it
  // unless the client supplied one explicitly.
  if (
    fields.fx_rate_to_eur === undefined
    && (fields.date !== undefined || fields.currency !== undefined)
  ) {
    const existing = await portfolioTransactionRepository.getById(txnId);
    if (existing) {
      const effCurrency = fields.currency ?? existing.currency;
      const effDate = fields.date ?? existing.date;
      const rate = await autoResolveFxRateToEur(effCurrency, effDate);
      if (rate !== undefined) fields.fx_rate_to_eur = rate;
    }
  }

  let txn;
  try {
    txn = await portfolioTransactionRepository.update(txnId, fields);
  } catch (err) {
    translateRepoError(err);
  }
  if (!txn) throw new NotFoundError('Portfolio transaction not found');

  clearInvestmentsCaches();
  refreshQuotesForInvestment(txn.investment_id).catch((err) => {
    logger.error('Transaction-triggered quote refresh failed', { investmentId: txn.investment_id, error: err.message });
  });
  res.ok(txn);
}

/**
 * @param {ExpressRequest} req
 * @param {ExpressResponse} res
 */
export async function getInvestmentSummary(req, res) {
  const investmentId = parseRequestId(req);
  const summary = await portfolioTransactionRepository.getSummary(investmentId);
  res.ok({ investment_id: investmentId, breakdown: summary });
}
