/**
 * Materialized-view tables (ADR-263).
 *
 * `mv_monthly_summary` and `mv_category_totals` pre-compute two expensive
 * dashboard aggregations. On PostgreSQL they were materialized views; on
 * SQLite they are ordinary baseline tables (db/migrations/0001_baseline.sql)
 * that this module refills from their defining SELECTs.
 *
 * A refill is `DELETE` + `INSERT ... SELECT` inside one `withTransaction()`:
 * readers outside the transaction use the reader connection, which sees the
 * last committed state, so they see either the old or the new contents and
 * never an empty table mid-refill. That is what `REFRESH ... CONCURRENTLY`
 * guaranteed. Both tables refill in the same transaction, so they always
 * describe the same ledger state.
 *
 * The whole lifecycle runs post-`listen` from startup/warmup.ts — none of it is
 * on the critical path to `/health`, because a refill is a full aggregation
 * scan of `transactions`.
 */

import { query, withTransaction } from "../database/connection.ts";
import { logger } from "../config/logger.ts";
import { invalidateStatisticsCaches } from "./info/cache.ts";

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

interface ManagedView {
  name: "mv_monthly_summary" | "mv_category_totals";
  /** INSERT ... SELECT that fills the empty table. */
  fill: string;
  /** The unique index the baseline defines on it. */
  index: { name: string; columns: string };
}

/**
 * Monthly income / spending / net per local calendar month (last 12 months
 * plus the current one), per currency and effective category. The effective
 * category resolves 3 levels (own → recipient default → PRIMARY recipient's
 * default) so the table's category grain agrees with the monthly live path
 * and the transactions surfaces. Totals are exact (dec_sum); month_start is
 * the DATE of the month's first day.
 */
const MONTHLY_SUMMARY_FILL = `
    INSERT INTO mv_monthly_summary (
      month_start, month, year, currency, transaction_count,
      total_income, total_spending, net_amount,
      category_id, category_id_key, category_name
    )
    SELECT
      date_trunc('month', t.date) AS month_start,
      date_part('month', t.date) AS month,
      date_part('year', t.date) AS year,
      t.currency,
      count(*) AS transaction_count,
      dec_sum(CASE WHEN dec_sign(t.amount) >= 0 THEN t.amount ELSE 0 END) AS total_income,
      dec_sum(CASE WHEN dec_sign(t.amount) < 0 THEN t.amount ELSE 0 END) AS total_spending,
      dec_sum(t.amount) AS net_amount,
      c.id AS category_id,
      COALESCE(c.id, -1) AS category_id_key,
      COALESCE(c.path_name, 'UNCATEGORISED') AS category_name
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id
    WHERE t.is_active = 1 AND t.is_transfer = 0
      AND t.date >= add_months(date_trunc('month', today()), -12)
    GROUP BY date_trunc('month', t.date), date_part('month', t.date), date_part('year', t.date),
             t.currency, c.id, COALESCE(c.path_name, 'UNCATEGORISED')
    ORDER BY month_start
  `;

/**
 * Category totals (all-time), per currency. Effective category resolves 3
 * levels (own → recipient default → PRIMARY recipient's default) so the fast
 * path agrees with getCategoryBreakdown's live fallback and the transactions
 * surfaces.
 */
const CATEGORY_TOTALS_FILL = `
    INSERT INTO mv_category_totals (category_id, name, count, total, currency)
    SELECT
      COALESCE(c.id, -1) AS category_id,
      COALESCE(c.path_name, 'UNCATEGORISED') AS name,
      count(*) AS count,
      dec_sum(t.amount) AS total,
      t.currency
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id
    WHERE t.is_active = 1 AND t.is_transfer = 0
    GROUP BY
      COALESCE(c.id, -1),
      COALESCE(c.path_name, 'UNCATEGORISED'),
      t.currency
    ORDER BY count(*) DESC
  `;

const MANAGED_VIEWS: readonly ManagedView[] = [
  {
    name: "mv_monthly_summary",
    fill: MONTHLY_SUMMARY_FILL,
    index: { name: "idx_mv_monthly_summary", columns: "(month_start, currency, category_id_key)" },
  },
  {
    name: "mv_category_totals",
    fill: CATEGORY_TOTALS_FILL,
    index: { name: "idx_mv_category_totals", columns: "(category_id, currency)" },
  },
];

/** Replace a view table's contents; call inside withTransaction(). */
async function refill(view: ManagedView): Promise<void> {
  await query(`DELETE FROM ${view.name}`);
  await query(view.fill);
}

/**
 * Fill every view table that holds no rows (idempotent).
 *
 * The tables exist from the baseline migration. PostgreSQL's
 * `CREATE MATERIALIZED VIEW IF NOT EXISTS` populated a view when it was
 * created and left an existing one alone; the equivalent here is to fill an
 * empty table and keep a populated one (the previous launch's aggregates,
 * which serve the first screen until the refresh replaces them).
 *
 * Called from the post-listen warmup (startup/warmup.ts), never before
 * `app.listen()`: on a first boot each fill is a full aggregation scan of
 * `transactions`.
 */
