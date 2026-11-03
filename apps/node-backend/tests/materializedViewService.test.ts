import { afterEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";

/**
 * The materialized-view tables are ordinary SQLite tables (ADR-263) refilled
 * with DELETE + INSERT ... SELECT inside one withTransaction(). The mock logs
 * every statement and the transaction boundaries ("BEGIN", "COMMIT",
 * "ROLLBACK") into one ordered list, so the tests can assert what ran inside
 * the write transaction. The DB-backed reader guarantee (old or new contents,
 * never empty) is tested in tests/startupMaterializedViews.db.test.ts.
 */
async function loadMaterializedViewService() {
  vi.resetModules();

  const query = vi.fn<(sql: string) => Promise<unknown>>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const statements: string[] = [];
  const loggedQuery = (sql: string) => {
    statements.push(sql.replace(/\s+/g, " ").trim());
    return query(sql);
  };
  const withTransaction = vi.fn(async (fn: () => Promise<unknown>) => {
    statements.push("BEGIN");
    try {
      const result = await fn();
      statements.push("COMMIT");
      return result;
    } catch (err) {
      statements.push("ROLLBACK");
      throw err;
    }
  });

  vi.doMock("../src/database/connection.ts", () =>
    mockConnection({ query: loggedQuery, withTransaction }),
  );
  vi.doMock("../src/config/logger.ts", () => ({ logger }));
  const invalidateStatisticsCaches = vi.fn();
  vi.doMock("../src/services/info/cache.ts", () => ({
    invalidateStatisticsCaches,
  }));

  const service = await import("../src/services/materializedViewService.ts");
  return {
    ...service,
    query,
    logger,
    statements,
    withTransaction,
    invalidateStatisticsCaches,
  };
}

/** A statement's leading words, e.g. "DELETE FROM mv_monthly_summary". */
function head(sql: string): string {
  const m = /^(BEGIN|COMMIT|ROLLBACK|DELETE FROM \w+|INSERT INTO \w+|SELECT 1 FROM \w+|ANALYZE \w+|CREATE UNIQUE INDEX IF NOT EXISTS \w+)/.exec(sql);
  return m?.[1] ?? sql;
}

const REFILL_BOTH = [
  "BEGIN",
  "DELETE FROM mv_monthly_summary",
  "INSERT INTO mv_monthly_summary",
  "DELETE FROM mv_category_totals",
  "INSERT INTO mv_category_totals",
  "COMMIT",
];

describe("materializedViewService", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  // Replaces the PostgreSQL REFRESH ... CONCURRENTLY (and its non-concurrent
  // fallback) tests: readers never see an empty table because the DELETE and
  // the refill commit together.
  it("refills both tables with DELETE + INSERT ... SELECT inside one transaction", async () => {
    const { refreshMaterializedViews, query, statements, withTransaction } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await refreshMaterializedViews();

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(statements.map(head)).toEqual(REFILL_BOTH);
    expect(statements.some((sql) => /REFRESH|MATERIALIZED VIEW/i.test(sql))).toBe(false);
  });

  // Replaces the statement_timeout test: SQLite has no statement timeout to
  // lift, so a long refill can no longer be cancelled half-way.
  it("does not touch a statement timeout or a dedicated client", async () => {
    const { refreshMaterializedViews, query, statements } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await refreshMaterializedViews();

    expect(statements.some((sql) => /statement_timeout/i.test(sql))).toBe(false);
  });

  it("rolls the whole refresh back when one refill fails, keeping the previous contents", async () => {
    const { refreshMaterializedViews, query, statements, logger } =
      await loadMaterializedViewService();
    query.mockImplementation((sql) =>
      /INSERT INTO mv_category_totals/.test(sql)
        ? Promise.reject(new Error("disk I/O error"))
        : Promise.resolve({ rows: [] }),
    );

    await expect(refreshMaterializedViews()).rejects.toThrow("disk I/O error");

    // mv_monthly_summary's refill ran in the same transaction, so the
    // rollback restores both tables: they always describe one ledger state.
    expect(statements.map(head)).toEqual([
      "BEGIN",
      "DELETE FROM mv_monthly_summary",
      "INSERT INTO mv_monthly_summary",
      "DELETE FROM mv_category_totals",
      "INSERT INTO mv_category_totals",
      "ROLLBACK",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to refresh mv_category_totals",
      { error: "disk I/O error" },
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Materialized view refresh failed",
      { error: "disk I/O error" },
    );
  });

  it("invalidates statistics caches before and after a successful refresh", async () => {
    const { refreshMaterializedViews, query, invalidateStatisticsCaches } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await refreshMaterializedViews();

    expect(invalidateStatisticsCaches).toHaveBeenCalledTimes(2);
  });

  it("queues one deferred refresh while a refresh is in flight", async () => {
    vi.useFakeTimers();

    const { refreshMaterializedViews, query } =
      await loadMaterializedViewService();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callCount = 0;

    query.mockImplementation(async () => {
      callCount += 1;
      // The first refresh's first statement waits until released.
      if (callCount === 1) await gate;
      return { rows: [] };
    });

    const firstRefresh = refreshMaterializedViews();
    const coalescedRefresh = refreshMaterializedViews();
    const anotherCoalescedRefresh = refreshMaterializedViews();
    await vi.advanceTimersByTimeAsync(0);

    // Only the first refresh is running; the others joined it.
    expect(query).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.all([firstRefresh, coalescedRefresh, anotherCoalescedRefresh]);
    expect(query).toHaveBeenCalledTimes(4);

    // One deferred refresh for all the coalesced calls.
    await vi.advanceTimersByTimeAsync(500);
    expect(query).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(5000);
    expect(query).toHaveBeenCalledTimes(8);
  });

  it("rejects when a table is missing", async () => {
    const { refreshMaterializedViews, query, logger } =
      await loadMaterializedViewService();
    query.mockRejectedValue(new Error("no such table: mv_monthly_summary"));

    await expect(refreshMaterializedViews()).rejects.toThrow("no such table");
    expect(logger.error).toHaveBeenCalledWith(
      "Materialized view refresh failed",
      { error: "no such table: mv_monthly_summary" },
    );
  });

  it("debounces scheduleRefresh calls into one refresh", async () => {
    vi.useFakeTimers();

    const { scheduleRefresh, query, REFRESH_DEBOUNCE_MS } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    scheduleRefresh();
    scheduleRefresh();

    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS - 1);
    expect(query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    // One refresh: DELETE + INSERT per table.
    expect(query).toHaveBeenCalledTimes(4);
  });

  // TODO E20: trailing-only debounce let a steady mutation stream (< debounce
  // apart) defer the refresh indefinitely — the max-wait cap forces a flush.
  it("scheduleRefresh flushes at the max-wait cap under a steady mutation stream", async () => {
    vi.useFakeTimers();

    const { scheduleRefresh, query, REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    // Reschedule every 2s — always inside the 5s trailing window.
    const step = 2000;
    scheduleRefresh();
    for (
      let elapsed = 0;
      elapsed < REFRESH_MAX_WAIT_MS - step;
      elapsed += step
    ) {
      await vi.advanceTimersByTimeAsync(step);
      scheduleRefresh();
    }
    expect(query).not.toHaveBeenCalled();

    // Crossing the 10s deadline flushes even though the last call was < 5s ago.
    await vi.advanceTimersByTimeAsync(step);
    expect(query).toHaveBeenCalledTimes(4);

    // The burst state resets: the next lone call waits the full trailing window again.
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS - 1);
    expect(query).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(8);
  });

  // CREATE MATERIALIZED VIEW IF NOT EXISTS populated a missing view and left
  // an existing one alone: the tables exist from the baseline, so creation
  // fills an empty table and keeps a populated one.
  it("fills empty tables in one transaction, then analyzes them", async () => {
    const { createMaterializedViews, query, statements, logger } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await createMaterializedViews();

    expect(statements.map(head)).toEqual([
      "BEGIN",
      "SELECT 1 FROM mv_monthly_summary",
      "DELETE FROM mv_monthly_summary",
      "INSERT INTO mv_monthly_summary",
      "SELECT 1 FROM mv_category_totals",
      "DELETE FROM mv_category_totals",
      "INSERT INTO mv_category_totals",
      "COMMIT",
      "ANALYZE mv_monthly_summary",
      "ANALYZE mv_category_totals",
    ]);
    expect(statements.some((sql) => sql.includes("mv_cashflow_daily"))).toBe(
      false,
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/^Materialized views ready in \d+ms$/),
    );
  });

  it("keeps a populated table as it is", async () => {
    const { createMaterializedViews, query, statements } =
      await loadMaterializedViewService();
    query.mockImplementation((sql) =>
      Promise.resolve({
        rows: /SELECT 1 FROM mv_category_totals/.test(sql) ? [{ "1": 1 }] : [],
      }),
    );

    await createMaterializedViews();

    const heads = statements.map(head);
    expect(heads).toContain("INSERT INTO mv_monthly_summary");
    expect(heads).not.toContain("DELETE FROM mv_category_totals");
    expect(heads).not.toContain("INSERT INTO mv_category_totals");
  });

  it("does not fail creation when ANALYZE fails", async () => {
    const { createMaterializedViews, query, logger } =
      await loadMaterializedViewService();
    query.mockImplementation((sql) =>
      /^ANALYZE mv_category_totals/.test(sql)
        ? Promise.reject(new Error("database is locked"))
        : Promise.resolve({ rows: [] }),
    );

    await createMaterializedViews();

    expect(logger.warn).toHaveBeenCalledWith(
      "Could not ANALYZE mv_category_totals",
      { error: "database is locked" },
    );
  });

  // Guard for the canonical 3-level effective-category resolution (own →
  // recipient default → PRIMARY recipient's default). Both category-bearing MVs
  // used to resolve only two levels, so a row recorded under an alias whose
  // PRIMARY carries the default category was counted as UNCATEGORISED here
  // while the transactions list showed it categorised. See the DB-backed
  // assertion in tests/aliasCategoryResolution.db.test.ts.
  it("resolves the effective category over three levels in both category-bearing tables", async () => {
    const { refreshMaterializedViews, query, statements } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await refreshMaterializedViews();

    for (const view of ["mv_monthly_summary", "mv_category_totals"]) {
      const fill = statements.find((sql) => sql.startsWith(`INSERT INTO ${view}`));
      expect(fill, `${view} fill`).toContain(
        "LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id",
      );
      expect(fill, `${view} category join`).toContain(
        "COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id",
      );
    }
  });

  // Money totals are exact decimal aggregates and the month grain is the local
  // calendar month of the DATE column.
  it("aggregates with exact decimal sums over local calendar months", async () => {
    const { refreshMaterializedViews, query, statements } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await refreshMaterializedViews();

    const monthly = statements.find((sql) => sql.startsWith("INSERT INTO mv_monthly_summary"));
    expect(monthly).toContain("date_trunc('month', t.date) AS month_start");
    expect(monthly).toContain("dec_sum(t.amount) AS net_amount");
    expect(monthly).toContain("add_months(date_trunc('month', today()), -12)");
    expect(monthly).not.toMatch(/\bSUM\(|CURRENT_DATE|interval/i);
    const totals = statements.find((sql) => sql.startsWith("INSERT INTO mv_category_totals"));
    expect(totals).toContain("dec_sum(t.amount) AS total");
    expect(totals).not.toMatch(/\bSUM\(/);
  });

  it("no longer creates the dead mv_bank_balances view (dropped — zero readers)", async () => {
    const { createMaterializedViews, query, statements } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await createMaterializedViews();

    expect(statements.some((sql) => sql.includes("mv_bank_balances"))).toBe(
      false,
    );
  });

  // The PostgreSQL build also dropped the pre-rename indexes
  // (mv_*_idx); the SQLite baseline never had them, so only the unique
  // indexes are ensured.
  it("ensures indexes and warns when one creation fails", async () => {
    const { ensureMaterializedViewIndexes, query, logger } =
      await loadMaterializedViewService();
    query.mockImplementation((sql) => {
      if (sql.includes("idx_mv_category_totals")) {
        return Promise.reject(new Error("index create denied"));
      }
      return Promise.resolve({ rows: [] });
    });

    await ensureMaterializedViewIndexes();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_monthly_summary ON mv_monthly_summary (month_start, currency, category_id_key)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_category_totals ON mv_category_totals (category_id, currency)",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Could not create index idx_mv_category_totals on mv_category_totals",
      { error: "index create denied" },
    );
  });
});
