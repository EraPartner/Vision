/**
 * Nightly job: materialise MC + point-estimate forecast cache.
 *
 * Runs computeCashflowForecast (with backtest — see `includeBacktest` below)
 * for every known user and persists the result to cashflow_forecast_mc so
 * daytime requests hit the cache instead of re-running the expensive MC
 * simulation. The backtest is included so the cached payload is complete for
 * the UI; the cost is paid once per user per night rather than per request.
 *
 * Scheduled by startup/warmup.ts with a persisted daily completion checkpoint. Also exported so it
 * can be triggered manually or in integration tests.
 */

import { computeCashflowForecast } from '../services/calculations/forecast/index.ts';
import { getActiveUserIds } from '../repositories/cashflowForecastMcRepository.ts';
import { logger } from '../config/logger.ts';
import { forEachConcurrent } from '../lib/concurrency.ts';

const DEFAULT_MC_PATHS = 1000;
const DEFAULT_MC_PERCENTILES = [10, 50, 90];
const MC_REFRESH_CONCURRENCY = 3;

export async function refreshCashflowForecastMc() {
  const start = Date.now();
  logger.info('Nightly cashflow forecast MC refresh started');

  const userIds = await getActiveUserIds({ strict: true });
  let success = 0;
  let failed = 0;

  await forEachConcurrent(userIds, MC_REFRESH_CONCURRENCY, async (userId: string) => {
    try {
      await computeCashflowForecast({
        userId,
        mcPaths: DEFAULT_MC_PATHS,
        mcPercentiles: DEFAULT_MC_PERCENTILES,
        includeBacktest: true,
        _forceCache: true,
      });
      success++;
    } catch (err) {
      failed++;
      logger.error('Cashflow forecast MC refresh failed for user', {
        userId,
        error: err instanceof Error ? err.message : undefined,
      });
    }
  });

  const elapsed = Date.now() - start;
  logger.info('Nightly cashflow forecast MC refresh complete', {
    users: userIds.length,
    success,
    failed,
    elapsed_ms: elapsed,
  });
  return { success, failed };
}
