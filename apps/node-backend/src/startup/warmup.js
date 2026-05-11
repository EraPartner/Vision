/**
 * Startup warmup tasks.
 *
 * Extracted from main.js so the boot path stays focused on Express wiring.
 * Runs after the HTTP server is listening; populates exchange-rate / inflation
 * / portfolio-snapshot / info caches, then schedules recurring refreshes.
 *
 * All tasks are best-effort: failures are logged and `warmupStatus` flags are
 * still set to true so /health/detailed eventually reports "ready".
 */

import { logger } from '../config/logger.js';
import { refreshMaterializedViews } from '../services/materializedViewService.js';
import {
  warmCache as warmExchangeRateCache,
  clearMemoryCache as clearExchangeRateCache,
  backfillPortfolioHistoricalRates,
} from '../services/currency/currencyConversionService.js';
import {
  warmInflationCache,
  clearInflationMemoryCache,
} from '../services/belgianInflationService.js';
import {
  fetchLivePricesDetailed,
  sanitizePersistedKinesisHistory,
} from '../services/priceProviderService.js';
import { getKinesisAssetConfig } from '../config/kinesisConfig.js';
import { computeAndStoreSnapshots } from '../services/portfolioPerformanceSnapshotService.js';
import {
  backfillHistoricalAssetQuotes,
  refreshActiveHoldingQuotes,
} from '../services/quoteBackfillService.js';
import { warmInfoCaches } from '../routes/info.js';
import { refreshCashflowForecastMc } from '../jobs/refreshCashflowForecastMc.js';
import { isInternetReachable } from '../lib/network.js';
import investmentRepository from '../repositories/investmentRepository.js';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

function isValidStoredPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

async function persistRefreshedPrices(prices) {
  const updateResults = await Promise.all(
    Object.entries(prices).map(async ([investmentId, priceData]) => {
      const { price, source } = priceData || {};
      if (price == null || Number.isNaN(price) || source === 'cached') return 0;

      await investmentRepository.updatePrice(parseInt(investmentId, 10), {
        current_price: price,
        price_updated_at: new Date().toISOString(),
      });
      return 1;
    })
  );

  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  return updateResults.reduce((sum, count) => sum + count, 0);
}

async function refreshInvestmentPricesOnStartup() {
  const allInvestments = await investmentRepository.getAll({ limit: 1000, active: true });
  const toRefresh = allInvestments.filter(hasLivePriceRefreshConfig);

  if (toRefresh.length === 0) {
    logger.info('No startup investment price refresh needed');
    return;
  }

  const cachedPricesByInvestmentId = Object.fromEntries(
    toRefresh.map(i => [i.id, Number(i.current_price)])
  );

  const deferredKinesisRefresh = [];
  const immediateRefresh = [];

  for (const investment of toRefresh) {
    if (investment.price_provider === 'kinesis' && isValidStoredPrice(cachedPricesByInvestmentId[investment.id])) {
      deferredKinesisRefresh.push(investment);
      continue;
    }
    immediateRefresh.push(investment);
  }

  if (immediateRefresh.length > 0) {
    const prices = await fetchLivePricesDetailed(immediateRefresh, { cachedPricesByInvestmentId });
    const updated = await persistRefreshedPrices(prices);
    logger.info(`Startup immediate investment price refresh completed: ${updated}/${immediateRefresh.length}`);
  } else {
    logger.info('Startup immediate investment price refresh skipped: all configured investments have usable stored prices');
  }

  if (deferredKinesisRefresh.length > 0) {
    logger.info(`Startup deferred Kinesis price refresh scheduled for ${deferredKinesisRefresh.length} investment(s)`);
    setTimeout(() => {
      fetchLivePricesDetailed(deferredKinesisRefresh)
        .then(prices => persistRefreshedPrices(prices))
        .then((updated) => {
          logger.info(`Startup deferred Kinesis price refresh completed: ${updated}/${deferredKinesisRefresh.length}`);
        })
        .catch((err) => {
          logger.error('Startup deferred Kinesis price refresh failed', { error: err.message });
        });
    }, 0);
  }
}

