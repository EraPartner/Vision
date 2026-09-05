import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

vi.mock("../src/database/connection.js", () =>
  mockConnection({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    queryPrepared: vi.fn().mockResolvedValue({ rows: [] }),
    withTransaction: vi.fn(),
  }),
);

import {
  query,
  queryPrepared,
  withTransaction,
} from "../src/database/connection.js";
import transactionRepository, {
  clearTransactionCountCache,
} from "../src/repositories/transactionRepository.js";

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  queryPrepared.mockReset();
  queryPrepared.mockResolvedValue({ rows: [], rowCount: 0 });
  withTransaction.mockReset();
  clearTransactionCountCache();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Regression: LIMIT/OFFSET pagination must carry a unique final tiebreaker
 * (t.id DESC). Without it, same-date rows can be duplicated or skipped across
 * separate page queries because Postgres gives no order among equal sort keys.
 */
describe("transaction list ORDER BY tiebreaker", () => {
  it("getAllWithCount default sort ends with t.id DESC", async () => {
    await transactionRepository.getAllWithCount({ limit: 50, offset: 0 });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("ORDER BY t.date DESC, t.id DESC");
  });

  it("getAllWithCount custom sort still appends t.id DESC", async () => {
    await transactionRepository.getAllWithCount({
      limit: 50,
      offset: 0,
      sortBy: "amount",
      sortDir: "asc",
    });
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY .+, t\.date DESC, t\.id DESC/);
  });

  it.each(["getAll", "getAllWithCount"])(
    "%s partitions requested balances by account and currency",
    async (method) => {
      await transactionRepository[method]({ includeBalance: true });
      const sql = query.mock.calls[0][0];
      expect(sql).toContain(
        "SUM(t.amount) OVER (PARTITION BY t.account_id, COALESCE(t.currency, 'EUR') ORDER BY t.date ASC, t.id ASC) AS running_balance",
      );
    },
  );

  it("getAllWithCount count query uses only the recipient join needed by filters", async () => {
    await transactionRepository.getAllWithCount({ recipientName: "shop" });

    const countSql = query.mock.calls[1][0];
    expect(countSql).toContain(
      "LEFT JOIN recipients r ON t.recipient_id = r.id",
    );
    expect(countSql).not.toContain("LEFT JOIN recipients pr");
    expect(countSql).not.toContain("LEFT JOIN categories");
    expect(countSql).not.toContain("LEFT JOIN accounts");
  });

  it("getUncategorisedWithCount paginates with a t.id DESC tiebreaker", async () => {
    await transactionRepository.getUncategorisedWithCount({
      limit: 50,
      offset: 0,
    });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("ORDER BY t.date DESC, t.id DESC");
  });

  it("getUncategorisedWithCount honours a custom sort in both pagination layers", async () => {
    await transactionRepository.getUncategorisedWithCount({
      limit: 50,
      offset: 0,
      sortBy: "amount",
      sortDir: "asc",
    });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain(
      "ROW_NUMBER() OVER (ORDER BY t.amount ASC, t.date DESC, t.id DESC)",
    );
    expect(sql).toContain("ORDER BY t.amount ASC, t.date DESC, t.id DESC");
    expect(sql).toContain("ORDER BY u._row_order NULLS LAST");
  });

  it("getUncategorisedWithCount includes the per-account running balance on request", async () => {
    await transactionRepository.getUncategorisedWithCount({
      includeBalance: true,
    });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain(
      "SUM(t.amount) OVER (PARTITION BY t.account_id, COALESCE(t.currency, 'EUR') ORDER BY t.date ASC, t.id ASC) AS running_balance",
    );
  });
});

describe("transaction import field dedup contract", () => {
  it("normalizes ASCII memo whitespace and treats a deleted batch as a different batch", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 77 }] });

    await expect(
      transactionRepository.findImportDuplicate({
        date: "2026-08-31",
        amount: "-5.0000",
        recipientId: 4,
        memo: "coffee",
        accountId: 8,
        currency: "EUR",
        txHash: "incoming-hash",
        batchId: 9,
      }),
    ).resolves.toBe(77);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("BTRIM(t.memo, E' \\t\\n\\r\\f\\013')");
    expect(sql).not.toContain("\\v");
    expect(sql).toContain("t.import_batch_id IS DISTINCT FROM $7");
    expect(sql).not.toContain("NOT (t.import_batch_id = $7");
    expect(params).toEqual([
      "2026-08-31",
      "-5.0000",
      4,
      "coffee",
      8,
      "incoming-hash",
      9,
      "EUR",
    ]);
  });
});