export async function createMaterializedViews() {
  logger.info("Filling empty materialized-view tables…");
  const start = Date.now();
  await withTransaction(async () => {
    for (const view of MANAGED_VIEWS) {
      // Checked inside the write transaction, so a concurrent refresh cannot
      // fill the table between the check and the fill.
      const existing = await query(`SELECT 1 FROM ${view.name} LIMIT 1`);
      if (existing.rows.length === 0) await refill(view);
    }
  });
  // Give freshly filled tables planner statistics (sqlite_stat1), as the
  // PostgreSQL build analyzed each view after creating it. Best effort: the
  // tables are tiny, and stale stats must not fail warmup.
  await Promise.all(
    MANAGED_VIEWS.map(({ name }) =>
      query(`ANALYZE ${name}`).catch((err: unknown) => {
        logger.warn(`Could not ANALYZE ${name}`, { error: errorMessage(err) });
      }),
    ),
  );
  logger.info(`Materialized views ready in ${Date.now() - start}ms`);
}

/**
 * Ensure the unique indexes exist (idempotent). The baseline creates them;
 * this keeps a database whose index was dropped by hand from silently
 * accepting duplicate rows. A failure is logged and does not stop warmup.
 */
export async function ensureMaterializedViewIndexes() {
  for (const { name, index } of MANAGED_VIEWS) {
    try {
      await query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${index.name} ON ${name} ${index.columns}`,
      );
    } catch (err) {
      logger.warn(`Could not create index ${index.name} on ${name}`, {
        error: errorMessage(err),
      });
    }
  }
}

let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

/**
 * Refill both materialized-view tables in one transaction.
 * Coalesces rapid-fire calls (e.g. bulk import) into a single refresh.
 */
export async function refreshMaterializedViews(): Promise<void> {
  // Clear the statistics-pivot cache at refresh start so ordinary scheduled
  // mutations do not serve the pre-mutation figures for the TTL.
  invalidateStatisticsCaches();
  if (refreshInFlight) {
    refreshQueued = true;
    return refreshInFlight;
  }

  const start = Date.now();
  const refresh = (async () => {
    // One write transaction refills both tables: readers keep seeing the
    // previous contents until COMMIT, then the new ones (never an empty table).
    await withTransaction(async () => {
      for (const view of MANAGED_VIEWS) {
        try {
          await refill(view);
        } catch (err) {
          // A failed refill rolls the whole refresh back, so the tables keep
          // their previous contents; re-throw so the outer catch logs it.
          logger.warn(`Failed to refresh ${view.name}`, { error: errorMessage(err) });
          throw err;
        }
      }
    });
    // A request can repopulate the process cache from the old contents while
    // the refresh is running. Clear it again after the new contents are
    // committed so that race cannot outlive the refresh.
    invalidateStatisticsCaches();
    logger.info(`Materialized views refreshed in ${Date.now() - start}ms`);
  })();
  refreshInFlight = refresh;

  try {
    await refresh;
  } catch (err) {
    logger.error("Materialized view refresh failed", {
      error: err instanceof Error ? err.message : undefined,
    });
    throw err;
  } finally {
    if (refreshInFlight === refresh) refreshInFlight = null;
    if (refreshQueued) {
      refreshQueued = false;
      // Schedule deferred refresh; swallow rejection so unhandled promises do not crash the process.
      setTimeout(() => {
        refreshMaterializedViews().catch((err: unknown) => {
          logger.warn("Deferred materialized view refresh failed", {
            error: errorMessage(err),
          });
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
 * full three-view rebuild — including the all-time category aggregate — per edit.
 * The 10s max-wait guarantees a machine-cadence mutation stream (steady
 * writes <5s apart, e.g. an importer) still flushes instead of deferring
 * the refresh indefinitely.
 */
export const REFRESH_DEBOUNCE_MS = 5000;
export const REFRESH_MAX_WAIT_MS = 10000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let debounceDeadline: number | null = null; // epoch ms the current burst must flush by

export function scheduleRefresh() {
  // Category/recipient renames, single-row imports, the DB editor, and the
  // transaction-reconcile tail all reach here — clear the statistics-pivot cache
  // synchronously (the MV refresh itself is debounced, but the cache must drop
  // now so the next statistics request recomputes against the mutated data).
  invalidateStatisticsCaches();
  const now = Date.now();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceDeadline ??= now + REFRESH_MAX_WAIT_MS;
  const delay = Math.max(
    0,
    Math.min(REFRESH_DEBOUNCE_MS, debounceDeadline - now),
  );
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    debounceDeadline = null;
    refreshMaterializedViews().catch((err: unknown) => {
      logger.warn("Debounced materialized view refresh failed", {
        error: errorMessage(err),
      });
    });
  }, delay);
}

export default {
  createMaterializedViews,
  refreshMaterializedViews,
  scheduleRefresh,
};
