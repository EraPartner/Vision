/**
 * Nightly job: materialise MC + point-estimate forecast cache.
 *
 * Runs computeCashflowForecast (without backtest) for every known user and
 * persists the result to cashflow_forecast_mc so daytime requests hit the
 * cache instead of re-running the expensive MC simulation.
 *
 * Called from main.js via setInterval every 24 hours. Also exported so it
 * can be triggered manually or in integration tests.
 */

import { computeCashflowForecast } from '../services/calculations/forecast/index.js';
import { getActiveUserIds } from '../repositories/cashflowForecastMcRepository.js';
import { logger } from '../config/logger.js';

const DEFAULT_MC_PATHS = 1000;
const DEFAULT_MC_PERCENTILES = [10, 50, 90];
const MC_REFRESH_CONCURRENCY = 3;

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

export async function refreshCashflowForecastMc() {
  const start = Date.now();
  logger.info('Nightly cashflow forecast MC refresh started');

  const userIds = await getActiveUserIds();
  let success = 0;
  let failed = 0;

  await runWithConcurrency(userIds, MC_REFRESH_CONCURRENCY, async (userId) => {
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
        error: err.message,
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
}
