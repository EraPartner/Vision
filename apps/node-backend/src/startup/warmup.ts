/**
 * Startup warmup tasks.
 *
 * Extracted from main.js so the boot path stays focused on Express wiring.
 * Runs after the HTTP server is listening; builds the materialized views and
 * populates exchange-rate / inflation / portfolio-snapshot / info caches, then
 * schedules recurring refreshes.
 *
 * All tasks are best-effort: failures are logged and the task is marked
 * 'failed' (not left 'pending'), so /health/detailed still settles out of
 * "warming" — reporting `degraded: true` rather than masking the failure.
 * Each `warmupStatus` flag is tri-state: 'pending' | 'ready' | 'failed'.
 */

import { logger } from "../config/logger.ts";
import { query } from "../database/connection.ts";
import {
  createMaterializedViews,
  ensureMaterializedViewIndexes,
  refreshMaterializedViews,
} from "../services/materializedViewService.ts";
import {
  warmCache as warmExchangeRateCache,
  clearMemoryCache as clearExchangeRateCache,
  backfillPortfolioHistoricalRates,
} from "../services/currency/currencyConversionService.ts";
import {
  warmInflationCache,
  clearInflationMemoryCache,
} from "../services/belgianInflationService.ts";
import {
  fetchLivePricesDetailed,
  sanitizePersistedKinesisHistory,
} from "../services/priceProviderService.ts";
import { getKinesisAssetConfig } from "../config/kinesisConfig.ts";
import { computeAndStoreSnapshots } from "../services/portfolioPerformanceSnapshotService.ts";
import {
  backfillHistoricalAssetQuotes,
  refreshActiveHoldingQuotes,
  backfillHoldingGaps,
} from "../services/quoteBackfillService.ts";
import { warmInfoCaches } from "../routes/info.ts";
import { backfillTransfersOnce } from "../services/transferReconciliationService.ts";
import { refreshCashflowForecastMc } from "../jobs/refreshCashflowForecastMc.ts";
import * as researchProviderKeyService from "../services/research/researchProviderKeyService.ts";
import { isInternetReachable } from "../lib/network.ts";
import { createDailyJob } from "./dailyJobs.ts";
import investmentRepository from "../repositories/investmentRepository.ts";
import type { InvestmentRow } from "../types/rows.ts";
import type { ResolvedPrice } from "../services/priceProviderService.ts";

/**
 * Each value is tri-state: 'pending' | 'ready' | 'failed' (see module doc
 * comment above). Typed as a plain string index signature, not named
 * literal-union properties, to match what main.js actually constructs and
 * passes in by reference: `Object.fromEntries(WARMUP_KEYS.map((k) => [k,
 * 'pending']))`, which TS infers as `{ [k: string]: string }` (main.js is
 * outside this ratchet slice, so that construction site isn't itself typed
 * more precisely).
 */
export type WarmupStatus = Record<string, string>;

export interface RunWarmupTasksArgs {
  warmupStatus: WarmupStatus;
  bootMark?: (phase: string) => () => number;
}

