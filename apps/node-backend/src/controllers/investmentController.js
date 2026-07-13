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

import investmentRepository from '../repositories/investmentRepository.js';
import portfolioTransactionRepository from '../repositories/portfolioTransactionRepository.js';
import { fetchHistoricalPrices, fetchLivePricesDetailed, SUPPORTED_PROVIDERS } from '../services/priceProviderService.js';
import { refreshQuotesForInvestment } from '../services/quoteBackfillService.js';
import { logger } from '../config/logger.js';
import { getKinesisAssetConfig } from '../config/kinesisConfig.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateNumber } from '../middleware/validation.js';
import { invalidatePortfolioCaches } from '../routes/info/_cache.js';
import { assertPublicHttpUrl } from '../lib/urlSafety.js';
import { autoResolveFxRateToEur } from '../services/portfolio/fxResolve.js';
import { createTradeCashLeg, deleteTradeCashLegs, deleteTradeCashLegsForTrades } from '../services/portfolio/tradeCashLegService.js';
import { moveHolding as moveHoldingSvc } from '../services/portfolio/moveHoldingService.js';

// Custom price-provider URLs are fetched server-side at refresh time, so reject
// non-public targets at the write boundary too (SSRF defense-in-depth). DNS is
// not resolved here — that would couple investment writes to DNS availability;
// the full DNS-resolved check runs at fetch time in priceProviderRegistry.
const PROVIDER_URL_FIELDS = ['price_provider_url', 'price_provider_latest_url', 'price_provider_history_url'];

async function validateProviderUrls(body) {
  for (const field of PROVIDER_URL_FIELDS) {
    const value = body?.[field];
    if (value === undefined || value === null || value === '') continue;
    try {
      await assertPublicHttpUrl(value, { resolveDns: false });
    } catch (err) {
      throw new ValidationError(`Invalid ${field}: ${err.message}`);
    }
  }
}

// Numeric investment fields forwarded to typed columns. Bounds keep garbage
// out of the valuation and Belgian property-tax math: without them a
// non-numeric string surfaced as a pg cast error (500 instead of 400) while
// negatives, 1e15, and JSON "Infinity" inserted cleanly. Both rate fields are
// percentages in the UI. Mirrors the routes/watchlist.js guards.
const INVESTMENT_NUMERIC_BOUNDS = [
  { field: 'current_price', min: 0, max: 1e12 },
  { field: 'interest_rate', min: -100, max: 100 },
  { field: 'cadastral_income', min: 0, max: 1e12 },
  { field: 'municipality_tax_rate', min: 0, max: 100 },
];

function validateInvestmentNumericFields(body) {
  if (!body || typeof body !== 'object') return;
  for (const { field, min, max } of INVESTMENT_NUMERIC_BOUNDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null) continue; // explicit clear (null-to-clear PATCH semantics)
    if (value === '') {
      // A cleared form field means "no value", not 0 — and ''::numeric is a pg
      // cast error (500) if forwarded raw.
      body[field] = null;
      continue;
    }
    const result = validateNumber(value, { min, max, fieldName: field });
    if (!result.valid) throw new ValidationError(result.error);
    body[field] = result.value;
  }
}

// ── In-memory response caches ────────────────────────────────────────────────

const INVESTMENTS_CACHE_TTL_MS = 60_000;

let investmentsCache = { data: undefined, expiresAt: 0 };
let bulkTxnCache = { data: undefined, key: '', expiresAt: 0 };

export function clearInvestmentsCaches() {
  investmentsCache = { data: undefined, expiresAt: 0 };
  bulkTxnCache = { data: undefined, key: '', expiresAt: 0 };
  invalidatePortfolioCaches();
}

// ── Request parsers ──────────────────────────────────────────────────────────

function parseInteger(value) {
  return parseInt(value, 10);
}

export function parseRequestId(req) {
  return parseInteger(req.params.id);
}

export function parseTxnRequestId(req) {
  return parseInteger(req.params.txnId);
}

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
 */
function translateRepoError(err) {
  if (err?.code === 'VALIDATION_ERROR') {
    throw new ValidationError(err.message);
  }
  throw err;
}

