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
} from '../services/currency/currencyConversionService.js';
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
  const targetCurrency = getTargetCurrency(req);
  const stats = await infoRepository.getStatistics(targetCurrency);
  res.ok(stats);
});

// GET /api/info/banks
router.get('/banks', async (req, res) => {
  const banks = await infoRepository.getBanks();
  res.ok({ banks });
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
  res.ok({ adapters, total_count: adapters.length });
});

// GET /api/info/transaction-count
router.get('/transaction-count', async (req, res) => {
  const count = await infoRepository.getTransactionCount();
  res.ok({ total_transactions: count });
});

// GET /api/info/transaction-summary
router.get('/transaction-summary', async (req, res) => {
  const { bank_account, start_date, end_date } = req.query;
  const targetCurrency = getTargetCurrency(req);
  const summary = await infoRepository.getTransactionSummary({
    bankAccount: bank_account || null,
    startDate: start_date || null,
    endDate: end_date || null,
    targetCurrency,
  });
  res.ok(summary);
});

// GET /api/info/monthly-summary
router.get('/monthly-summary', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const excludedCategoryIds = parseNumericArrayQueryParam(req.query.excluded_category_ids);

  logger.debug('Monthly summary request', { excludedCategoryIds });
  const data = await infoRepository.getMonthlyFinancialSummary(excludedCategoryIds, targetCurrency);
  logger.debug('Monthly summary response', { monthCount: data.months?.length, summary: data.summary });
  res.ok({ ...data, links: [] });
});

// GET /api/info/planned-expenses-next-month
router.get('/planned-expenses-next-month', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const data = await infoRepository.getPlannedExpensesNextMonth(targetCurrency);
  res.ok({ ...data, links: [] });
});

// GET /api/info/average-vs-current-spending
router.get('/average-vs-current-spending', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const data = await infoRepository.getAverageVsCurrentSpending(targetCurrency);
  res.ok({ ...data, links: [] });
});

// GET /api/info/cashflow-comparison
router.get('/cashflow-comparison', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const excludedCategoryIds = parseNumericArrayQueryParam(req.query.excluded_category_ids);
  const excludedRecipientIds = parseNumericArrayQueryParam(req.query.excluded_recipient_ids);
  const data = await infoRepository.getCashflowComparison(excludedCategoryIds, excludedRecipientIds, targetCurrency);
  res.ok(data);
});

// GET /api/info/category-breakdown - Detailed category breakdown with amounts
router.get('/category-breakdown', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const categories = await infoRepository.getCategoryBreakdown(targetCurrency);
  res.ok({ categories, links: [] });
});

// GET /api/info/bank-balances - Current and historical balance per bank account
router.get('/bank-balances', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const data = await infoRepository.getBankBalances(targetCurrency);
  res.ok(data);
});

// GET /api/info/recurring-patterns - Detect recurring transaction patterns
// Intentional graceful degradation: on failure emit empty envelope rather than 500.
router.get('/recurring-patterns', async (req, res) => {
  try {
    const data = await detectRecurringPatterns();
    res.ok(data);
  } catch (err) {
    logger.error('Error detecting recurring patterns; returning empty result', { error: err.message });
    res.ok({ patterns: [], total: 0 });
  }
});

// GET /api/info/net-worth - Net worth combining bank balances + portfolio
// Pagination:
//   - When neither `limit` nor `offset` is supplied, returns the full snapshot
//     array (legacy/chart path).
//   - When either is supplied, returns the same envelope but with a snapshot
//     slice (newest-first) and pagination meta for table pagination.
router.get(
  '/net-worth',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'net-worth' }),
  async (req, res) => {
    const targetCurrency = getTargetCurrency(req);
    const cacheKey = targetCurrency;

    const data = await resolveCacheWithInflight(netWorthResponseCache, cacheKey, {
      ttlMs: NET_WORTH_CACHE_TTL_MS,
      requireData: true,
      keepPreviousData: true,
      loader: () => infoRepository.getNetWorthFromSnapshots(targetCurrency),
    });

    const hasLimit = Object.prototype.hasOwnProperty.call(req.query, 'limit');
    const hasOffset = Object.prototype.hasOwnProperty.call(req.query, 'offset');

    if (!hasLimit && !hasOffset) {
      res.ok(data);
      return;
    }

    const limitRaw = parseInt(req.query.limit, 10);
    const offsetRaw = parseInt(req.query.offset, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const allSnapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
    const reversed = allSnapshots.slice().reverse();
    const page = reversed.slice(offset, offset + limit);

    res.ok(
      { ...data, snapshots: page, snapshotsTotal: allSnapshots.length },
      { pagination: { total: allSnapshots.length, limit, offset } },
    );
  });

// GET /api/info/recipient-insights - Merchant/recipient spending insights
router.get('/recipient-insights', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const data = await infoRepository.getRecipientInsights(targetCurrency);
  res.ok(data);
});

// GET /api/info/exchange-rates - View cached exchange rates from database
router.get(
  '/exchange-rates',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'exchange-rates' }),
  async (req, res) => {
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

    const today = getCurrentDateString();
    const storedDate = rates.length > 0 ? rates[0].rate_date : null;
    if (!storedDate || storedDate < today) {
      clearMemoryCache();
      warmCache().catch((err) =>
        logger.warn('Background exchange rate refresh failed', { error: err.message })
      );
    }

    res.ok({
      total_rates: rates.length,
      rates,
      fallback_rates: FALLBACK_RATES || {},
    });
  });

// POST /api/info/exchange-rates/refresh - Fetch fresh rates from ECB and save to database
router.post('/exchange-rates/refresh', adminRateLimiter, async (req, res) => {
  clearMemoryCache();
  await warmCache();
  res.ok({ message: 'Exchange rates refreshed from ECB' });
});

// GET /api/info/inflation-rates - View cached Belgian monthly inflation rates
router.get(
  '/inflation-rates',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'inflation-rates' }),
  async (req, res) => {
    const startMonth = getMonthParam(req.query.start_month);
    const endMonth = getMonthParam(req.query.end_month);
    const dbOnly = isTruthyQueryParam(req.query.db_only);
    const result = await getInflationRates({
      startMonth,
      endMonth,
      dbOnly,
      scheduleBackgroundRefresh: dbOnly,
    });

    res.ok({
      source: result.source,
      total_rates: result.rates.length,
      rates: result.rates,
    });
  }
);

// POST /api/info/inflation-rates/refresh - Force refresh from Statbel
router.post('/inflation-rates/refresh', adminRateLimiter, async (req, res) => {
  clearInflationMemoryCache();
  const result = await getInflationRates({ forceRefresh: true });
  res.ok({
    message: 'Belgian inflation rates refreshed from Statbel',
    source: result.source,
    total_rates: result.rates.length,
  });
});

// POST /api/info/refresh-views - Manually refresh materialized views
router.post('/refresh-views', adminRateLimiter, async (req, res) => {
  const start = Date.now();
  await refreshMaterializedViews();
  res.ok({ message: 'Materialized views refreshed', duration_ms: Date.now() - start });
});

// GET /api/info/portfolio-performance - Get pre-computed portfolio performance snapshots
router.get('/portfolio-performance', rateLimiter({ windowMs: 60_000, maxRequests: 30 }), async (req, res) => {
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
  res.ok(data);
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
