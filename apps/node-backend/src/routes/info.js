/**
 * Info/Statistics routes.
 *
 * Mirrors: apps/backend/api/api_routes_info.py
 */

import { Router } from 'express';
import { query as dbQuery } from '../database/connection.js';
import infoRepository from '../repositories/infoRepository.js';
import { detectRecurringPatterns } from '../services/recurringDetectionService.js';
import { refreshMaterializedViews } from '../services/materializedViewService.js';
import { logger } from '../config/logger.js';
import { rateLimiter, adminRateLimiter } from '../middleware/rateLimiter.js';
import {
  FALLBACK_RATES,
  warmCache,
  clearMemoryCache,
} from '../services/currencyConversionService.js';
import { getSnapshots, computeMetrics, computeHeatmap, getBreakdownSummary } from '../services/portfolioPerformanceSnapshotService.js';
import { downsampleLTTB } from '../utils/downsample.js';
import {
  getInflationRates,
  clearInflationMemoryCache,
} from '../services/belgianInflationService.js';

const router = Router();

const NET_WORTH_CACHE_TTL_MS = 300_000; // 5min – data rarely changes mid-session
const netWorthResponseCache = new Map();

const PERF_CACHE_TTL_MS = 300_000; // 5min
const perfResponseCache = new Map();
const MAX_CACHE_ENTRIES = 100;

function pruneExpiredCacheEntries(cache) {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    const hasInflight = Boolean(value?.inflight);
    if (!hasInflight && (value?.expiresAt || 0) <= now) {
      cache.delete(key);
    }
  }
}

function enforceCacheSizeLimit(cache, maxEntries = MAX_CACHE_ENTRIES) {
  if (cache.size <= maxEntries) return;

  const overflow = cache.size - maxEntries;
  const removableKeys = [];
  for (const [key, value] of cache.entries()) {
    if (!value?.inflight) {
      removableKeys.push(key);
    }
    if (removableKeys.length >= overflow) break;
  }

  for (const key of removableKeys) {
    cache.delete(key);
  }
}

function getFreshCachedData(cache, key, { requireData = false } = {}) {
  pruneExpiredCacheEntries(cache);
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt > Date.now() && (!requireData || cached.data)) return cached.data;
  if (!cached.inflight) {
    cache.delete(key);
  }
  return undefined;
}

function setCachedData(cache, key, data, ttlMs) {
  pruneExpiredCacheEntries(cache);
  cache.set(key, {
    data,
    inflight: undefined,
    expiresAt: Date.now() + ttlMs,
  });
  enforceCacheSizeLimit(cache);
}

function setInflightCache(cache, key, inflight, { keepPreviousData = false } = {}) {
  pruneExpiredCacheEntries(cache);
  const current = cache.get(key);
  cache.set(key, {
    data: keepPreviousData ? current?.data : undefined,
    inflight,
    expiresAt: keepPreviousData ? (current?.expiresAt || 0) : 0,
  });
  enforceCacheSizeLimit(cache);
}

async function resolveCacheWithInflight(cache, key, { ttlMs, requireData = false, keepPreviousData = false, loader }) {
  const cachedData = getFreshCachedData(cache, key, { requireData });
  if (cachedData !== undefined) {
    return cachedData;
  }

  const cachedEntry = cache.get(key);
  if (cachedEntry?.inflight) {
    return cachedEntry.inflight;
  }

  const inflight = loader()
    .then((data) => {
      setCachedData(cache, key, data, ttlMs);
      return data;
    })
    .catch((error) => {
      const current = cache.get(key);
      if (current?.inflight === inflight) {
        cache.delete(key);
      }
      throw error;
    });

  setInflightCache(cache, key, inflight, { keepPreviousData });
  return inflight;
}

function getTargetCurrency(req) {
  const raw = req.query.currency ?? req.query.target_currency;
  if (raw == null || raw === '') return 'EUR';

  const value = String(raw).toUpperCase().trim();
  // Keep validation generic for easy extension to any ISO-4217 code.
  return /^[A-Z]{3}$/.test(value) ? value : 'EUR';
}

function getMonthParam(raw) {
  if (raw == null || raw === '') return undefined;
  const value = String(raw).trim();
  if (/^\d{4}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 7);
  return undefined;
}