export interface WarmupIntervals {
  exchangeRateRefreshInterval: NodeJS.Timeout;
  quotesRefreshInterval: NodeJS.Timeout;
  cashflowForecastRefreshInterval: NodeJS.Timeout;
  holdingGapBackfillInterval: NodeJS.Timeout;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const DAILY_JOB_POLL_MS = 60 * 1000;

// Terminal import-batch states safe to prune (no in-flight staging work).
const IMPORT_RETENTION_DAYS = 30;

/**
 * Best-effort retention sweep: drop finished import batches (and their staging
 * rows) older than IMPORT_RETENTION_DAYS so raw CSV staging data isn't retained
 * forever. Staging rows are removed automatically — both *_staging_rows tables
 * FK the batch with ON DELETE CASCADE. Age is measured from started_at (always
 * NOT NULL; completed_at can be null for aborted/failed batches). Failures are
 * logged and swallowed so warmup is never blocked.
 */
export async function pruneOldImportBatches() {
  const tables = ["import_batches", "portfolio_import_batches"];
  for (const table of tables) {
    try {
      // Adoption receipts retain source provenance and rollback snapshots.
      // The detail columns are json, which has no `?` operator; cast to jsonb.
      const preserveReconciliation =
        table === "portfolio_import_batches"
          ? `AND NOT EXISTS (SELECT 1 FROM portfolio_import_reconciliation_journal journal WHERE journal.batch_id = ${table}.id)
             AND NOT EXISTS (SELECT 1 FROM portfolio_import_income_recognition_journal income
               JOIN portfolio_import_staging_rows unit_source ON unit_source.id=income.unit_staging_row_id
               WHERE income.batch_id=${table}.id OR unit_source.batch_id=${table}.id)
             AND NOT EXISTS (SELECT 1 FROM portfolio_import_duplicate_repair_journal repair WHERE repair.batch_id = ${table}.id OR repair.original_import_batch_id = ${table}.id)
             AND NOT EXISTS (SELECT 1 FROM portfolio_asset_transfers transfer WHERE transfer.import_batch_id = ${table}.id)
             AND NOT EXISTS (SELECT 1 FROM portfolio_asset_adjustments adjustment WHERE adjustment.import_batch_id = ${table}.id)
             AND NOT EXISTS (SELECT 1 FROM portfolio_asset_adjustment_sources evidence JOIN portfolio_import_staging_rows source ON source.id=evidence.staging_row_id WHERE source.batch_id=${table}.id)
             AND NOT EXISTS (SELECT 1 FROM portfolio_import_staging_rows cash_source WHERE cash_source.batch_id=${table}.id AND portfolio_cash_receipt(cash_source.raw_data) IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM portfolio_import_staging_rows native_source WHERE native_source.batch_id=${table}.id AND (native_source.asset_transfer_details::jsonb ? 'networkBinding' OR native_source.asset_transfer_details::jsonb ? 'nativeGiftGroupReceipt' OR native_source.asset_adjustment_details::jsonb ? 'networkReceipt'))
             AND NOT EXISTS (SELECT 1 FROM portfolio_import_staging_rows annotation WHERE annotation.batch_id = ${table}.id AND annotation.route = 'account_internal')`
          : "";
      const result = await query(
        `DELETE FROM ${table}
          WHERE status IN ('complete', 'complete_with_errors', 'failed', 'aborted')
            AND started_at < now() - ($1 || ' days')::interval
            ${preserveReconciliation}`,
        [String(IMPORT_RETENTION_DAYS)],
      );
      if (result.rowCount !== null && result.rowCount > 0) {
        logger.info(
          `Pruned ${result.rowCount} old ${table} row(s) (> ${IMPORT_RETENTION_DAYS}d, staging rows cascade)`,
        );
      }
    } catch (err) {
      logger.error(`Failed to prune old ${table} on startup`, {
        error: (err as Error).message,
      });
    }
  }
}

/**
 * Wrap a scheduled async task so a slow run can't overlap the next interval
 * tick — if the previous invocation is still running, this one is skipped.
 *
 * @param name  label used in the skip log line
 */
function withInFlightGuard(
  name: string,
  fn: () => Promise<void>,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      logger.debug(
        `Skipping scheduled "${name}" — previous run still in progress`,
      );
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

function hasLivePriceRefreshConfig(investment: InvestmentRow): boolean {
  const provider = investment?.price_provider;
  if (!provider || provider === "manual") return false;

  if (provider === "custom") {
    return Boolean(
      investment?.price_provider_latest_url ||
      investment?.price_provider_url ||
      investment?.price_provider_history_url,
    );
  }

  if (provider === "yahoo") {
    return Boolean(investment?.price_provider_id || investment?.symbol);
  }

  if (provider === "kinesis") {
    if (investment?.price_provider_id) return true;
    const assetName = (investment?.name || investment?.symbol || "")
      .toLowerCase()
      .trim();
    return Boolean(assetName && getKinesisAssetConfig(assetName));
  }

  return Boolean(investment?.price_provider_id);
}

function isValidStoredPrice(value: unknown): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

async function persistRefreshedPrices(
  prices: Record<number, ResolvedPrice | undefined>,
): Promise<number> {
  const updateResults = await Promise.all(
    Object.entries(prices).map(
      async ([investmentId, priceData]): Promise<number> => {
        const { price, source } = priceData || {};
        if (price == null || Number.isNaN(price) || source === "cached")
          return 0;

        await investmentRepository.updatePrice(parseInt(investmentId, 10), {
          current_price: price,
          price_updated_at: new Date().toISOString(),
        });
        return 1;
      },
    ),
  );

  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  return updateResults.reduce((sum, count) => sum + count, 0);
}

async function refreshInvestmentPricesOnStartup() {
  const allInvestments = await investmentRepository.getAll({
    limit: 1000,
    active: true,
  });
  const toRefresh = allInvestments.filter(hasLivePriceRefreshConfig);

  if (toRefresh.length === 0) {
    logger.info("No startup investment price refresh needed");
    return;
  }

  const cachedPricesByInvestmentId = Object.fromEntries(
    toRefresh.map((i) => [i.id, Number(i.current_price)]),
  );

  const deferredKinesisRefresh: InvestmentRow[] = [];
  const immediateRefresh: InvestmentRow[] = [];

  for (const investment of toRefresh) {
    if (
      investment.price_provider === "kinesis" &&
      isValidStoredPrice(cachedPricesByInvestmentId[investment.id])
    ) {
      deferredKinesisRefresh.push(investment);
      continue;
    }
    immediateRefresh.push(investment);
  }

  if (immediateRefresh.length > 0) {
    const prices = await fetchLivePricesDetailed(immediateRefresh, {
      cachedPricesByInvestmentId,
    });
    const updated = await persistRefreshedPrices(prices);
    logger.info(
      `Startup immediate investment price refresh completed: ${updated}/${immediateRefresh.length}`,
    );
  } else {
    logger.info(
      "Startup immediate investment price refresh skipped: all configured investments have usable stored prices",
    );
  }

  if (deferredKinesisRefresh.length > 0) {
    logger.info(
      `Startup deferred Kinesis price refresh scheduled for ${deferredKinesisRefresh.length} investment(s)`,
    );
    setTimeout(() => {
      fetchLivePricesDetailed(deferredKinesisRefresh)
        .then((prices) => persistRefreshedPrices(prices))
        .then((updated) => {
          logger.info(
            `Startup deferred Kinesis price refresh completed: ${updated}/${deferredKinesisRefresh.length}`,
          );
        })
        .catch((err) => {
          logger.error("Startup deferred Kinesis price refresh failed", {
            error: err.message,
          });
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
 *  2. Kick off independent fire-and-forget warm tasks (materialized-view
 *     create/index/refresh, inflation, Kinesis sanitize).
 *  3. Chain dependent work: exchange-rate warm + FX backfill → portfolio
 *     snapshots → info caches.
 *  4. Schedule recurring intervals (12h FX, 1h quotes, 24h cashflow MC).
 */
export async function runWarmupTasks({
  warmupStatus,
  bootMark,
}: RunWarmupTasksArgs): Promise<WarmupIntervals> {
  // Load Settings-managed research provider API keys into the in-memory override
  // map so keyed providers reflect Settings on boot. Defensive: a missing table
  // (migration 0043 not applied) or DB hiccup must not break warmup — the env-var
  // fallback still applies.
  try {
    const hydrated = await researchProviderKeyService.hydrate();
    logger.info(
      `Hydrated ${hydrated} research provider API key override(s) from settings`,
    );
  } catch (err) {
    logger.warn(
      "Could not hydrate research provider API keys; using env fallback",
      { error: (err as Error).message },
    );
  }

  // Whole materialized-view lifecycle — create, index, refresh — runs here, not
  // pre-`listen`. Creation is only a metadata no-op once the views exist: on a
  // first-ever boot, or after a migration that drops a view to redefine it
  // (0084/0085), each `CREATE MATERIALIZED VIEW` is a full aggregation scan of
  // `transactions`, which pre-listen was serialized ahead of `/health` inside
  // the window the Electron 60s poll budget races. Requests that land before the
  // views exist are correct, just slower: `mvAvailable()` sees the missing
  // relation and the repositories take their base-table path.
  //
  // Failure is degradation, not a boot failure — the pre-listen call used to
  // abort `start()` (exit 1) instead. MVs are derived artifacts, so a creation
  // failure is reported exactly like the refresh failure it replaces: the flag
  // settles 'failed', /health/detailed reports `degraded: true`, and every read
  // falls back to the live query.
  const markPhase = (phase: string, operation: () => Promise<unknown>) => {
    const end = bootMark?.(phase);
    return operation().finally(() => end?.());
  };
  const materializedViewsReady = markPhase(
    "materialized_views_create",
    createMaterializedViews,
  )
    .then(() =>
      markPhase("materialized_views_indexes", ensureMaterializedViewIndexes),
    )
    .then(() =>
      markPhase("materialized_views_refresh", refreshMaterializedViews),
    )
    .then(() => {
      warmupStatus.materializedViews = "ready";
    })
    .catch((err) => {
      warmupStatus.materializedViews = "failed";
      logger.error("Failed to prepare materialized views on startup", {
        error: err.message,
      });
    });

  // One-time internal-transfer backfill on upgrade (ADR-083). Best-effort and
  // DB-only; refreshes the MVs afterwards so the exclusion is reflected — after
  // the chain above, since refreshing a view that does not exist yet is a no-op
  // that logs an error. Both refreshes are idempotent and coalesce.
  backfillTransfersOnce()
    .then((r) =>
      r.skipped
        ? undefined
        : materializedViewsReady.then(() => refreshMaterializedViews()),
    )
    .catch((err) => {
      logger.error("Internal-transfer backfill failed on startup", {
        error: err.message,
      });
    });

  // Prune only terminal import staging; audit evidence is retained.
  pruneOldImportBatches();

  const online = await isInternetReachable();
  if (!online) {
    logger.warn(
      "No internet connectivity detected — skipping external data refresh on startup; using cached/DB data only",
    );
  }

  const exchangeRateWarmPromise = (
    online ? warmExchangeRateCache() : Promise.resolve()
  )
    .then(() => {
      warmupStatus.exchangeRates = "ready";
    })
    .catch((err) => {
      warmupStatus.exchangeRates = "failed";
      logger.error("Failed to warm exchange rate cache on startup", {
        error: err.message,
      });
    });

  warmInflationCache()
    .then(() => {
      warmupStatus.inflation = "ready";
    })
    .catch((err) => {
      warmupStatus.inflation = "failed";
      logger.error("Failed to warm Belgian inflation cache on startup", {
        error: err.message,
      });
    });

  const fxBackfillPromise = (
    online ? backfillPortfolioHistoricalRates() : Promise.resolve()
  ).catch((err) => {
    logger.error(
      "Failed to backfill portfolio historical exchange rates on startup",
      { error: err.message },
    );
  });

  if (online) {
    backfillHistoricalAssetQuotes().catch((err) => {
      logger.error("Failed to backfill historical asset quotes on startup", {
        error: err.message,
      });
    });
  } else {
    logger.info(
      "Skipping historical asset quote backfill on startup — offline",
    );
  }

  sanitizePersistedKinesisHistory().catch((err) => {
    logger.error("Failed to sanitize persisted Kinesis history on startup", {
      error: err.message,
    });
  });

  const portfolioWarmPromise = Promise.all([
    exchangeRateWarmPromise,
    fxBackfillPromise,
  ])
    .then(() => computeAndStoreSnapshots())
    .then(() => {
      warmupStatus.portfolioSnapshots = "ready";
      return warmInfoCaches()
        .then(() => {
          warmupStatus.infoCaches = "ready";
        })
        .catch((err) => {
          warmupStatus.infoCaches = "failed";
          logger.error("Failed to warm info caches on startup", {
            error: err.message,
          });
        });
    })
    .catch((err) => {
      warmupStatus.portfolioSnapshots = "failed";
      warmupStatus.infoCaches = "failed";
      logger.error(
        "Failed to compute portfolio performance snapshots on startup",
        { error: err.message },
      );
    });

  if (online) {
    refreshInvestmentPricesOnStartup().catch((err) => {
      logger.error("Failed to refresh investment prices on startup", {
        error: err.message,
      });
    });
  } else {
    logger.info("Skipping startup investment price refresh — offline");
  }

  const exchangeRateRefreshInterval = setInterval(
    withInFlightGuard("exchange rate refresh", async () => {
      if (!(await isInternetReachable({ force: true }))) {
        logger.debug("Skipping scheduled exchange rate refresh — offline");
        return;
      }
      logger.info("Running scheduled exchange rate refresh...");
      clearExchangeRateCache();
      await warmExchangeRateCache().catch((err) => {
        logger.error("Scheduled exchange rate refresh failed", {
          error: err.message,
        });
      });

      clearInflationMemoryCache();
      await warmInflationCache().catch((err) => {
        logger.error("Scheduled Belgian inflation refresh failed", {
          error: err.message,
        });
      });
    }),
    TWELVE_HOURS_MS,
  );

  const quotesRefreshInterval = setInterval(
    withInFlightGuard("quote refresh", async () => {
      if (!(await isInternetReachable({ force: true }))) {
        logger.debug("Skipping periodic quote refresh — offline");
        return;
      }
      await refreshActiveHoldingQuotes().catch((err) => {
        logger.error("Periodic quote refresh failed", { error: err.message });
      });
    }),
    ONE_HOUR_MS,
  );

  const refreshDailyForecast = createDailyJob("cashflow_forecast", async () => {
    await portfolioWarmPromise;
    const result = await refreshCashflowForecastMc();
    return result.failed === 0;
  });
  const backfillDailyGaps = createDailyJob("holding_gaps", async () => {
    await portfolioWarmPromise;
    await materializedViewsReady;
    if (!(await isInternetReachable({ force: true }))) return false;
    const result = await backfillHoldingGaps();
    // Always recompute: an earlier attempt may have persisted quotes before
    // failing to persist snapshots, including across a process restart.
    await computeAndStoreSnapshots();
    return result.failed === 0;
  });
  // Catch up once after startup dependencies settle. Timer ticks use the same
  // guard and successful-completion checkpoint, so restarts cannot postpone work.
  Promise.all([exchangeRateWarmPromise, fxBackfillPromise]).then(() =>
    refreshDailyForecast(),
  );
  materializedViewsReady.then(() => backfillDailyGaps());
  const cashflowForecastRefreshInterval = setInterval(
    refreshDailyForecast,
    DAILY_JOB_POLL_MS,
  );
  const holdingGapBackfillInterval = setInterval(
    backfillDailyGaps,
    DAILY_JOB_POLL_MS,
  );

  return {
    exchangeRateRefreshInterval,
    quotesRefreshInterval,
    cashflowForecastRefreshInterval,
    holdingGapBackfillInterval,
  };
}
