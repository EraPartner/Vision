/**
 * Info/Statistics routes.
 *
 * Mirrors: apps/backend/api/api_routes_info.py
 */

import { Router } from 'express';
import infoRepository from '../repositories/infoRepository.js';
import { detectRecurringPatterns } from '../services/recurringDetectionService.js';
import { refreshMaterializedViews } from '../services/materializedViewService.js';
import { logger } from '../config/logger.js';
import { rateLimiter, adminRateLimiter } from '../middleware/rateLimiter.js';
import {
  getInflationRates,
  clearInflationMemoryCache,
} from '../services/belgianInflationService.js';

const router = Router();

const NET_WORTH_CACHE_TTL_MS = 60_000;
const netWorthResponseCache = new Map();

function getCachedNetWorth(key) {
  const cached = netWorthResponseCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt > Date.now() && cached.data) return cached.data;
  return undefined;
}

function setCachedNetWorth(key, data) {
  netWorthResponseCache.set(key, {
    data,
    inflight: undefined,
    expiresAt: Date.now() + NET_WORTH_CACHE_TTL_MS,
  });
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
    let excludedCategoryIds = req.query.excluded_category_ids;
    if (excludedCategoryIds) {
      if (!Array.isArray(excludedCategoryIds)) excludedCategoryIds = [excludedCategoryIds];
      excludedCategoryIds = excludedCategoryIds.map(Number);
    } else {
      excludedCategoryIds = [];
    }

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
    let excludedCategoryIds = req.query.excluded_category_ids;
    if (excludedCategoryIds) {
      if (!Array.isArray(excludedCategoryIds)) excludedCategoryIds = [excludedCategoryIds];
      excludedCategoryIds = excludedCategoryIds.map(Number);
    } else {
      excludedCategoryIds = [];
    }
    let excludedRecipientIds = req.query.excluded_recipient_ids;
    if (excludedRecipientIds) {
      if (!Array.isArray(excludedRecipientIds)) excludedRecipientIds = [excludedRecipientIds];
      excludedRecipientIds = excludedRecipientIds.map(Number);
    } else {
      excludedRecipientIds = [];
    }
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
    const stats = await infoRepository.getStatistics(targetCurrency);
    res.json({
      categories: stats.categories,
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

    const cachedData = getCachedNetWorth(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const cachedEntry = netWorthResponseCache.get(cacheKey);
    if (cachedEntry?.inflight) {
      const data = await cachedEntry.inflight;
      return res.json(data);
    }

    const inflight = infoRepository.getNetWorth(targetCurrency)
      .then((data) => {
        setCachedNetWorth(cacheKey, data);
        return data;
      })
      .catch((error) => {
        const current = netWorthResponseCache.get(cacheKey);
        if (current?.inflight === inflight) {
          netWorthResponseCache.delete(cacheKey);
        }
        throw error;
      });

    netWorthResponseCache.set(cacheKey, {
      data: cachedEntry?.data,
      inflight,
      expiresAt: cachedEntry?.expiresAt || 0,
    });

    const data = await inflight;
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
    const { query: dbQuery } = await import('../database/connection.js');
    const { FALLBACK_RATES, warmCache, clearMemoryCache } = await import('../services/currencyConversionService.js');

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
    const today = new Date().toISOString().split('T')[0];
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
    const { warmCache, clearMemoryCache } = await import('../services/currencyConversionService.js');
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
router.post('/refresh-views', async (req, res) => {
  try {
    const start = Date.now();
    await refreshMaterializedViews();
    res.json({ message: 'Materialized views refreshed', duration_ms: Date.now() - start });
  } catch (err) {
    logger.error('Error refreshing materialized views', { error: err.message });
    res.status(500).json({ detail: 'Error refreshing materialized views' });
  }
});

export default router;
