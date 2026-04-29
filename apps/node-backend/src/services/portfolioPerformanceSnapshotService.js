/**
 * Portfolio Performance Snapshot Service
 *
 * Thin orchestrator — delegates snapshot computation/storage to snapshotBuilder,
 * exposes DB read helpers, and re-exports math utilities consumed by info routes.
 */

import { query } from '../database/connection.js';
import { computeMetrics, computeHeatmap } from '../utils/portfolioMath.js';
import { computeAndStoreSnapshots as _computeAndStoreSnapshots } from './portfolio/snapshotBuilder.js';
import {
  getPortfolioSummary as _getPortfolioSummary,
  getBreakdownSummary as _getBreakdownSummary,
} from './portfolio/portfolioSummaryService.js';

export { computeMetrics, computeHeatmap } from '../utils/portfolioMath.js';
export { computeAndStoreSnapshots } from './portfolio/snapshotBuilder.js';
export { getPortfolioSummary, getBreakdownSummary } from './portfolio/portfolioSummaryService.js';

export async function getSnapshots(startDate, endDate, currency = 'EUR') {
  const result = await query(`
    SELECT
      snapshot_date,
      invested,
      value,
      stocks_etfs_value,
      crypto_value,
      metals_value,
      cash_value,
      gain_loss,
      return_pct,
      COALESCE(inflation_adjusted_value, value) AS inflation_adjusted_value,
      COALESCE(stocks_etfs_invested, 0) AS stocks_etfs_invested,
      COALESCE(crypto_invested, 0) AS crypto_invested,
      COALESCE(metals_invested, 0) AS metals_invested,
      currency
    FROM portfolio_performance_snapshots
    WHERE currency = $1
      AND snapshot_date >= $2
      AND snapshot_date <= $3
    ORDER BY snapshot_date ASC
  `, [currency, startDate, endDate]);

  return result.rows;
}

export async function getLatestSnapshot(currency = 'EUR') {
  const result = await query(`
    SELECT * FROM portfolio_performance_snapshots
    WHERE currency = $1
    ORDER BY snapshot_date DESC
    LIMIT 1
  `, [currency]);

  return result.rows[0] ?? null;
}

export default {
  computeAndStoreSnapshots: _computeAndStoreSnapshots,
  getSnapshots,
  getLatestSnapshot,
  computeMetrics,
  computeHeatmap,
  getBreakdownSummary: _getBreakdownSummary,
  getPortfolioSummary: _getPortfolioSummary,
};