describe("transaction list count cache", () => {
  function stubListQueries(total = 7) {
    query.mockImplementation(async (sql) =>
      /SELECT COUNT\(\*\)::int AS total/.test(sql)
        ? { rows: [{ total }] }
        : { rows: [] },
    );
  }

  const countCalls = () =>
    query.mock.calls.filter(([sql]) =>
      /SELECT COUNT\(\*\)::int AS total/.test(sql),
    );

  it("reuses one filtered count across page and page-size changes", async () => {
    stubListQueries(87);

    const first = await transactionRepository.getAllWithCount({
      search: "rent",
      limit: 25,
      offset: 0,
    });
    const second = await transactionRepository.getAllWithCount({
      search: "rent",
      limit: 50,
      offset: 25,
    });

    expect(first.total).toBe(87);
    expect(second.total).toBe(87);
    expect(countCalls()).toHaveLength(1);
  });

  it("keeps a slow in-flight count single-flight beyond the resolved-value TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    let resolveCount;
    const pendingCount = new Promise((resolve) => {
      resolveCount = resolve;
    });
    query.mockImplementation(async (sql) => {
      if (/SELECT COUNT\(\*\)::int AS total/.test(sql)) return pendingCount;
      return { rows: [] };
    });

    const first = transactionRepository.getAllWithCount({
      search: "rent",
      limit: 25,
      offset: 0,
    });
    expect(countCalls()).toHaveLength(1);

    vi.setSystemTime(new Date("2026-08-31T12:00:05Z"));
    const second = transactionRepository.getAllWithCount({
      search: "rent",
      limit: 25,
      offset: 25,
    });
    expect(countCalls()).toHaveLength(1);
    resolveCount({ rows: [{ total: 12 }] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { rows: [], total: 12 },
      { rows: [], total: 12 },
    ]);
  });

  it("refreshes a filtered count after its short time-to-live expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    stubListQueries(5);

    await transactionRepository.getAllWithCount({ search: "rent" });
    vi.setSystemTime(new Date("2026-08-31T12:00:01.999Z"));
    await transactionRepository.getAllWithCount({ search: "rent", offset: 50 });
    expect(countCalls()).toHaveLength(1);

    vi.setSystemTime(new Date("2026-08-31T12:00:02.000Z"));
    await transactionRepository.getAllWithCount({
      search: "rent",
      offset: 100,
    });
    expect(countCalls()).toHaveLength(2);
  });

  it("separates distinct filters and evicts rejected counts", async () => {
    let failRent = true;
    query.mockImplementation(async (sql, params) => {
      if (!/SELECT COUNT\(\*\)::int AS total/.test(sql)) return { rows: [] };
      if (params.includes("%rent%") && failRent) {
        failRent = false;
        throw new Error("count failed");
      }
      return { rows: [{ total: params.includes("%rent%") ? 3 : 4 }] };
    });

    await expect(
      transactionRepository.getAllWithCount({ search: "rent" }),
    ).rejects.toThrow("count failed");
    await expect(
      transactionRepository.getAllWithCount({ search: "rent" }),
    ).resolves.toMatchObject({ total: 3 });
    await expect(
      transactionRepository.getAllWithCount({ search: "salary" }),
    ).resolves.toMatchObject({ total: 4 });
    expect(countCalls()).toHaveLength(3);
  });

  it("invalidates cached counts after a successful hard delete", async () => {
    stubListQueries(5);
    await transactionRepository.getAllWithCount({ active: true });
    await transactionRepository.getAllWithCount({ active: true, offset: 50 });
    expect(countCalls()).toHaveLength(1);

    queryPrepared.mockResolvedValueOnce({ rows: [{ id: 9 }], rowCount: 1 });
    await expect(transactionRepository.hardDelete(9)).resolves.toBe(true);
    await transactionRepository.getAllWithCount({ active: true });

    expect(countCalls()).toHaveLength(2);
  });

  it("invalidates tag-filtered counts after a tags-only update", async () => {
    stubListQueries(5);
    await transactionRepository.getAllWithCount({ tagSlugs: ["food"] });
    expect(countCalls()).toHaveLength(1);

    const client = {
      query: vi.fn(async (sql) => {
        if (sql.startsWith("SELECT 1 FROM transactions")) {
          return { rows: [{ exists: 1 }] };
        }
        if (sql.startsWith("SELECT id FROM tags")) {
          return { rows: [{ id: 3 }] };
        }
        if (sql.includes("FROM transactions t")) {
          return { rows: [{ id: 9 }] };
        }
        return { rows: [] };
      }),
    };
    withTransaction.mockImplementation(async (fn) => fn(client));
    await expect(
      transactionRepository.update(9, { tags: ["food"] }),
    ).resolves.toMatchObject({ id: 9, tags: [] });
    await transactionRepository.getAllWithCount({ tagSlugs: ["food"] });

    expect(countCalls()).toHaveLength(2);
  });
});

describe("tags-only PATCH on a missing transaction", () => {
  it("returns null (→ 404) by probing existence before the tag-junction insert", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    withTransaction.mockImplementation(async (fn) => fn(client));

    const result = await transactionRepository.update(999, { tags: ["food"] });

    expect(result).toBeNull();
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(
      sqls.some((s) => s.includes("SELECT 1 FROM transactions WHERE id = $1")),
    ).toBe(true);
    // The FK-violating junction INSERT must NOT run (that was the 500 source).
    expect(sqls.some((s) => s.includes("INSERT INTO transaction_tags"))).toBe(
      false,
    );
  });
});
