import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import { txRow } from "./helpers/pgRows.ts";

vi.mock("../src/database/connection.ts", () =>
  mockConnection({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    queryPrepared: vi.fn().mockResolvedValue({ rows: [] }),
    withTransaction: vi.fn(),
  }),
);

import {
  query as rawQuery,
  queryPrepared as rawQueryPrepared,
  withTransaction as rawWithTransaction,
} from "../src/database/connection.ts";
import transactionRepository, {
  clearTransactionCountCache,
} from "../src/repositories/transactionRepository.ts";

/** The structural slice of pg's query surface these fakes implement. */
interface FakeResult {
  rows: Record<string, unknown>[];
  rowCount?: number;
}
type FakeQuery = (sql: string, params: unknown[]) => Promise<FakeResult>;
interface FakeClient {
  query: Mock<(sql: string) => Promise<FakeResult>>;
}

const query = rawQuery as unknown as Mock<FakeQuery>;
const queryPrepared = rawQueryPrepared as unknown as Mock<
  (name: string, text: string, params?: unknown[]) => Promise<FakeResult>
>;
const withTransaction = rawWithTransaction as unknown as Mock<
  (fn: (client: FakeClient) => Promise<unknown>) => Promise<unknown>
>;

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
    let resolveCount!: (value: FakeResult) => void;
    const pendingCount = new Promise<FakeResult>((resolve) => {
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

    withTransaction.mockImplementation(async (fn) =>
      fn({
        query: vi.fn().mockImplementation(async (sql: string) => ({
          rows: sql.includes("FROM accounts")
            ? [{ id: 1, is_active: true }]
            : [{ id: 9, account_id: 1 }],
          rowCount: 1,
        })),
      }),
    );
    await expect(transactionRepository.hardDelete(9)).resolves.toBe(true);
    await transactionRepository.getAllWithCount({ active: true });

    expect(countCalls()).toHaveLength(2);
  });

  it("invalidates tag-filtered counts after a tags-only update", async () => {
    stubListQueries(5);
    await transactionRepository.getAllWithCount({ tagSlugs: ["food"] });
    expect(countCalls()).toHaveLength(1);

    const client = {
      query: vi.fn(async (sql: string): Promise<FakeResult> => {
        if (sql.startsWith("SELECT 1 FROM transactions")) {
          return { rows: [{ exists: 1 }] };
        }
        if (sql.startsWith("SELECT id FROM tags")) {
          return { rows: [{ id: 3 }] };
        }
        if (sql.includes("FROM transactions t")) {
          return { rows: [txRow({ id: 9 })] };
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