function isTruthyQueryParam(raw) {
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

function parseNumericArrayQueryParam(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(Number);
}

function getCurrentDateString() {
  return new Date().toISOString().split('T')[0];
}

function parseSnapshotNumber(value) {
  return parseFloat(value) || 0;
}

function mapPortfolioPerformanceSnapshot(snapshot) {
  return {
    date: snapshot.snapshot_date,
    invested: parseSnapshotNumber(snapshot.invested),
    value: parseSnapshotNumber(snapshot.value),
    stocks_etfs_value: parseSnapshotNumber(snapshot.stocks_etfs_value),
    crypto_value: parseSnapshotNumber(snapshot.crypto_value),
    metals_value: parseSnapshotNumber(snapshot.metals_value),
    stocks_etfs_invested: parseSnapshotNumber(snapshot.stocks_etfs_invested),
    crypto_invested: parseSnapshotNumber(snapshot.crypto_invested),
    metals_invested: parseSnapshotNumber(snapshot.metals_invested),
    inflation_adjusted_value:
      parseSnapshotNumber(snapshot.inflation_adjusted_value) || parseSnapshotNumber(snapshot.value) || 0,
    gain_loss: parseSnapshotNumber(snapshot.gain_loss),
    return_pct: parseSnapshotNumber(snapshot.return_pct),
  };
}

const DOWNSAMPLE_THRESHOLD = 400;

const PERIOD_OFFSETS = {
  '1m': 30,
  '3m': 90,
  '6m': 180,
  '1y': 365,
  '3y': 1095,
};

function filterSnapshotsByPeriod(snapshots, period) {
  if (!period || period === 'all' || !PERIOD_OFFSETS[period]) return snapshots;
  const daysBack = PERIOD_OFFSETS[period];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return snapshots.filter(s => {
    const date = typeof s.snapshot_date === 'string' ? s.snapshot_date : s.snapshot_date.toISOString().slice(0, 10);
    return date >= cutoffStr;
  });
}

async function buildPortfolioPerformancePayload(targetCurrency, startDate, endDate, allSnapshots, period) {
  const mapped = allSnapshots.map(mapPortfolioPerformanceSnapshot);

  // Metrics and heatmap always use full data
  const metrics = computeMetrics(allSnapshots);
  const heatmap = computeHeatmap(allSnapshots);

  // Filter snapshots by period for charts, then downsample
  const periodFiltered = filterSnapshotsByPeriod(allSnapshots, period);
  const periodMapped = periodFiltered.map(mapPortfolioPerformanceSnapshot);
  const snapshots = downsampleLTTB(
    periodMapped,
    DOWNSAMPLE_THRESHOLD,
    (_item, i) => i,
    (item) => item.value,
  );

  // Breakdown summary (per-investment)
  const breakdownSummary = await getBreakdownSummary(targetCurrency);

  return {
    currency: targetCurrency,
    start_date: startDate,
    end_date: endDate,
    snapshots,
    metrics,
    heatmap,
    breakdownSummary,
  };
}

// GET /api/info
router.get('/', async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const stats = await infoRepository.getStatistics(targetCurrency);
    res.json(stats);
  } catch (err) {
    logger.error('Error retrieving statistics', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving statistics' });
  }
});

// GET /api/info/banks
router.get('/banks', async (req, res) => {
  try {
    const banks = await infoRepository.getBanks();
    res.json({ banks });
  } catch (err) {
    logger.error('Error retrieving banks', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving banks' });
  }
});

// GET /api/info/supported-adapters
router.get('/supported-adapters', async (req, res) => {
  // Static config - mirrors Python BANK_CONFIGURATIONS
  const adapters = [
    { key: 'kbc', name: 'KBC', adapter_class: 'KBCAdapter' },
    { key: 'belfius', name: 'Belfius', adapter_class: 'BelfiusAdapter' },
    { key: 'revolut', name: 'Revolut', adapter_class: 'RevolutAdapter' },
    { key: 'vision', name: 'Vision', adapter_class: 'VisionAdapter' },
    { key: 'sabb', name: 'SABB', adapter_class: 'SABBAdapter' },
    { key: 'wise', name: 'Wise', adapter_class: 'WiseAdapter' },
  ];
  res.json({ adapters, total_count: adapters.length });
});

// GET /api/info/transaction-count
router.get('/transaction-count', async (req, res) => {
  try {
    const count = await infoRepository.getTransactionCount();
    res.json({ total_transactions: count });
  } catch (err) {
    logger.error('Error retrieving transaction count', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving transaction count' });
  }
});

// GET /api/info/transaction-summary
router.get('/transaction-summary', async (req, res) => {
  try {
    const { bank_account, start_date, end_date } = req.query;
    const targetCurrency = getTargetCurrency(req);
    const summary = await infoRepository.getTransactionSummary({
      bankAccount: bank_account || null,
      startDate: start_date || null,
      endDate: end_date || null,
      targetCurrency,
    });
    res.json(summary);
  } catch (err) {
    logger.error('Error retrieving transaction summary', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving transaction summary' });
  }
});

// GET /api/info/monthly-summary
router.get('/monthly-summary', async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const excludedCategoryIds = parseNumericArrayQueryParam(req.query.excluded_category_ids);

    logger.debug('Monthly summary request', { excludedCategoryIds });
    const data = await infoRepository.getMonthlyFinancialSummary(excludedCategoryIds, targetCurrency);
    logger.debug('Monthly summary response', { monthCount: data.months?.length, summary: data.summary });
    res.json({ ...data, links: [] });
  } catch (err) {
    logger.error('Error retrieving monthly summary', { error: err.message, stack: err.stack });
    res.status(500).json({ detail: 'Error retrieving monthly financial summary' });
  }
});

// GET /api/info/planned-expenses-next-month
router.get('/planned-expenses-next-month', async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const data = await infoRepository.getPlannedExpensesNextMonth(targetCurrency);
    res.json({ ...data, links: [] });
  } catch (err) {
    logger.error('Error retrieving planned expenses next month', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving planned expenses next month' });
  }
});

