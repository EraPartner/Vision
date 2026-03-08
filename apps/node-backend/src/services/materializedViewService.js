/**
 * Materialized View Manager
 *
 * Creates and refreshes materialized views that pre-compute expensive
 * dashboard aggregations (monthly summaries, category totals, cashflow).
 * Views are refreshed CONCURRENTLY so reads remain unblocked.
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';

/** All managed materialized view names */
const MATERIALIZED_VIEWS = [
  'mv_monthly_summary',
  'mv_category_totals',
  'mv_cashflow_daily',
  'mv_bank_balances',
];

/**
 * Create all materialized views (idempotent).
 * Call during schema initialisation.
 */
export async function createMaterializedViews() {
  logger.info('Creating materialized views (if not exist)…');

  // 1. Monthly income / spending / net per month (last 12 months)
  await query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_monthly_summary AS
    SELECT
      date_trunc('month', t.date)::date AS month_start,
      EXTRACT(MONTH FROM t.date)::int AS month,
      EXTRACT(YEAR FROM t.date)::int AS year,
      t.currency,
      COUNT(*) AS transaction_count,
      SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END) AS total_income,
      SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END) AS total_spending,
      SUM(t.amount) AS net_amount,
      c.id AS category_id,
      COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS category_name
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '12 months'
    GROUP BY month_start, month, year, t.currency, c.id, category_name
    ORDER BY month_start
  `);

  // Unique index for CONCURRENT refresh
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_monthly_summary_idx
    ON mv_monthly_summary (month_start, currency, COALESCE(category_id, -1))
  `);

  // 2. Category totals (all-time)
  await query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_category_totals AS
    SELECT
      COALESCE(c.id, -1) AS category_id,
      COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS name,
      COUNT(*) AS count,
      SUM(t.amount) AS total,
      t.currency
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
    WHERE t.is_active = true
    GROUP BY category_id, name, t.currency
    ORDER BY count DESC
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_category_totals_idx
    ON mv_category_totals (category_id, currency)
  `);

  // 3. Daily cashflow (last 7 months – 6 complete + current)
  await query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cashflow_daily AS
    SELECT
      t.date,
      EXTRACT(DAY FROM t.date)::int AS day_of_month,
      date_trunc('month', t.date)::date AS month_start,
      t.currency,
      SUM(t.amount) AS net
    FROM transactions t
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
    GROUP BY t.date, day_of_month, month_start, t.currency
    ORDER BY t.date
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_cashflow_daily_idx
    ON mv_cashflow_daily (date, currency)
  `);

  // 4. Bank account balances (running totals)
  await query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_bank_balances AS
    SELECT
      bank_account,
      t.currency,
      COUNT(*) AS transaction_count,
      MIN(t.date) AS first_transaction,
      MAX(t.date) AS last_transaction,
      SUM(t.amount) AS balance
    FROM transactions t
    WHERE t.is_active = true AND bank_account IS NOT NULL
    GROUP BY bank_account, t.currency
    ORDER BY bank_account
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_bank_balances_idx
    ON mv_bank_balances (bank_account, currency)
  `);

  logger.info('Materialized views ready');
}

/** Track whether a refresh is already in flight to avoid pile-ups */
let refreshInFlight = false;
let refreshQueued = false;

/**
 * Refresh all materialized views concurrently.
 * Coalesces rapid-fire calls (e.g. bulk import) into a single refresh.
 */
export async function refreshMaterializedViews() {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }

  refreshInFlight = true;
  const start = Date.now();

  try {
    // CONCURRENTLY requires unique indexes (created above) and allows
    // reads to continue during refresh.
    await Promise.all(
      MATERIALIZED_VIEWS.map(view =>
        query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`).catch(err => {
          // Fall back to non-concurrent if view was never populated
          if (err.message?.includes('has not been populated')) {
            return query(`REFRESH MATERIALIZED VIEW ${view}`);
          }
          logger.warn(`Failed to refresh ${view}`, { error: err.message });
        })
      )
    );
    logger.info(`Materialized views refreshed in ${Date.now() - start}ms`);
  } catch (err) {
    logger.error('Materialized view refresh failed', { error: err.message });
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      // Schedule deferred refresh
      setTimeout(() => refreshMaterializedViews(), 500);
    }
  }
}

/**
 * Schedule a debounced refresh — useful after single-row mutations.
 * Waits 1s to coalesce rapid changes (e.g. rapid edits).
 */
let debounceTimer = null;

export function scheduleRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    refreshMaterializedViews();
  }, 1000);
}

export default { createMaterializedViews, refreshMaterializedViews, scheduleRefresh };
