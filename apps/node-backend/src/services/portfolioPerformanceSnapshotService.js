/**
 * Portfolio Performance Snapshot Service
 *
 * Thin orchestrator — delegates snapshot computation/storage to snapshotBuilder,
 * exposes DB read helpers, and re-exports math utilities consumed by info routes.
 */

import { query, withTransaction } from "../database/connection.js";
import {
  computeMetrics,
  computeHeatmap,
} from "./calculations/portfolioMath.js";
import { computeAndStoreSnapshots as computeAggregateSnapshots } from "./portfolio/snapshotBuilder.js";
import {
  getPortfolioSummary,
  getBreakdownSummary,
} from "./portfolio/portfolioSummaryService.js";
import { addAll, toDecimal } from "../lib/money.js";

/** @typedef {import('../types/rows.js').PortfolioPerformanceSnapshotRow} PortfolioPerformanceSnapshotRow */

// Re-export the imported bindings so both `import { x } from` consumers and the
// default-object consumers below share a single declaration each (SIMP-51).
export { computeMetrics, computeHeatmap };
export { getPortfolioSummary, getBreakdownSummary };

const BROKER_HISTORY_PARITY_TOLERANCE = 0.011;

async function hasBrokerSnapshotTable() {
  const result = await query(
    "SELECT to_regclass('public.portfolio_broker_snapshots') AS relation",
  );
  return Boolean(result.rows[0]?.relation);
}

/**
 * Store exactly one forward-only broker split for the current app date.
 * Older dates are never recalculated, so later lot retagging cannot rewrite
 * history.  The current date is replaceable because price/account changes
 * during the day must settle to one internally consistent close.
 *
 * @param {string} currency
 * @param {Awaited<ReturnType<typeof getPortfolioSummary>>} summary
 */
export async function __storeCurrentBrokerSnapshot(currency, summary) {
  if (!(await hasBrokerSnapshotTable())) return { stored: false, rows: 0 };

  const accountIds = [
    ...new Set(
      summary.byAccount.map((row) => row.account_id).filter((id) => id != null),
    ),
  ];
  return withTransaction(async (client) => {
    const namesResult = accountIds.length
      ? await client.query(
          `SELECT id, COALESCE(NULLIF(display_name, ''), name) AS display_name
           FROM accounts WHERE id = ANY($1::int[])`,
          [accountIds],
        )
      : { rows: [] };
    const names = new Map(
      namesResult.rows.map((row) => [Number(row.id), row.display_name]),
    );

    const byKey = new Map();
    for (const row of summary.byAccount) {
      const key =
        row.account_id == null ? "unassigned" : `account:${row.account_id}`;
      const current = byKey.get(key) ?? {
        accountKey: key,
        accountId: row.account_id,
        accountName:
          row.account_id == null
            ? "Unassigned"
            : (names.get(Number(row.account_id)) ??
              `Account ${row.account_id}`),
        value: toDecimal(0),
        invested: toDecimal(0),
        gainLoss: toDecimal(0),
      };
      current.value = current.value.plus(toDecimal(row.currentValue || 0));
      current.invested = current.invested.plus(
        toDecimal(row.totalInvested || 0),
      );
      current.gainLoss = current.gainLoss.plus(toDecimal(row.gainLoss || 0));
      byKey.set(key, current);
    }

    const rows = [...byKey.values()];
    const valueSum = addAll(rows.map((row) => row.value));
    if (
      valueSum
        .minus(summary.totals.totalPortfolioValue || 0)
        .abs()
        .gt(BROKER_HISTORY_PARITY_TOLERANCE)
    ) {
      throw new Error(
        `Broker snapshot parity failed: partitions=${valueSum.toFixed(2)} total=${toDecimal(summary.totals.totalPortfolioValue || 0).toFixed(2)}`,
      );
    }

    const snapshotDate = (
      await client.query("SELECT CURRENT_DATE::text AS today")
    ).rows[0]?.today;
    await client.query(
      "DELETE FROM portfolio_broker_snapshots WHERE snapshot_date = $1 AND currency = $2",
      [snapshotDate, currency],
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO portfolio_broker_snapshots
          (snapshot_date, currency, account_key, account_id, account_name,
           value, invested, gain_loss, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
        [
          snapshotDate,
          currency,
          row.accountKey,
          row.accountId,
          row.accountName,
          row.value.toString(),
          row.invested.toString(),
          row.gainLoss.toString(),
        ],
      );
    }
    return { stored: true, rows: rows.length, snapshotDate };
  });
}

/** Recompute aggregate history, then append/replace today's broker split only. */
export async function computeAndStoreSnapshots(targetCurrency = "EUR") {
  const snapshots = await computeAggregateSnapshots(targetCurrency);
  if (snapshots.length === 0 || !(await hasBrokerSnapshotTable())) {
    return snapshots;
  }
  const summary = await getPortfolioSummary(targetCurrency);
  await __storeCurrentBrokerSnapshot(targetCurrency, summary);
  return snapshots;
}

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

export async function getBrokerSnapshots(startDate, endDate, currency = "EUR") {
  if (!(await hasBrokerSnapshotTable())) return [];
  const result = await query(
    `SELECT snapshot_date, currency, account_key, account_id, account_name,
            value, invested, gain_loss, computed_at
       FROM portfolio_broker_snapshots
      WHERE currency = $1 AND snapshot_date >= $2 AND snapshot_date <= $3
      ORDER BY snapshot_date ASC, account_key ASC`,
    [currency, startDate, endDate],
  );
  return result.rows.map((row) => ({
    date:
      typeof row.snapshot_date === "string"
        ? row.snapshot_date.slice(0, 10)
        : row.snapshot_date.toISOString().slice(0, 10),
    currency: row.currency,
    accountKey: row.account_key,
    accountId: row.account_id == null ? null : Number(row.account_id),
    accountName: row.account_name,
    assignment: row.account_id == null ? "unassigned" : "account",
    value: Number(row.value),
    invested: Number(row.invested),
    gainLoss: Number(row.gain_loss),
    computedAt: row.computed_at,
  }));
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
  getBrokerSnapshots,
  getLatestSnapshot,
  computeMetrics,
  computeHeatmap,
  getBreakdownSummary,
  getPortfolioSummary,
};