function parseInvestmentIdsQuery(rawInvestmentIds) {
  return String(rawInvestmentIds)
    .split(',')
    .map((value) => parseInteger(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function parseDbOnlyQueryValue(raw) {
  return raw === '1' || raw === 'true' || raw === 1 || raw === true;
}

function parseDbOnlyOrDefault(raw, defaultValue) {
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (raw === '0' || raw === 'false' || raw === 0 || raw === false) return false;
  return parseDbOnlyQueryValue(raw);
}

function parseDefaultListOptions(query) {
  const { limit = 200, offset = 0, asset_class, active = 'true' } = query;
  return {
    limit: Math.min(parseInteger(limit) || 200, 1000),
    offset: parseInteger(offset) || 0,
    assetClass: asset_class || null,
    active: active !== 'false',
  };
}

function parseBulkTransactionsOptions(query, investmentIds) {
  const { type, per_investment_limit = 1000, limit, offset = 0 } = query;
  return {
    investmentIds,
    type: type || null,
    perInvestmentLimit: Math.max(1, Math.min(parseInteger(per_investment_limit) || 1000, 5000)),
    limit: limit == null || limit === ''
      ? null
      : Math.max(1, Math.min(parseInteger(limit) || 1, 200000)),
    offset: Math.max(0, parseInteger(offset) || 0),
  };
}

function parseInvestmentTransactionsOptions(query, investmentId) {
  const { type, limit = 200, offset = 0 } = query;
  return {
    investmentId,
    type: type || null,
    limit: Math.min(parseInteger(limit) || 200, 1000),
    offset: parseInteger(offset) || 0,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    links: [],
  };

  if (isDefaultRequest) {
    investmentsCache = { data: payload, expiresAt: Date.now() + INVESTMENTS_CACHE_TTL_MS };
  }

  res.ok(payload);
}

export async function createInvestment(req, res) {
  validateInvestmentNumericFields(req.body);
  const {
    name,
    symbol,
    asset_class,
    currency,
    current_price,
    interest_rate,
    maturity_date,
    location,
    municipality,
    cadastral_income,
    municipality_tax_rate,
    notes,
    price_provider,
    price_provider_id,
    price_provider_url,
    price_provider_latest_url,
    price_provider_latest_path,
    price_provider_history_url,
    price_provider_history_path,
    price_provider_history_ts_path,
    price_provider_history_price_path,
  } = req.body;

  if (!name || !asset_class) {
    throw new ValidationError('name and asset_class are required');
  }

  await validateProviderUrls(req.body);

  let inv;
  try {
    inv = await investmentRepository.create({
      name, symbol, asset_class, currency, current_price, interest_rate,
      maturity_date, location, municipality, cadastral_income,
      municipality_tax_rate, notes, price_provider, price_provider_id,
      price_provider_url, price_provider_latest_url, price_provider_latest_path,
      price_provider_history_url, price_provider_history_path,
      price_provider_history_ts_path, price_provider_history_price_path,
    });
  } catch (err) {
    translateRepoError(err);
  }
  clearInvestmentsCaches();
  res.status(201);
  res.ok(inv);
}

export function listProviders(_req, res) {
  res.ok({ providers: SUPPORTED_PROVIDERS });
}

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
    links: [],
  };

  bulkTxnCache = { data: payload, key: cacheKey, expiresAt: Date.now() + INVESTMENTS_CACHE_TTL_MS };
  res.ok(payload);
}

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

export async function getInvestment(req, res) {
  const inv = await investmentRepository.getById(parseRequestId(req));
  if (!inv) throw new NotFoundError('Investment not found');
  res.ok(inv);
}

export async function updateInvestment(req, res) {
  validateInvestmentNumericFields(req.body);
  await validateProviderUrls(req.body);

  let inv;
  try {
    inv = await investmentRepository.update(parseRequestId(req), req.body);
  } catch (err) {
    translateRepoError(err);
  }
  if (!inv) throw new NotFoundError('Investment not found');
  clearInvestmentsCaches();
  res.ok(inv);
}

export async function deleteInvestment(req, res) {
  const investmentId = parseRequestId(req);

  // Capture trade ids before the delete: the schema cascade removes the trades
  // themselves, but their cash legs hang off portfolio_transaction_id, which is
  // not a real FK (ADR-090) — cascade app-side, like deleteTransaction below.
  const tradeIds = await portfolioTransactionRepository.getIdsByInvestment(investmentId);

  const ok = await investmentRepository.hardDelete(investmentId);
  if (!ok) throw new NotFoundError('Investment not found');

  await deleteTradeCashLegsForTrades(tradeIds).catch((err) => {
    logger.error('Trade cash-leg cleanup failed', { investmentId, error: err.message });
  });

  clearInvestmentsCaches();
  res.status(204).send();
}

export async function listTransactions(req, res) {
  const opts = parseInvestmentTransactionsOptions(req.query, parseRequestId(req));
  const result = await portfolioTransactionRepository.getAllWithCount(opts);
  res.ok({
    items: result.rows,
    total: result.total,
    limit: opts.limit,
    offset: opts.offset,
    links: [],
  });
}

export async function createTransaction(req, res) {
  const investment_id = parseRequestId(req);
  const inv = await investmentRepository.getById(investment_id);
  if (!inv) throw new NotFoundError('Investment not found');

  const {
    type, date, amount, units, price_per_unit, fees, taxes,
    currency, note, is_recurring, recurrence_interval,
    recurrence_end_date, account_id, cash_account_id,
  } = req.body;
  let { fx_rate_to_eur } = req.body;

  if (!type || !date) {
    throw new ValidationError('type and date are required');
  }

  const effectiveCurrency = currency || inv.currency;
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

  // Trades = transfers (ADR-090): when a cash account is designated, post the
  // paired cash leg on its sleeve. NOTE: not yet in one DB transaction with the
  // trade insert — a leg failure leaves the trade without its leg (follow-up:
  // thread a shared client through the repo create path).
  if (txn && cash_account_id != null) {
    try {
      await createTradeCashLeg({ portfolioTxn: txn, cashAccountId: Number(cash_account_id) });
    } catch (err) {
      logger.error('Trade cash-leg creation failed', { txnId: txn.id, error: err.message });
      throw err;
    }
  }

  clearInvestmentsCaches();
  refreshQuotesForInvestment(investment_id).catch((err) => {
    logger.error('Transaction-triggered quote refresh failed', { investmentId: investment_id, error: err.message });
  });
  res.status(201);
  res.ok(txn);
}

export async function moveHolding(req, res) {
  const investmentId = parseRequestId(req);
  const inv = await investmentRepository.getById(investmentId);
  if (!inv) throw new NotFoundError('Investment not found');

  const { from_account_id, to_account_id, units, strategy } = req.body || {};
  const result = await moveHoldingSvc({
    investmentId,
    fromAccountId: from_account_id != null ? Number(from_account_id) : NaN,
    toAccountId: to_account_id != null ? Number(to_account_id) : NaN,
    units: units != null ? Number(units) : null,
    strategy: strategy === 'fifo' || strategy === 'proportional' ? strategy : undefined,
  });
  clearInvestmentsCaches();
  res.ok(result);
}

export async function deleteTransaction(req, res) {
  const txnId = requireTxnId(req);

  const existingTxn = await portfolioTransactionRepository.getById(txnId);
  if (!existingTxn) throw new NotFoundError('Portfolio transaction not found');

  const ok = await portfolioTransactionRepository.hardDelete(txnId);
  if (!ok) throw new NotFoundError('Portfolio transaction not found');

  // App-side cascade for the trade cash leg (ADR-090): portfolio_transaction_id is not a FK
  // (inheritance/view schema), so remove any linked cash legs here.
  await deleteTradeCashLegs(txnId).catch((err) => {
    logger.error('Trade cash-leg cleanup failed', { txnId, error: err.message });
  });

  clearInvestmentsCaches();
  refreshQuotesForInvestment(existingTxn.investment_id).catch((err) => {
    logger.error('Transaction-triggered quote refresh failed', { investmentId: existingTxn.investment_id, error: err.message });
  });
  res.status(204).send();
}

export async function updateTransaction(req, res) {
  const txnId = requireTxnId(req);
  const fields = { ...(req.body || {}) };

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

export async function getInvestmentSummary(req, res) {
  const investmentId = parseRequestId(req);
  const summary = await portfolioTransactionRepository.getSummary(investmentId);
  res.ok({ investment_id: investmentId, breakdown: summary });
}
