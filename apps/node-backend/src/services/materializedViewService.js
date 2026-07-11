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
      COALESCE(c.id, -1) AS category_id_key,
      COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS category_name
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
    WHERE t.is_active = true AND t.is_transfer = false
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '12 months'
    GROUP BY month_start, month, year, t.currency, c.id, category_name
    ORDER BY month_start
  `);

  // Unique index on plain columns — no expressions, so CONCURRENT refresh works
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_monthly_summary_idx
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
      WHERE t.is_active = true AND t.is_transfer = false
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
      WHERE t.is_active = true AND t.is_transfer = false
        AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
      GROUP BY t.date, day_of_month, month_start, t.currency
      ORDER BY t.date
    `).then(() => query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mv_cashflow_daily_idx
      ON mv_cashflow_daily (date, currency)
    `)),

    // 4. Bank account balances (running totals). Grained on (account_id, currency)
    //    per ADR-088 / D2 — the last reader flipped off the bank_account string.
    //    `a.name AS bank_account` is kept as an output label so read-side consumers
    //    stay source-compatible while the string column is retired. Matches
    //    alembic/manual/contract_drop_bank_account/up.sql step 2.
    query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_bank_balances AS
      SELECT
        t.account_id,
        a.name AS bank_account,
        t.currency,
        COUNT(*) AS transaction_count,
        MIN(t.date) AS first_transaction,
        MAX(t.date) AS last_transaction,
        SUM(t.amount) AS balance
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.is_active = true AND t.account_id IS NOT NULL
      GROUP BY t.account_id, a.name, t.currency
      ORDER BY a.name
    `).then(() => query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mv_bank_balances_idx
      ON mv_bank_balances (account_id, currency)
    `)),
  ]);

  logger.info('Materialized views ready');
}

/**
 * Ensure all unique indexes exist (idempotent).
 * Runs at startup separately from createMaterializedViews so that DBs which
 * were created before the indexes were added get them retroactively.
 */
export async function ensureMaterializedViewIndexes() {
  const indexes = [
    {
      name: 'mv_monthly_summary_idx',
      view: 'mv_monthly_summary',
      columns: `(month_start, currency, category_id_key)`,
    },
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
      columns: `(account_id, currency)`,
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
          // Fall back to non-concurrent if the view has no unique index or was never
          // populated. Match case-insensitively: Postgres phrases the unpopulated case as
          // "CONCURRENTLY cannot be used when the materialized view is not populated"
          // (uppercase CONCURRENTLY, "is not populated") — a case-sensitive substring check
          // missed it, so the first refresh after an initdb-loaded dump kept failing.
          const msg = (err.message || '').toLowerCase();
          if (
            msg.includes('not populated') ||
            msg.includes('has not been populated') ||
            msg.includes('cannot refresh materialized view') ||
            msg.includes('concurrently')
          ) {
            logger.warn(`Falling back to non-concurrent refresh for ${view}`);
            return query(`REFRESH MATERIALIZED VIEW ${view}`);
          }
          // Any other error is a real refresh failure — re-throw so the outer
          // catch logs it. Swallowing it here let refreshMaterializedViews
          // resolve "successfully" while leaving a stale view in place.
          logger.warn(`Failed to refresh ${view}`, { error: err.message });
          throw err;
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
 *
 * Trailing 5s debounce: the previous 1s window only coalesced edits made
 * <1s apart, so human editing cadence (a save every few seconds) paid the
 * full four-view rebuild — two of them all-time aggregates — per edit.
 * The 10s max-wait guarantees a machine-cadence mutation stream (steady
 * writes <5s apart, e.g. an importer) still flushes instead of deferring
 * the refresh indefinitely.
 */
export const REFRESH_DEBOUNCE_MS = 5000;
export const REFRESH_MAX_WAIT_MS = 10000;

let debounceTimer = null;
let debounceDeadline = null; // epoch ms the current burst must flush by

export function scheduleRefresh() {
  const now = Date.now();
  if (debounceTimer) clearTimeout(debounceTimer);
  if (debounceDeadline === null) debounceDeadline = now + REFRESH_MAX_WAIT_MS;
  const delay = Math.max(0, Math.min(REFRESH_DEBOUNCE_MS, debounceDeadline - now));
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    debounceDeadline = null;
    refreshMaterializedViews().catch(err => {
      logger.warn('Debounced materialized view refresh failed', { error: err.message });
    });
  }, delay);
}

export default { createMaterializedViews, refreshMaterializedViews, scheduleRefresh };
