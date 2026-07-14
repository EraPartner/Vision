/**
 * Startup warmup tasks.
 *
 * Extracted from main.js so the boot path stays focused on Express wiring.
 * Runs after the HTTP server is listening; populates exchange-rate / inflation
 * / portfolio-snapshot / info caches, then schedules recurring refreshes.
 *
 * All tasks are best-effort: failures are logged and the task is marked
 * 'failed' (not left 'pending'), so /health/detailed still settles out of
 * "warming" — reporting `degraded: true` rather than masking the failure.
 * Each `warmupStatus` flag is tri-state: 'pending' | 'ready' | 'failed'.
 */

import { logger } from '../config/logger.js';
import { query } from '../database/connection.js';
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
  backfillHoldingGaps,
} from '../services/quoteBackfillService.js';
import { warmInfoCaches } from '../routes/info.js';
import { backfillTransfersOnce } from '../services/transferReconciliationService.js';
import { refreshCashflowForecastMc } from '../jobs/refreshCashflowForecastMc.js';
import * as researchProviderKeyService from '../services/research/researchProviderKeyService.js';
import { isInternetReachable } from '../lib/network.js';
import investmentRepository from '../repositories/investmentRepository.js';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Terminal import-batch states safe to prune (no in-flight staging work).
const IMPORT_RETENTION_DAYS = 30;

// db_editor_audit carries full before/after JSONB images per changed row and is
// never deleted from anywhere — a slow-burn disk-growth sink. Keep a generous
// window (the table is indexed, so reads stay fast regardless).
const DB_EDITOR_AUDIT_RETENTION_DAYS = 180;

/**
 * Best-effort retention sweep: drop finished import batches (and their staging
 * rows) older than IMPORT_RETENTION_DAYS so raw CSV staging data isn't retained
 * forever. Staging rows are removed automatically — both *_staging_rows tables
 * FK the batch with ON DELETE CASCADE. Age is measured from started_at (always
 * NOT NULL; completed_at can be null for aborted/failed batches). Failures are
 * logged and swallowed so warmup is never blocked.
 */
async function pruneOldImportBatches() {
  const tables = ['import_batches', 'portfolio_import_batches'];
  for (const table of tables) {
    try {
      const result = await query(
        `DELETE FROM ${table}
          WHERE status IN ('complete', 'failed', 'aborted')
            AND started_at < now() - ($1 || ' days')::interval`,
        [String(IMPORT_RETENTION_DAYS)],
      );
      if (result.rowCount > 0) {
        logger.info(`Pruned ${result.rowCount} old ${table} row(s) (> ${IMPORT_RETENTION_DAYS}d, staging rows cascade)`);
      }
    } catch (err) {
      logger.error(`Failed to prune old ${table} on startup`, { error: err.message });
    }
  }
}

/**
 * Best-effort retention sweep for the admin DB-editor audit log. Same family as
 * the import-staging prune above: full JSONB before/after images accumulate
 * forever otherwise. Age from created_at. Failures logged and swallowed.
 */
async function pruneOldDbEditorAudit() {
  try {
    const result = await query(
      `DELETE FROM db_editor_audit
        WHERE created_at < now() - ($1 || ' days')::interval`,
      [String(DB_EDITOR_AUDIT_RETENTION_DAYS)],
    );
    if (result.rowCount > 0) {
      logger.info(`Pruned ${result.rowCount} old db_editor_audit row(s) (> ${DB_EDITOR_AUDIT_RETENTION_DAYS}d)`);
    }
  } catch (err) {
    logger.error('Failed to prune old db_editor_audit on startup', { error: err.message });
  }
}

/**
 * Wrap a scheduled async task so a slow run can't overlap the next interval
 * tick — if the previous invocation is still running, this one is skipped.
 *
 * @param {string} name  label used in the skip log line
 * @param {() => Promise<void>} fn
 * @returns {() => Promise<void>}
 */
