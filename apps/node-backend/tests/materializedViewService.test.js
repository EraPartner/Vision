import { afterEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

async function loadMaterializedViewService() {
  vi.resetModules();

  const query = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // Refresh statements run on a dedicated client with the pool-wide
  // statement_timeout lifted. Record every client statement in clientSql, but
  // delegate the actual REFRESH statements to the same `query` spy so the
  // in-flight/debounce tests keep asserting one call per refresh statement.
  const clientSql = [];
  const release = vi.fn();
  const getClient = vi.fn(async () => ({
    query: (sql) => {
      clientSql.push(sql);
      if (/statement_timeout/i.test(sql)) return Promise.resolve({ rows: [] });
      return query(sql);
    },
    release,
  }));

  vi.doMock("../src/database/connection.js", () =>
    mockConnection({ query, getClient }),
  );
  vi.doMock("../src/config/logger.js", () => ({ logger }));
  const invalidateStatisticsCaches = vi.fn();
  vi.doMock("../src/services/info/cache.js", () => ({
    invalidateStatisticsCaches,
  }));

  const service = await import("../src/services/materializedViewService.js");
  return {
    ...service,
    query,
    logger,
    getClient,
    clientSql,
    release,
    invalidateStatisticsCaches,
  };
}

describe("materializedViewService", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("falls back to non-concurrent refresh when concurrent refresh fails", async () => {
    const { refreshMaterializedViews, query, logger } =
      await loadMaterializedViewService();

    query.mockImplementation((sql) => {
      if (sql.includes("REFRESH MATERIALIZED VIEW CONCURRENTLY")) {
        return Promise.reject(
          new Error("cannot refresh materialized view concurrently"),
        );
      }
      return Promise.resolve({ rows: [] });
    });

    await refreshMaterializedViews();

    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls).toContain(
      "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_summary",
    );
    expect(sqlCalls).toContain("REFRESH MATERIALIZED VIEW mv_monthly_summary");
    expect(logger.warn).toHaveBeenCalledWith(
      "Falling back to non-concurrent refresh for mv_monthly_summary",
    );
  });

  it("lifts the pool statement_timeout around each refresh and restores it after", async () => {
    const { refreshMaterializedViews, query, clientSql, release } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await refreshMaterializedViews();

    // Each view's refresh is bracketed by SET 0 / RESET on its dedicated client.
    const firstRefreshIdx = clientSql.findIndex((sql) =>
      sql.includes("REFRESH MATERIALIZED VIEW"),
    );
    expect(firstRefreshIdx).toBeGreaterThan(-1);
    expect(
      clientSql.filter((sql) => sql === "SET statement_timeout = 0"),
    ).toHaveLength(3);
    expect(
      clientSql.filter((sql) => sql === "RESET statement_timeout"),
    ).toHaveLength(3);
    expect(clientSql[firstRefreshIdx - 1]).toBe("SET statement_timeout = 0");
    // Clients go back to the pool healthy (no destructive release).
    expect(release).toHaveBeenCalledTimes(3);
    expect(release).not.toHaveBeenCalledWith(true);
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
    const pendingResolvers = [];
    let callCount = 0;

    query.mockImplementation(() => {
      callCount += 1;
      if (callCount <= 3) {
        return new Promise((resolve) => {
          pendingResolvers.push(resolve);
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const firstRefresh = refreshMaterializedViews();
    await refreshMaterializedViews();
    // Flush the microtask hops (getClient + SET statement_timeout) that now
    // precede each REFRESH statement.
    await vi.advanceTimersByTimeAsync(0);

    expect(query).toHaveBeenCalledTimes(3);

    pendingResolvers.forEach((resolve) => resolve({ rows: [] }));
    await firstRefresh;

    await vi.advanceTimersByTimeAsync(500);

    expect(query).toHaveBeenCalledTimes(6);
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
    expect(query).toHaveBeenCalledTimes(3);
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
    expect(query).toHaveBeenCalledTimes(3);

    // The burst state resets: the next lone call waits the full trailing window again.
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS - 1);
    expect(query).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(6);
  });

  it("creates materialized views and indexes in expected order", async () => {
    const { createMaterializedViews, query, logger } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await createMaterializedViews();

    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(
      sqlCalls.some((sql) =>
        sql.includes(
          "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_monthly_summary AS",
        ),
      ),
    ).toBe(true);
    expect(
      sqlCalls.some((sql) =>
        sql.includes(
          "CREATE UNIQUE INDEX IF NOT EXISTS mv_monthly_summary_idx",
        ),
      ),
    ).toBe(true);
    expect(
      sqlCalls.some((sql) =>
        sql.includes(
          "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_category_totals",
        ),
      ),
    ).toBe(true);
    expect(
      sqlCalls.some((sql) =>
        sql.includes(
          "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cashflow_daily",
        ),
      ),
    ).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/^Materialized views ready in \d+ms$/),
    );
  });

  // Creation is the same full aggregation scan the refresh is, so it must not run
  // under the pool's 30s statement_timeout either: on a large install the CREATE
  // would be cancelled and — now that creation is deferred past listen and no
  // longer aborts boot — the views would silently never get built.
  it("builds the views with the pool statement_timeout lifted", async () => {
    const { createMaterializedViews, query, clientSql } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await createMaterializedViews();

    expect(clientSql).toContain("SET statement_timeout = 0");
    expect(
      clientSql.some((sql) =>
        sql.includes(
          "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_monthly_summary AS",
        ),
      ),
    ).toBe(true);
    expect(
      clientSql.filter((sql) => sql === "RESET statement_timeout"),
    ).not.toHaveLength(0);
  });

  // The boot-wide ANALYZE in main.js runs pre-listen, so it no longer covers
  // views created afterwards — and a matview is never auto-analyzed.
  it("analyzes each view after creating it", async () => {
    const { createMaterializedViews, query } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await createMaterializedViews();

    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls).toContain("ANALYZE mv_monthly_summary");
    expect(sqlCalls).toContain("ANALYZE mv_category_totals");
    expect(sqlCalls).toContain("ANALYZE mv_cashflow_daily");
  });

  // Guard for the canonical 3-level effective-category resolution (own →
  // recipient default → PRIMARY recipient's default). Both category-bearing MVs
  // used to resolve only two levels, so a row recorded under an alias whose
  // PRIMARY carries the default category was counted as UNCATEGORISED here
  // while the transactions list showed it categorised. Changing either
  // definition needs a DROP migration (0084 / 0085) — see the DB-backed
  // assertion in tests/aliasCategoryResolution.db.test.js.
  it("resolves the effective category over three levels in both category-bearing views", async () => {
    const { createMaterializedViews, query } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await createMaterializedViews();

    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    for (const view of ["mv_monthly_summary", "mv_category_totals"]) {
      const ddl = sqlCalls.find((sql) =>
        sql.includes(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${view}`),
      );
      expect(ddl, `${view} DDL`).toContain(
        "LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id",
      );
      expect(ddl, `${view} category join`).toContain(
        "COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id",
      );
    }
  });

  it("no longer creates the dead mv_bank_balances view (dropped — zero readers)", async () => {
    const { createMaterializedViews, query } =
      await loadMaterializedViewService();
    query.mockResolvedValue({ rows: [] });

    await createMaterializedViews();

    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls.some((sql) => sql.includes("mv_bank_balances"))).toBe(
      false,
    );
  });

  it("ensures indexes and warns when one creation fails", async () => {
    const { ensureMaterializedViewIndexes, query, logger } =
      await loadMaterializedViewService();
    query.mockImplementation((sql) => {
      if (sql.includes("mv_cashflow_daily_idx")) {
        return Promise.reject(new Error("index create denied"));
      }
      return Promise.resolve({ rows: [] });
    });

    await ensureMaterializedViewIndexes();

    expect(query).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      "Could not create index mv_cashflow_daily_idx on mv_cashflow_daily",
      { error: "index create denied" },
    );
  });
});
