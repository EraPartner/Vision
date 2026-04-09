/**
 * Investment routes.
 */

import { Router } from 'express';
import investmentRepository from '../repositories/investmentRepository.js';
import portfolioTransactionRepository from '../repositories/portfolioTransactionRepository.js';
import { fetchHistoricalPrices, fetchLivePricesDetailed, SUPPORTED_PROVIDERS } from '../services/priceProviderService.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';
import { getKinesisAssetConfig } from '../config/kinesisConfig.js';

const router = Router();

// ---- In-memory response caches ----
const INVESTMENTS_CACHE_TTL_MS = 60_000;
let investmentsCache = { data: undefined, expiresAt: 0 };
let bulkTxnCache = { data: undefined, key: '', expiresAt: 0 };
const REFRESH_PRICE_CONCURRENCY = 10;

function parseInteger(value) {
  return parseInt(value, 10);
}

function parseRequestId(req) {
  return parseInteger(req.params.id);
}

function parseTxnRequestId(req) {
  return parseInteger(req.params.txnId);
}

function parseAndValidateTxnRequestId(req, res) {
  const txnId = parseTxnRequestId(req);
  if (isNaN(txnId) || txnId <= 0) {
    res.status(400).json({ detail: 'Invalid transaction ID' });
    return undefined;
  }
  return txnId;
}

function handleValidationError(res, err) {
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
  return raw === '1'
    || raw === 'true'
    || raw === 1
    || raw === true;
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

function clearInvestmentsCaches() {
  investmentsCache = { data: undefined, expiresAt: 0 };
  bulkTxnCache = { data: undefined, key: '', expiresAt: 0 };
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

// GET /api/investments
router.get('/', async (req, res) => {
  try {
    const opts = parseDefaultListOptions(req.query);

    // Cache the default request that the frontend hits on every page (limit=500, active=false, no filter)
    const isDefaultRequest = opts.limit >= 500 && !opts.assetClass && !opts.active && opts.offset === 0;
    if (isDefaultRequest && investmentsCache.data && investmentsCache.expiresAt > Date.now()) {
      return res.json(investmentsCache.data);
    }

    const result = await investmentRepository.getAllWithCount(opts);
    const items = result.rows;
    const total = result.total;
    const payload = { items, total, limit: opts.limit, offset: opts.offset, links: [] };

    if (isDefaultRequest) {
      investmentsCache = { data: payload, expiresAt: Date.now() + INVESTMENTS_CACHE_TTL_MS };
    }

    res.json(payload);
  } catch (err) {
    logger.error('Failed to get investments', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investments' });
  }
});

// POST /api/investments
router.post('/', async (req, res) => {
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
    if (!name || !asset_class) return res.status(400).json({ detail: 'name and asset_class are required' });
    const inv = await investmentRepository.create({
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
    });
    clearInvestmentsCaches();
    res.status(201).json(inv);
  } catch (err) {
    logger.error('Failed to create investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to create investment' });
  }
});


// GET /api/investments/providers (must be before /:id)
router.get('/providers', (req, res) => {
  res.json({ providers: SUPPORTED_PROVIDERS });
});

// POST /api/investments/refresh-prices (must be before /:id)
router.post('/refresh-prices', async (req, res) => {
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
});

router.get('/transactions', async (req, res) => {
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

    // Cache bulk transactions for the default request pattern
    const cacheKey = `${investmentIds.join(',')}:${opts.type || ''}:${opts.perInvestmentLimit}:${opts.offset}`;
    if (bulkTxnCache.key === cacheKey && bulkTxnCache.data && bulkTxnCache.expiresAt > Date.now()) {
      return res.json(bulkTxnCache.data);
    }

    const [items, total] = await Promise.all([
      portfolioTransactionRepository.getAllByInvestmentIds(opts),
      portfolioTransactionRepository.getCount({
        investmentIds: opts.investmentIds,
        type: opts.type,
      }),
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
});

// GET /api/investments/:id
router.get('/:id/price-history', validateIdParam, async (req, res) => {
  try {
    const investmentId = parseRequestId(req);
    const inv = await investmentRepository.getById(investmentId);
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });

    const fromMs = req.query.from_ms;
    const toMs = req.query.to_ms;
    const dbOnly = parseDbOnlyQueryValue(req.query.db_only);

    const points = await fetchHistoricalPrices(inv, {
      fromMs: fromMs !== undefined ? Number(fromMs) : undefined,
      toMs: toMs !== undefined ? Number(toMs) : undefined,
      dbOnly,
    });

    return res.json({
      investment_id: investmentId,
      provider: inv.price_provider,
      points,
    });
  } catch (err) {
    logger.error('Failed to get investment price history', { error: err.message });
    return res.status(500).json({ detail: 'Failed to retrieve investment price history' });
  }
});

// GET /api/investments/:id
router.get('/:id', validateIdParam, async (req, res) => {
  try {
    const inv = await investmentRepository.getById(parseRequestId(req));
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });
    res.json(inv);
  } catch (err) {
    logger.error('Failed to get investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investment' });
  }
});
// PATCH /api/investments/:id
router.patch('/:id', validateIdParam, async (req, res) => {
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
});

