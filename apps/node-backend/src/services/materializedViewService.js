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
  //    Drop and recreate if the column list changed (e.g. category_id_key added).
  //    This must run first — DROP CASCADE would destroy the other views if they
  //    happened to depend on it, so we serialise this one step.
  await query(`DROP MATERIALIZED VIEW IF EXISTS mv_monthly_summary CASCADE`);
  await query(`
    CREATE MATERIALIZED VIEW mv_monthly_summary AS
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
      COALESCE(c.id, -1) AS category_id_key,
      COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS category_name
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '12 months'
    GROUP BY month_start, month, year, t.currency, c.id, category_name
    ORDER BY month_start
  `);

  // Unique index on plain columns — no expressions, so CONCURRENT refresh works
  await query(`
    CREATE UNIQUE INDEX mv_monthly_summary_idx
    ON mv_monthly_summary (month_start, currency, category_id_key)
  `);

  // 2-4. Category totals, daily cashflow, and bank balances are fully independent
  //      of each other — create them in parallel.
  await Promise.all([
    // 2. Category totals (all-time)
    query(`
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
      GROUP BY
        COALESCE(c.id, -1),
        COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED'),
        t.currency
      ORDER BY count DESC
    `).then(() => query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mv_category_totals_idx
      ON mv_category_totals (category_id, currency)
    `)),

    // 3. Daily cashflow (last 7 months – 6 complete + current)
    query(`
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
    `).then(() => query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mv_cashflow_daily_idx
      ON mv_cashflow_daily (date, currency)
    `)),

    // 4. Bank account balances (running totals)
    query(`
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
    `).then(() => query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mv_bank_balances_idx
      ON mv_bank_balances (bank_account, currency)
    `)),
  ]);

  logger.info('Materialized views ready');
}

/**
 * Ensure all unique indexes exist (idempotent).
 * Runs at startup separately from createMaterializedViews so that DBs which
 * were created before the indexes were added get them retroactively.
 * Note: mv_monthly_summary is always dropped+recreated above so its index
 * is always fresh — only the remaining views need this safety net.
 */
export async function ensureMaterializedViewIndexes() {
  const indexes = [
    {
      name: 'mv_category_totals_idx',
      view: 'mv_category_totals',
      columns: `(category_id, currency)`,
    },
    {
      name: 'mv_cashflow_daily_idx',
      view: 'mv_cashflow_daily',
      columns: `(date, currency)`,
    },
    {
      name: 'mv_bank_balances_idx',
      view: 'mv_bank_balances',
      columns: `(bank_account, currency)`,
    },
  ];

  // All three indexes are on independent views — create them in parallel
  await Promise.all(
    indexes.map(({ name, view, columns }) =>
      query(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${view} ${columns}`).catch(err => {
        logger.warn(`Could not create index ${name} on ${view}`, { error: err.message });
      })
    )
  );
}

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
          // Fall back to non-concurrent if the view has no unique index or was never populated
          if (
            err.message?.includes('has not been populated') ||
            err.message?.includes('cannot refresh materialized view') ||
            err.message?.includes('concurrently')
          ) {
            logger.warn(`Falling back to non-concurrent refresh for ${view}`);
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
      // Schedule deferred refresh; swallow rejection so unhandled promises do not crash the process.
      setTimeout(() => {
        refreshMaterializedViews().catch(err => {
          logger.warn('Deferred materialized view refresh failed', { error: err.message });
        });
      }, 500);
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
    refreshMaterializedViews().catch(err => {
      logger.warn('Debounced materialized view refresh failed', { error: err.message });
    });
  }, 1000);
}

export default { createMaterializedViews, refreshMaterializedViews, scheduleRefresh };