function withInFlightGuard(name, fn) {
  let running = false;
  return async () => {
    if (running) {
      logger.debug(`Skipping scheduled "${name}" — previous run still in progress`);
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
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
 * @returns {Promise<{ exchangeRateRefreshInterval: NodeJS.Timeout, quotesRefreshInterval: NodeJS.Timeout, cashflowForecastRefreshInterval: NodeJS.Timeout, holdingGapBackfillInterval: NodeJS.Timeout }>}
 */
export async function runWarmupTasks({ warmupStatus }) {
  // Load Settings-managed research provider API keys into the in-memory override
  // map so keyed providers reflect Settings on boot. Defensive: a missing table
  // (migration 0043 not applied) or DB hiccup must not break warmup — the env-var
  // fallback still applies.
  try {
    const hydrated = await researchProviderKeyService.hydrate();
    logger.info(`Hydrated ${hydrated} research provider API key override(s) from settings`);
  } catch (err) {
    logger.warn('Could not hydrate research provider API keys; using env fallback', { error: err.message });
  }

  // One-time internal-transfer backfill on upgrade (ADR-083). Best-effort and
  // DB-only; refreshes the MVs afterwards so the exclusion is reflected. Runs
  // before the MV refresh below kicks off; both are idempotent.
  backfillTransfersOnce()
    .then((r) => { if (!r.skipped) return refreshMaterializedViews(); })
    .catch((err) => {
      logger.error('Internal-transfer backfill failed on startup', { error: err.message });
    });

  refreshMaterializedViews()
    .then(() => { warmupStatus.materializedViews = 'ready'; })
    .catch((err) => {
      warmupStatus.materializedViews = 'failed';
      logger.error('Failed to refresh materialized views on startup', { error: err.message });
    });

  // Best-effort retention sweeps for unbounded audit/staging tables (self-catching).
  pruneOldImportBatches();
  pruneOldDbEditorAudit();

  const online = await isInternetReachable();
  if (!online) {
    logger.warn('No internet connectivity detected — skipping external data refresh on startup; using cached/DB data only');
  }

  const exchangeRateWarmPromise = (online
    ? warmExchangeRateCache()
    : Promise.resolve())
    .then(() => { warmupStatus.exchangeRates = 'ready'; })
    .catch((err) => {
      warmupStatus.exchangeRates = 'failed';
      logger.error('Failed to warm exchange rate cache on startup', { error: err.message });
    });

  warmInflationCache()
    .then(() => { warmupStatus.inflation = 'ready'; })
    .catch((err) => {
      warmupStatus.inflation = 'failed';
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
      warmupStatus.portfolioSnapshots = 'ready';
      return warmInfoCaches()
        .then(() => { warmupStatus.infoCaches = 'ready'; })
        .catch((err) => {
          warmupStatus.infoCaches = 'failed';
          logger.error('Failed to warm info caches on startup', { error: err.message });
        });
    })
    .catch((err) => {
      warmupStatus.portfolioSnapshots = 'failed';
      warmupStatus.infoCaches = 'failed';
      logger.error('Failed to compute portfolio performance snapshots on startup', { error: err.message });
    });

  if (online) {
    refreshInvestmentPricesOnStartup().catch((err) => {
      logger.error('Failed to refresh investment prices on startup', { error: err.message });
    });
  } else {
    logger.info('Skipping startup investment price refresh — offline');
  }

  const exchangeRateRefreshInterval = setInterval(
    withInFlightGuard('exchange rate refresh', async () => {
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
    }),
    TWELVE_HOURS_MS,
  );

  const quotesRefreshInterval = setInterval(
    withInFlightGuard('quote refresh', async () => {
      if (!(await isInternetReachable({ force: true }))) {
        logger.debug('Skipping periodic quote refresh — offline');
        return;
      }
      await refreshActiveHoldingQuotes().catch((err) => {
        logger.error('Periodic quote refresh failed', { error: err.message });
      });
    }),
    ONE_HOUR_MS,
  );

  const cashflowForecastRefreshInterval = setInterval(
    withInFlightGuard('cashflow forecast MC refresh', async () => {
      await refreshCashflowForecastMc().catch((err) => {
        logger.error('Nightly cashflow forecast MC refresh failed', { error: err.message });
      });
    }),
    ONE_DAY_MS,
  );

  // Daily gap-fill: densify any holding window whose stored daily series has grown sparse
  // (provider outages, the old Binance 365-day cap, etc). Recompute snapshots only when new
  // rows were actually written, so the Performance page reflects the denser history.
  const holdingGapBackfillInterval = setInterval(
    withInFlightGuard('holding-gap backfill', async () => {
      if (!(await isInternetReachable({ force: true }))) {
        logger.debug('Skipping scheduled holding-gap backfill — offline');
        return;
      }
      const result = await backfillHoldingGaps().catch((err) => {
        logger.error('Scheduled holding-gap backfill failed', { error: err.message });
        return undefined;
      });
      if (result && result.filled > 0) {
        await computeAndStoreSnapshots().catch((err) => {
          logger.error('Snapshot recompute after holding-gap backfill failed', { error: err.message });
        });
      }
    }),
    ONE_DAY_MS,
  );

  return {
    exchangeRateRefreshInterval,
    quotesRefreshInterval,
    cashflowForecastRefreshInterval,
    holdingGapBackfillInterval,
  };
}
