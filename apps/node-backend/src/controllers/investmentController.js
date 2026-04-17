/**
 * Investment Controller
 *
 * Business logic for investment and portfolio transaction endpoints.
 * Routes in routes/investments.js delegate here; this module owns
 * response-shaping, orchestration, and in-memory caching.
 */

import investmentRepository from '../repositories/investmentRepository.js';
import portfolioTransactionRepository from '../repositories/portfolioTransactionRepository.js';
import { fetchHistoricalPrices, fetchLivePricesDetailed, SUPPORTED_PROVIDERS } from '../services/priceProviderService.js';
import { refreshQuotesForInvestment } from '../services/quoteBackfillService.js';
import { logger } from '../config/logger.js';
import { getKinesisAssetConfig } from '../config/kinesisConfig.js';

// ── In-memory response caches ────────────────────────────────────────────────

const INVESTMENTS_CACHE_TTL_MS = 60_000;
const REFRESH_PRICE_CONCURRENCY = 10;

let investmentsCache = { data: undefined, expiresAt: 0 };
let bulkTxnCache = { data: undefined, key: '', expiresAt: 0 };

export function clearInvestmentsCaches() {
  investmentsCache = { data: undefined, expiresAt: 0 };
  bulkTxnCache = { data: undefined, key: '', expiresAt: 0 };
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

export function parseAndValidateTxnRequestId(req, res) {
  const txnId = parseTxnRequestId(req);
  if (isNaN(txnId) || txnId <= 0) {
    res.status(400).json({ detail: 'Invalid transaction ID' });
    return undefined;
  }
  return txnId;
}

export function handleValidationError(res, err) {
  if (err?.code !== 'VALIDATION_ERROR') return false;
  res.status(400).json({ detail: err.message });
  return true;
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

async function processInBatches(items, batchSize, worker) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const chunk = items.slice(index, index + batchSize);
    const chunkResults = await Promise.all(chunk.map(worker));
    results.push(...chunkResults);
  }
  return results;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function listInvestments(req, res) {
  try {
    const opts = parseDefaultListOptions(req.query);

    const isDefaultRequest = opts.limit >= 500 && !opts.assetClass && !opts.active && opts.offset === 0;
    if (isDefaultRequest && investmentsCache.data && investmentsCache.expiresAt > Date.now()) {
      return res.json(investmentsCache.data);
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

    res.json(payload);
  } catch (err) {
    logger.error('Failed to get investments', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investments' });
  }
}

export async function createInvestment(req, res) {
  try {
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
      return res.status(400).json({ detail: 'name and asset_class are required' });
    }

    const inv = await investmentRepository.create({
      name, symbol, asset_class, currency, current_price, interest_rate,
      maturity_date, location, municipality, cadastral_income,
      municipality_tax_rate, notes, price_provider, price_provider_id,
      price_provider_url, price_provider_latest_url, price_provider_latest_path,
      price_provider_history_url, price_provider_history_path,
      price_provider_history_ts_path, price_provider_history_price_path,
    });
    clearInvestmentsCaches();
    res.status(201).json(inv);
  } catch (err) {
    logger.error('Failed to create investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to create investment' });
  }
}

export function listProviders(_req, res) {
  res.json({ providers: SUPPORTED_PROVIDERS });
}

export async function refreshPrices(req, res) {
  try {
    const allInvestments = await investmentRepository.getAll({ limit: 1000, active: true });
    const toRefresh = allInvestments.filter(hasLivePriceRefreshConfig);

    if (toRefresh.length === 0) {
      return res.json({ updated: 0, message: 'No investments with live price providers' });
    }

    const cachedPricesByInvestmentId = Object.fromEntries(
      toRefresh.map(i => [i.id, Number(i.current_price)])
    );
    const prices = await fetchLivePricesDetailed(toRefresh, { cachedPricesByInvestmentId });
    const priceSources = {};

    const priceEntries = Object.entries(prices);
    const updateResults = await processInBatches(
      priceEntries,
      REFRESH_PRICE_CONCURRENCY,
      async ([investmentId, priceData]) => {
        const { price, source } = priceData || {};
        if (price != null && !isNaN(price)) {
          priceSources[investmentId] = source || 'live';
          if (source === 'cached') return 0;
          await investmentRepository.updatePrice(parseInt(investmentId, 10), {
            current_price: price,
            price_updated_at: new Date().toISOString(),
          });
          return 1;
        }
        return 0;
      }
    );

    const updated = updateResults.reduce((sum, n) => sum + n, 0);
    logger.info(`Refreshed prices for ${updated}/${toRefresh.length} investments`);
    clearInvestmentsCaches();

    res.json({
      updated,
      total: toRefresh.length,
      prices: Object.fromEntries(Object.entries(prices).map(([id, data]) => [id, data.price])),
      priceSources,
    });
  } catch (err) {
    logger.error('Failed to refresh prices', { error: err.message });
    res.status(500).json({ detail: 'Failed to refresh investment prices' });
  }
}

export async function getBulkTransactions(req, res) {
  try {
    const rawInvestmentIds = req.query.investment_ids;
    if (rawInvestmentIds == null || rawInvestmentIds === '') {
      return res.status(400).json({ detail: 'investment_ids is required' });
    }

    const investmentIds = parseInvestmentIdsQuery(rawInvestmentIds);
    if (investmentIds.length === 0) {
      return res.status(400).json({ detail: 'investment_ids must include at least one valid id' });
    }

    const opts = parseBulkTransactionsOptions(req.query, investmentIds);
    const cacheKey = `${investmentIds.join(',')}:${opts.type || ''}:${opts.perInvestmentLimit}:${opts.limit ?? ''}:${opts.offset}`;

    if (bulkTxnCache.key === cacheKey && bulkTxnCache.data && bulkTxnCache.expiresAt > Date.now()) {
      return res.json(bulkTxnCache.data);
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
    res.json(payload);
  } catch (err) {
    logger.error('Failed to get bulk portfolio transactions', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve portfolio transactions' });
  }
}

export async function getPriceHistory(req, res) {
  try {
    const investmentId = parseRequestId(req);
    const inv = await investmentRepository.getById(investmentId);
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });

    const { from_ms: fromMs, to_ms: toMs, db_only: dbOnlyRaw } = req.query;
    const points = await fetchHistoricalPrices(inv, {
      fromMs: fromMs !== undefined ? Number(fromMs) : undefined,
      toMs: toMs !== undefined ? Number(toMs) : undefined,
      dbOnly: parseDbOnlyQueryValue(dbOnlyRaw),
    });

    res.json({ investment_id: investmentId, provider: inv.price_provider, points });
  } catch (err) {
    logger.error('Failed to get investment price history', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investment price history' });
  }
}

export async function getInvestment(req, res) {
  try {
    const inv = await investmentRepository.getById(parseRequestId(req));
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });
    res.json(inv);
  } catch (err) {
    logger.error('Failed to get investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investment' });
  }
}

