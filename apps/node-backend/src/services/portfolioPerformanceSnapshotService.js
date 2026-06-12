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
  // SELECT * + shape in JS: value_fx_neutral only exists once migration 0039
  // is applied, and enumerating it in SQL would break un-migrated databases.
  const result = await query(`
    SELECT * FROM portfolio_performance_snapshots
    WHERE currency = $1
      AND snapshot_date >= $2
      AND snapshot_date <= $3
    ORDER BY snapshot_date ASC
  `, [currency, startDate, endDate]);

  return result.rows.map((row) => ({
    snapshot_date: row.snapshot_date,
    invested: row.invested,
    value: row.value,
    stocks_etfs_value: row.stocks_etfs_value,
    crypto_value: row.crypto_value,
    metals_value: row.metals_value,
    cash_value: row.cash_value,
    gain_loss: row.gain_loss,
    return_pct: row.return_pct,
    inflation_adjusted_value: row.inflation_adjusted_value ?? row.value,
    stocks_etfs_invested: row.stocks_etfs_invested ?? 0,
    crypto_invested: row.crypto_invested ?? 0,
    metals_invested: row.metals_invested ?? 0,
    currency: row.currency,
    // undefined (omitted from JSON) when the column is absent or unpopulated —
    // the frontend hides the FX-neutral series in that case.
    value_fx_neutral: row.value_fx_neutral ?? undefined,
  }));
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
