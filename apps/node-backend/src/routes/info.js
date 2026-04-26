/**
 * Info/Statistics routes — barrel.
 *
 * Composes five concern-grouped sub-routers under /api/info:
 *   - statistics  (core stats, banks, adapters, summaries, recurring patterns)
 *   - netWorth    (cached net-worth w/ pagination)
 *   - rates       (FX + inflation)
 *   - performance (portfolio-performance snapshots)
 *   - maintenance (refresh-views)
 *
 * Also exposes `warmInfoCaches()` used at boot to pre-populate the
 * net-worth + portfolio-performance caches.
 *
 * Mirrors: apps/backend/api/api_routes_info.py
 */

import { Router } from 'express';
import infoRepository from '../repositories/infoRepository.js';
import { logger } from '../config/logger.js';
import { getSnapshots } from '../services/portfolioPerformanceSnapshotService.js';
import {
  netWorthResponseCache,
  perfResponseCache,
  NET_WORTH_CACHE_TTL_MS,
  PERF_CACHE_TTL_MS,
  setCachedData,
} from './info/_cache.js';
import { buildPortfolioPerformancePayload } from './info/_performanceHelpers.js';
import { getCurrentDateString } from './info/_queryParams.js';

import statisticsRouter from './info/statistics.js';
import netWorthRouter from './info/netWorth.js';
import ratesRouter from './info/rates.js';
import performanceRouter from './info/performance.js';
import maintenanceRouter from './info/maintenance.js';

const router = Router();

router.use('/', statisticsRouter);
router.use('/', netWorthRouter);
router.use('/', ratesRouter);
router.use('/', performanceRouter);
router.use('/', maintenanceRouter);

async function warmNetWorthCache(targetCurrency) {
  try {
    const nwData = await infoRepository.getNetWorthFromSnapshots(targetCurrency);
    setCachedData(netWorthResponseCache, targetCurrency, nwData, NET_WORTH_CACHE_TTL_MS);
    logger.info('Net-worth cache warmed', { targetCurrency, snapshots: nwData?.snapshots?.length });
  } catch (err) {
    logger.error('Failed to warm net-worth cache', { error: err.message });
  }
}

async function warmPortfolioPerformanceCache(targetCurrency) {
  try {
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

/**
 * Pre-warm the net-worth and portfolio-performance caches so the first
 * request after startup is served instantly from memory.
 * Both warmers run in parallel; failures are isolated per cache.
 */
export async function warmInfoCaches(targetCurrency = 'EUR') {
  await Promise.allSettled([
    warmNetWorthCache(targetCurrency),
    warmPortfolioPerformanceCache(targetCurrency),
  ]);
}

export default router;