export async function updateInvestment(req, res) {
  try {
    const inv = await investmentRepository.update(parseRequestId(req), req.body);
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });
    clearInvestmentsCaches();
    res.json(inv);
  } catch (err) {
    if (handleValidationError(res, err)) return;
    logger.error('Failed to update investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to update investment' });
  }
}

export async function deleteInvestment(req, res) {
  try {
    const ok = await investmentRepository.hardDelete(parseRequestId(req));
    if (!ok) return res.status(404).json({ detail: 'Investment not found' });
    clearInvestmentsCaches();
    res.status(204).end();
  } catch (err) {
    logger.error('Failed to delete investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete investment' });
  }
}

export async function listTransactions(req, res) {
  try {
    const opts = parseInvestmentTransactionsOptions(req.query, parseRequestId(req));
    const result = await portfolioTransactionRepository.getAllWithCount(opts);
    res.json({ items: result.rows, total: result.total, limit: opts.limit, offset: opts.offset, links: [] });
  } catch (err) {
    logger.error('Failed to get portfolio transactions', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve portfolio transactions' });
  }
}

export async function createTransaction(req, res) {
  try {
    const investment_id = parseRequestId(req);
    const inv = await investmentRepository.getById(investment_id);
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });

    const {
      type, date, amount, units, price_per_unit, fees, taxes,
      currency, note, is_recurring, recurrence_interval,
      recurrence_end_date, fx_rate_to_eur,
    } = req.body;

    if (!type || !date) {
      return res.status(400).json({ detail: 'type and date are required' });
    }

    const txn = await portfolioTransactionRepository.create({
      investment_id, type, date, amount, units, price_per_unit, fees, taxes,
      currency: currency || inv.currency, note, is_recurring,
      recurrence_interval, recurrence_end_date, fx_rate_to_eur,
      preloaded_asset_class: inv.asset_class,
    });
    clearInvestmentsCaches();
    refreshQuotesForInvestment(investment_id).catch((err) => {
      logger.error('Transaction-triggered quote refresh failed', { investmentId: investment_id, error: err.message });
    });
    res.status(201).json(txn);
  } catch (err) {
    if (handleValidationError(res, err)) return;
    logger.error('Failed to create portfolio transaction', { error: err.message });
    res.status(500).json({ detail: 'Failed to create portfolio transaction' });
  }
}

export async function deleteTransaction(req, res) {
  try {
    const txnId = parseAndValidateTxnRequestId(req, res);
    if (txnId === undefined) return;

    const existingTxn = await portfolioTransactionRepository.getById(txnId);
    if (!existingTxn) return res.status(404).json({ detail: 'Portfolio transaction not found' });

    const ok = await portfolioTransactionRepository.hardDelete(txnId);
    if (!ok) return res.status(404).json({ detail: 'Portfolio transaction not found' });

    clearInvestmentsCaches();
    refreshQuotesForInvestment(existingTxn.investment_id).catch((err) => {
      logger.error('Transaction-triggered quote refresh failed', { investmentId: existingTxn.investment_id, error: err.message });
    });
    res.status(204).end();
  } catch (err) {
    logger.error('Failed to delete portfolio transaction', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete portfolio transaction' });
  }
}

export async function updateTransaction(req, res) {
  try {
    const txnId = parseAndValidateTxnRequestId(req, res);
    if (txnId === undefined) return;

    const txn = await portfolioTransactionRepository.update(txnId, req.body || {});
    if (!txn) return res.status(404).json({ detail: 'Portfolio transaction not found' });

    clearInvestmentsCaches();
    refreshQuotesForInvestment(txn.investment_id).catch((err) => {
      logger.error('Transaction-triggered quote refresh failed', { investmentId: txn.investment_id, error: err.message });
    });
    res.json(txn);
  } catch (err) {
    if (handleValidationError(res, err)) return;
    logger.error('Failed to update portfolio transaction', { error: err.message });
    res.status(500).json({ detail: 'Failed to update portfolio transaction' });
  }
}

export async function getInvestmentSummary(req, res) {
  try {
    const investmentId = parseRequestId(req);
    const summary = await portfolioTransactionRepository.getSummary(investmentId);
    res.json({ investment_id: investmentId, breakdown: summary });
  } catch (err) {
    logger.error('Failed to get investment summary', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investment summary' });
  }
}