/**
 * Run the full warmup sequence and schedule recurring refreshes.
 *
 * Sequencing:
 *  1. Probe internet once. When offline, skip outbound fetches to avoid
 *     per-call timeouts blocking readiness.
 *  2. Kick off independent fire-and-forget warm tasks (MV refresh, inflation,
 *     Kinesis sanitize).
 *  3. Chain dependent work: exchange-rate warm + FX backfill → portfolio
 *     snapshots → info caches.
 *  4. Schedule recurring intervals (12h FX, 1h quotes, 24h cashflow MC).
 *
 * @param {{ warmupStatus: object }} args
 * @returns {Promise<{ exchangeRateRefreshInterval: NodeJS.Timeout, quotesRefreshInterval: NodeJS.Timeout, cashflowForecastRefreshInterval: NodeJS.Timeout }>}
 */
export async function runWarmupTasks({ warmupStatus }) {
  refreshMaterializedViews()
    .then(() => { warmupStatus.materializedViews = true; })
    .catch((err) => {
      warmupStatus.materializedViews = true;
      logger.error('Failed to refresh materialized views on startup', { error: err.message });
    });

  const online = await isInternetReachable();
  if (!online) {
    logger.warn('No internet connectivity detected — skipping external data refresh on startup; using cached/DB data only');
  }

  const exchangeRateWarmPromise = (online
    ? warmExchangeRateCache()
    : Promise.resolve())
    .then(() => { warmupStatus.exchangeRates = true; })
    .catch((err) => {
      warmupStatus.exchangeRates = true;
      logger.error('Failed to warm exchange rate cache on startup', { error: err.message });
    });

  warmInflationCache()
    .then(() => { warmupStatus.inflation = true; })
    .catch((err) => {
      warmupStatus.inflation = true;
      logger.error('Failed to warm Belgian inflation cache on startup', { error: err.message });
    });

  const fxBackfillPromise = (online
    ? backfillPortfolioHistoricalRates()
    : Promise.resolve()
  ).catch((err) => {
    logger.error('Failed to backfill portfolio historical exchange rates on startup', { error: err.message });
  });

  if (online) {
    backfillHistoricalAssetQuotes().catch((err) => {
      logger.error('Failed to backfill historical asset quotes on startup', { error: err.message });
    });
  } else {
    logger.info('Skipping historical asset quote backfill on startup — offline');
  }

  sanitizePersistedKinesisHistory().catch((err) => {
    logger.error('Failed to sanitize persisted Kinesis history on startup', { error: err.message });
  });

  Promise.all([exchangeRateWarmPromise, fxBackfillPromise])
    .then(() => computeAndStoreSnapshots())
    .then(() => {
      warmupStatus.portfolioSnapshots = true;
      return warmInfoCaches()
        .then(() => { warmupStatus.infoCaches = true; })
        .catch((err) => {
          warmupStatus.infoCaches = true;
          logger.error('Failed to warm info caches on startup', { error: err.message });
        });
    })
    .catch((err) => {
      warmupStatus.portfolioSnapshots = true;
      warmupStatus.infoCaches = true;
      logger.error('Failed to compute portfolio performance snapshots on startup', { error: err.message });
    });

  if (online) {
    refreshInvestmentPricesOnStartup().catch((err) => {
      logger.error('Failed to refresh investment prices on startup', { error: err.message });
    });
  } else {
    logger.info('Skipping startup investment price refresh — offline');
  }

  const exchangeRateRefreshInterval = setInterval(async () => {
    if (!(await isInternetReachable({ force: true }))) {
      logger.debug('Skipping scheduled exchange rate refresh — offline');
      return;
    }
    logger.info('Running scheduled exchange rate refresh...');
    clearExchangeRateCache();
    await warmExchangeRateCache().catch((err) => {
      logger.error('Scheduled exchange rate refresh failed', { error: err.message });
    });

    clearInflationMemoryCache();
    await warmInflationCache().catch((err) => {
      logger.error('Scheduled Belgian inflation refresh failed', { error: err.message });
    });
  }, TWELVE_HOURS_MS);

  const quotesRefreshInterval = setInterval(async () => {
    if (!(await isInternetReachable({ force: true }))) {
      logger.debug('Skipping periodic quote refresh — offline');
      return;
    }
    refreshActiveHoldingQuotes().catch((err) => {
      logger.error('Periodic quote refresh failed', { error: err.message });
    });
  }, ONE_HOUR_MS);

  const cashflowForecastRefreshInterval = setInterval(() => {
    refreshCashflowForecastMc().catch((err) => {
      logger.error('Nightly cashflow forecast MC refresh failed', { error: err.message });
    });
  }, ONE_DAY_MS);

  return {
    exchangeRateRefreshInterval,
    quotesRefreshInterval,
    cashflowForecastRefreshInterval,
  };
}