// GET /api/info/average-vs-current-spending
router.get('/average-vs-current-spending', async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const data = await infoRepository.getAverageVsCurrentSpending(targetCurrency);
    res.json({ ...data, links: [] });
  } catch (err) {
    logger.error('Error retrieving average vs current spending', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving average vs current spending' });
  }
});

// GET /api/info/cashflow-comparison
router.get('/cashflow-comparison', async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const excludedCategoryIds = parseNumericArrayQueryParam(req.query.excluded_category_ids);
    const excludedRecipientIds = parseNumericArrayQueryParam(req.query.excluded_recipient_ids);
    const data = await infoRepository.getCashflowComparison(excludedCategoryIds, excludedRecipientIds, targetCurrency);
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving cashflow comparison', { error: err.message, stack: err.stack });
    res.status(500).json({ detail: 'Error retrieving cashflow comparison' });
  }
});

// GET /api/info/category-breakdown - Detailed category breakdown with amounts
router.get('/category-breakdown', async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const categories = await infoRepository.getCategoryBreakdown(targetCurrency);
    res.json({
      categories,
      links: [],
    });
  } catch (err) {
    logger.error('Error retrieving category breakdown', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving category breakdown' });
  }
});

// GET /api/info/bank-balances - Current and historical balance per bank account
router.get('/bank-balances', async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const data = await infoRepository.getBankBalances(targetCurrency);
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving bank balances', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving bank balances' });
  }
});

// GET /api/info/recurring-patterns - Detect recurring transaction patterns
router.get('/recurring-patterns', async (req, res) => {
  try {
    const data = await detectRecurringPatterns();
    res.json(data);
  } catch (err) {
    logger.error('Error detecting recurring patterns; returning empty result', { error: err.message });
    res.json({ patterns: [], total: 0 });
  }
});

// GET /api/info/net-worth - Net worth combining bank balances + portfolio
router.get(
  '/net-worth',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'net-worth' }),
  async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const cacheKey = targetCurrency;

    const data = await resolveCacheWithInflight(netWorthResponseCache, cacheKey, {
      ttlMs: NET_WORTH_CACHE_TTL_MS,
      requireData: true,
      keepPreviousData: true,
      loader: () => infoRepository.getNetWorthFromSnapshots(targetCurrency),
    });
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving net worth', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving net worth' });
  }
});

// GET /api/info/recipient-insights - Merchant/recipient spending insights
router.get('/recipient-insights', async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const data = await infoRepository.getRecipientInsights(targetCurrency);
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving recipient insights', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving recipient insights' });
  }
});

// GET /api/info/exchange-rates - View cached exchange rates from database
// Apply a modest per-route rate limiter in addition to the global limiter so
// automated scanners or abusive clients can't hammer the database-heavy route.
router.get(
  '/exchange-rates',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'exchange-rates' }),
  async (req, res) => {
  try {
    // Fetch the latest stored rates (one row per currency)
    const result = await dbQuery(`
      SELECT currency_code, rate_to_eur, rate_date, fetched_at
      FROM exchange_rates
      WHERE is_latest = true
      ORDER BY currency_code ASC
    `);

    const rates = result.rows.map(row => ({
      currency: row.currency_code,
      rate_to_eur: parseFloat(row.rate_to_eur),
      rate_date: row.rate_date instanceof Date ? row.rate_date.toISOString().split('T')[0] : String(row.rate_date),
      fetched_at: row.fetched_at,
    }));

    // If the stored rates are from a previous day, kick off a background refresh
    const today = getCurrentDateString();
    const storedDate = rates.length > 0 ? rates[0].rate_date : null;
    if (!storedDate || storedDate < today) {
      clearMemoryCache();
      warmCache().catch((err) =>
        logger.warn('Background exchange rate refresh failed', { error: err.message })
      );
    }

    res.json({
      total_rates: rates.length,
      rates,
      fallback_rates: FALLBACK_RATES || {},
    });
  } catch (err) {
    logger.error('Error retrieving exchange rates', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving exchange rates' });
  }
});

