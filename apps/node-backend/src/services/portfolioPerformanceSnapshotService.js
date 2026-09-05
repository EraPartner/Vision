/**
 * Portfolio Performance Snapshot Service
 *
 * Thin orchestrator — delegates snapshot computation/storage to snapshotBuilder,
 * exposes DB read helpers, and re-exports math utilities consumed by info routes.
 */

import { query } from "../database/connection.js";
import {
  computeMetrics,
  computeHeatmap,
} from "./calculations/portfolioMath.js";
import { computeAndStoreSnapshots } from "./portfolio/snapshotBuilder.js";
import {
  getPortfolioSummary,
  getBreakdownSummary,
} from "./portfolio/portfolioSummaryService.js";

/** @typedef {import('../types/rows.js').PortfolioPerformanceSnapshotRow} PortfolioPerformanceSnapshotRow */

// Re-export the imported bindings so both `import { x } from` consumers and the
// default-object consumers below share a single declaration each (SIMP-51).
export { computeMetrics, computeHeatmap };
export { computeAndStoreSnapshots };
export { getPortfolioSummary, getBreakdownSummary };

/**
 * @param {string} startDate 'YYYY-MM-DD'
 * @param {string} endDate 'YYYY-MM-DD'
 * @param {string} [currency]
 * @returns {Promise<Array<{
 *   snapshot_date: Date,
 *   invested: string,
 *   value: string,
 *   stocks_etfs_value: string,
 *   crypto_value: string,
 *   metals_value: string,
 *   cash_value: string,
 *   gain_loss: string,
 *   return_pct: string,
 *   inflation_adjusted_value: string,
 *   stocks_etfs_invested: string,
 *   crypto_invested: string,
 *   metals_invested: string,
 *   currency: string,
 *   value_fx_neutral: string|undefined,
 * }>>}
 */
export async function getSnapshots(startDate, endDate, currency = "EUR") {
  // SELECT * + shape in JS: value_fx_neutral only exists once migration 0039
  // is applied, and enumerating it in SQL would break un-migrated databases.
  const result = await query(
    `
    SELECT * FROM portfolio_performance_snapshots
    WHERE currency = $1
      AND snapshot_date >= $2
      AND snapshot_date <= $3
    ORDER BY snapshot_date ASC
  `,
    [currency, startDate, endDate],
  );

  return result.rows.map(
    (/** @type {PortfolioPerformanceSnapshotRow} */ row) => ({
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
      stocks_etfs_invested: row.stocks_etfs_invested ?? "0",
      crypto_invested: row.crypto_invested ?? "0",
      metals_invested: row.metals_invested ?? "0",
      currency: row.currency,
      // undefined (omitted from JSON) when the column is absent or unpopulated —
      // the frontend hides the FX-neutral series in that case.
      value_fx_neutral: row.value_fx_neutral ?? undefined,
    }),
  );
}

async function getLatestSnapshot(currency = "EUR") {
  const result = await query(
    `
    SELECT * FROM portfolio_performance_snapshots
    WHERE currency = $1
    ORDER BY snapshot_date DESC
    LIMIT 1
  `,
    [currency],
  );

  return result.rows[0] ?? null;
}

export { getLatestSnapshot as __getLatestSnapshot };

export default {
  computeAndStoreSnapshots,
  getSnapshots,
  getLatestSnapshot,
  computeMetrics,
  computeHeatmap,
  getBreakdownSummary,
  getPortfolioSummary,
};