// DELETE /api/investments/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  try {
    const ok = await investmentRepository.hardDelete(parseRequestId(req));
    if (!ok) return res.status(404).json({ detail: 'Investment not found' });
    clearInvestmentsCaches();
    res.status(204).end();
  } catch (err) {
    logger.error('Failed to delete investment', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete investment' });
  }
});

// ==================== Portfolio Transactions ====================

// GET /api/investments/:id/transactions
router.get('/:id/transactions', validateIdParam, async (req, res) => {
  try {
    const opts = parseInvestmentTransactionsOptions(req.query, parseRequestId(req));
    const result = await portfolioTransactionRepository.getAllWithCount(opts);
    const items = result.rows;
    const total = result.total;
    res.json({ items, total, limit: opts.limit, offset: opts.offset, links: [] });
  } catch (err) {
    logger.error('Failed to get portfolio transactions', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve portfolio transactions' });
  }
});

// POST /api/investments/:id/transactions
router.post('/:id/transactions', validateIdParam, async (req, res) => {
  try {
    const investment_id = parseRequestId(req);
    const inv = await investmentRepository.getById(investment_id);
    if (!inv) return res.status(404).json({ detail: 'Investment not found' });

    const { type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur } = req.body;
    if (!type || !date) return res.status(400).json({ detail: 'type and date are required' });

    const txn = await portfolioTransactionRepository.create({
      investment_id, type, date, amount, units, price_per_unit, fees, taxes,
      currency: currency || inv.currency, note, is_recurring, recurrence_interval, recurrence_end_date, fx_rate_to_eur,
      preloaded_asset_class: inv.asset_class,
    });
    clearInvestmentsCaches();
    res.status(201).json(txn);
  } catch (err) {
    if (handleValidationError(res, err)) return;
    logger.error('Failed to create portfolio transaction', { error: err.message });
    res.status(500).json({ detail: 'Failed to create portfolio transaction' });
  }
});

// DELETE /api/investments/transactions/:txnId
router.delete('/transactions/:txnId', async (req, res) => {
  try {
    const txnId = parseAndValidateTxnRequestId(req, res);
    if (txnId === undefined) return;
    const ok = await portfolioTransactionRepository.hardDelete(txnId);
    if (!ok) return res.status(404).json({ detail: 'Portfolio transaction not found' });
    clearInvestmentsCaches();
    res.status(204).end();
  } catch (err) {
    logger.error('Failed to delete portfolio transaction', { error: err.message });
    res.status(500).json({ detail: 'Failed to delete portfolio transaction' });
  }
});

// PATCH /api/investments/transactions/:txnId
router.patch('/transactions/:txnId', async (req, res) => {
  try {
    const txnId = parseAndValidateTxnRequestId(req, res);
    if (txnId === undefined) return;
    const txn = await portfolioTransactionRepository.update(txnId, req.body || {});
    if (!txn) return res.status(404).json({ detail: 'Portfolio transaction not found' });
    clearInvestmentsCaches();
    res.json(txn);
  } catch (err) {
    if (handleValidationError(res, err)) return;
    logger.error('Failed to update portfolio transaction', { error: err.message });
    res.status(500).json({ detail: 'Failed to update portfolio transaction' });
  }
});

// GET /api/investments/:id/summary
router.get('/:id/summary', validateIdParam, async (req, res) => {
  try {
    const investmentId = parseRequestId(req);
    const summary = await portfolioTransactionRepository.getSummary(investmentId);
    res.json({ investment_id: investmentId, breakdown: summary });
  } catch (err) {
    logger.error('Failed to get investment summary', { error: err.message });
    res.status(500).json({ detail: 'Failed to retrieve investment summary' });
  }
});

export default router;