// POST /api/info/exchange-rates/refresh - Fetch fresh rates from ECB and save to database
// This endpoint triggers an expensive refresh; restrict it with the admin limiter.
router.post('/exchange-rates/refresh', adminRateLimiter, async (req, res) => {
  try {
    // Clear memory cache to force fresh fetch from ECB API
    clearMemoryCache();
    // Fetch fresh rates from ECB and save to database
    await warmCache();
    res.json({ message: 'Exchange rates refreshed from ECB' });
  } catch (err) {
    logger.error('Error refreshing exchange rates', { error: err.message });
    res.status(500).json({ detail: 'Error refreshing exchange rates' });
  }
});

// GET /api/info/inflation-rates - View cached Belgian monthly inflation rates
router.get(
  '/inflation-rates',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'inflation-rates' }),
  async (req, res) => {
    try {
      const startMonth = getMonthParam(req.query.start_month);
      const endMonth = getMonthParam(req.query.end_month);
      const dbOnly = isTruthyQueryParam(req.query.db_only);
      const result = await getInflationRates({
        startMonth,
        endMonth,
        dbOnly,
        scheduleBackgroundRefresh: dbOnly,
      });

      res.json({
        source: result.source,
        total_rates: result.rates.length,
        rates: result.rates,
      });
    } catch (err) {
      logger.error('Error retrieving Belgian inflation rates', { error: err.message });
      res.status(500).json({ detail: 'Error retrieving Belgian inflation rates' });
    }
  }
);

// POST /api/info/inflation-rates/refresh - Force refresh from Statbel
router.post('/inflation-rates/refresh', adminRateLimiter, async (req, res) => {
  try {
    clearInflationMemoryCache();
    const result = await getInflationRates({ forceRefresh: true });
    res.json({ message: 'Belgian inflation rates refreshed from Statbel', source: result.source, total_rates: result.rates.length });
  } catch (err) {
    logger.error('Error refreshing Belgian inflation rates', { error: err.message });
    res.status(500).json({ detail: 'Error refreshing Belgian inflation rates' });
  }
});

// POST /api/info/refresh-views - Manually refresh materialized views
router.post('/refresh-views', adminRateLimiter, async (req, res) => {
  try {
    const start = Date.now();
    await refreshMaterializedViews();
    res.json({ message: 'Materialized views refreshed', duration_ms: Date.now() - start });
  } catch (err) {
    logger.error('Error refreshing materialized views', { error: err.message });
    res.status(500).json({ detail: 'Error refreshing materialized views' });
  }
});

// GET /api/info/portfolio-performance - Get pre-computed portfolio performance snapshots
router.get('/portfolio-performance', rateLimiter({ windowMs: 60_000, maxRequests: 30 }), async (req, res) => {
  try {
    const targetCurrency = getTargetCurrency(req);
    const period = req.query.period || 'all';
    const startDate = '2000-01-01';
    const endDate = getCurrentDateString();
    const cacheKey = `${targetCurrency}:${period}`;

    const data = await resolveCacheWithInflight(perfResponseCache, cacheKey, {
      ttlMs: PERF_CACHE_TTL_MS,
      loader: async () => {
        const snapshots = await getSnapshots(startDate, endDate, targetCurrency);
        return buildPortfolioPerformancePayload(targetCurrency, startDate, endDate, snapshots, period);
      },
    });
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving portfolio performance', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving portfolio performance' });
  }
});

/**
 * Pre-warm the net-worth and portfolio-performance caches so the first
 * request after startup is served instantly from memory.
 */
export async function warmInfoCaches(targetCurrency = 'EUR') {
  try {
    logger.info('Warming net-worth cache...', { targetCurrency });
    const nwData = await infoRepository.getNetWorthFromSnapshots(targetCurrency);
    setCachedData(netWorthResponseCache, targetCurrency, nwData, NET_WORTH_CACHE_TTL_MS);
    logger.info('Net-worth cache warmed', { targetCurrency, snapshots: nwData?.snapshots?.length });
  } catch (err) {
    logger.error('Failed to warm net-worth cache', { error: err.message });
  }

  try {
    logger.info('Warming portfolio-performance cache...', { targetCurrency });
    const startDate = '2000-01-01';
    const endDate = getCurrentDateString();
    const cacheKey = `${targetCurrency}:all`;
    const snapshots = await getSnapshots(startDate, endDate, targetCurrency);
    const payload = await buildPortfolioPerformancePayload(targetCurrency, startDate, endDate, snapshots, 'all');
    setCachedData(perfResponseCache, cacheKey, payload, PERF_CACHE_TTL_MS);
    logger.info('Portfolio-performance cache warmed', { targetCurrency, snapshots: payload.snapshots.length });
  } catch (err) {
    logger.error('Failed to warm portfolio-performance cache', { error: err.message });
  }
}

export default router;
