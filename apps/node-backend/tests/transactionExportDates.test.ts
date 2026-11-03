import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "kysely";

import { mockLogger } from "./helpers/mockLogger.ts";
import { mockConnection } from "./helpers/repoMocks.ts";
import { makeTransactionRow } from "./builders/domainRows.ts";
// Export date serialization (TODO E11): the CSV column was String(pg Date)
// ("Wed Jul 01 2026 00:00:00 GMT+0200 …" — unusable in Excel, a day off on
// cross-TZ re-import) and buildNdjsonRow went through JSON.stringify's
// toISOString — the PREVIOUS day's timestamp on any backend east of UTC.

vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));
vi.mock("../src/database/connection.ts", () =>
  mockConnection({ withReadSnapshot: vi.fn() }),
);

import {
  getClient as rawGetClient,
  query as rawDbQuery,
  withReadSnapshot as rawWithReadSnapshot,
} from "../src/database/connection.ts";
import type {
  DbClient,
  DbQueryResult,
} from "../src/database/connection.ts";
import {
  streamBulkTransactionExport,
  streamCsvExport,
  streamNdjsonExport,
} from "../src/services/transactionExport.ts";
import type { ExpressResponse } from "../src/types/express.ts";
import { loose, partial } from "./helpers/partial.ts";
import { must } from "./helpers/must.ts";
import { valueAt } from "./helpers/responseBody.ts";

/** The spy behind `obj[key]`, read without taking an unbound method reference. */
function methodMock<T extends object, K extends keyof T>(obj: T, key: K) {
  return vi.mocked(obj)[key];
}

const getClient = vi.mocked(rawGetClient);
const dbQuery = vi.mocked(rawDbQuery);
const withReadSnapshot = vi.mocked(rawWithReadSnapshot);

// A pg DATE arrives as a LOCAL-midnight Date object; this is the shape the
// export must turn back into a plain calendar day regardless of process TZ.
const JULY_FIRST = new Date(2026, 6, 1);

function exportRow(overrides: Record<string, unknown> = {}) {
  return makeTransactionRow({
    date: JULY_FIRST,
    bank_account: "BE12",
    recipient_name: "Shop",
    memo: "memo",
    amount: "-12.50",
    currency: "EUR",
    balance: "100.00",
    category_name: "Food:Groceries",
    comment: null,
    tags: ["a", "b"],
    ...overrides,
  });
}

function mockRes() {
  const chunks: string[] = [];
  const res = {
    chunks,
    setHeader: vi.fn(),
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end: vi.fn(),
    destroy: vi.fn(),
    once: vi.fn(),
    headersSent: true,
  };
  // Only the response members the export stream touches.
  return loose<ExpressResponse & typeof res>(res);
}

function primeQueries(rows: unknown[]) {
  dbQuery
    .mockResolvedValueOnce(
      partial<DbQueryResult>({ rows: [{ "?column?": 1 }] }),
    ) // probe
    .mockResolvedValueOnce(partial<DbQueryResult>({ rows })); // single chunk (< EXPORT_CHUNK_SIZE ends the loop)
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("export date serialization", () => {
  it("builds SQL from a validated route filter model inside the export service", async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamCsvExport(res, {
      filters: {
        accountIds: [3, 9],
        transactionType: "expense",
        active: true,
      },
    });

    expect(must(dbQuery.mock.calls[0], "dbQuery.mock.calls[0]")[0]).toMatch(/t\.account_id IN \(\?, \?\)/);
    expect(must(dbQuery.mock.calls[0], "dbQuery.mock.calls[0]")[0]).toContain("dec_sign(t.amount) < 0");
    expect(must(dbQuery.mock.calls[0], "dbQuery.mock.calls[0]")[1]).toEqual([3, 9]);
  });

  it("destroys and rejects a response when a database failure happens after headers", async () => {
    dbQuery
      .mockResolvedValueOnce(
        partial<DbQueryResult>({ rows: [{ "?column?": 1 }] }),
      )
      .mockRejectedValueOnce(new Error("stream failed"));
    const res = mockRes();

    await expect(
      streamCsvExport(res, { where: sql`1=1` }),
    ).rejects.toThrow("stream failed");
    expect(res.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stream failed" }),
    );
    expect(methodMock(res, "end")).not.toHaveBeenCalled();
  });

  it("CSV emits the calendar day, not String(pg Date)", async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamCsvExport(res, {
      where: sql`1=1`,
    });

    const dataRow = res.chunks[1]; // [0] is the header line
    expect(must(dataRow, "dataRow").startsWith("2026-07-01,")).toBe(true);
    expect(dataRow).not.toMatch(/GMT|Jul/);
  });

  it("CSV running balance is partitioned per account, not one global accumulator", async () => {
    primeQueries([
      exportRow({ id: 1, account_id: 1, amount: "100.00" }),
      exportRow({ id: 2, account_id: 2, amount: "50.00" }),
      exportRow({ id: 3, account_id: 1, amount: "-30.00" }),
    ]);
    const res = mockRes();

    await streamCsvExport(res, {
      where: sql`1=1`,
      includeBalance: true,
    });

    const balances = res.chunks
      .slice(1)
      .map((line) => line.trim().split(",").pop());
    // account 1: 100 → 70; account 2: 50 (not 150/120 from a global sum)
    expect(balances).toEqual(["100", "50", "70"]);
  });

  it("CSV running balance preserves decimal precision beyond the JS safe integer range", async () => {
    primeQueries([
      exportRow({ id: 1, account_id: 1, amount: "9007199254740993.12" }),
      exportRow({ id: 2, account_id: 1, amount: "0.01" }),
    ]);
    const res = mockRes();

    await streamCsvExport(res, {
      where: sql`1=1`,
      includeBalance: true,
    });

    const balances = res.chunks
      .slice(1)
      .map((line) => line.trim().split(",").pop());
    expect(balances).toEqual(["9007199254740993.12", "9007199254740993.13"]);
  });

  it("NDJSON emits the calendar day, not the previous-day ISO timestamp", async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamNdjsonExport(res, {
      where: sql`1=1`,
    });

    const parsed: unknown = JSON.parse(must(res.chunks[0], "res.chunks[0]"));
    expect(valueAt(parsed, "date")).toBe("2026-07-01");
  });
});

describe("export tag aggregation", () => {
  it("CSV joins a multi-tag transaction on the slug-ordered array", async () => {
    primeQueries([exportRow({ tags: ["alpha", "beta", "gamma"] })]);
    const res = mockRes();

    await streamCsvExport(res, {
      where: sql`1=1`,
    });

    // Tags column (10th) preserves order and joins with ';'.
    expect(res.chunks[1]).toContain("alpha;beta;gamma");
  });

  it("NDJSON emits the multi-tag array unchanged", async () => {
    primeQueries([exportRow({ tags: ["alpha", "beta", "gamma"] })]);
    const res = mockRes();

    await streamNdjsonExport(res, {
      where: sql`1=1`,
    });

    expect(valueAt(JSON.parse(must(res.chunks[0], "res.chunks[0]")), "tags")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("fetches each row's active tags in slug order through the transaction_tags primary key", async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamNdjsonExport(res, {
      where: sql`1=1`,
    });

    // dbQuery calls: [0] probe, [1] first chunk.
    const chunkSql = must(dbQuery.mock.calls[1], "dbQuery.mock.calls[1]")[0];
    // Slug ordering + active-only filter preserved, folded by json_group_array
    // (array_agg in PostgreSQL) over a slug-ordered subquery …
    expect(chunkSql).toContain("json_group_array(tag_slugs.slug)");
    expect(chunkSql).toContain("ORDER BY tg.slug");
    expect(chunkSql).toContain("tg.is_active = 1");
    // … per chunk row on the (transaction_id, tag_id) primary key. SQLite would
    // aggregate the whole junction table for a grouped LEFT JOIN on every
    // chunk, which is what the PostgreSQL planner avoided.
    expect(chunkSql).toContain("WHERE tt.transaction_id = t.id");
    expect(chunkSql).not.toContain("GROUP BY tt.transaction_id");
    // The driver parses the JSON array; an untagged row gets [] from
    // json_group_array, as COALESCE(array_agg(...), '{}') gave.
    expect(chunkSql).toContain('AS "tags::json"');
  });
});

describe("bulk export service snapshot", () => {
  /**
   * withReadSnapshot (PostgreSQL's REPEATABLE READ READ ONLY transaction) runs
   * the export on one snapshot client; the real helper opens and closes that
   * connection around the callback whether it resolves or throws.
   */
  function useSnapshotResults(...results: object[]) {
    const query = vi.fn();
    for (const result of results) query.mockResolvedValueOnce(result);
    const client = partial<DbClient>({ query, release: vi.fn() });
    const settled: string[] = [];
    withReadSnapshot.mockImplementation(async (fn) => {
      try {
        const value = await fn(client);
        settled.push("resolved");
        return value;
      } catch (err) {
        settled.push("rejected");
        throw err;
      }
    });
    return { query, settled };
  }

  it("rejects a malformed selector before opening a snapshot", async () => {
    const res = mockRes();

    await expect(
      streamBulkTransactionExport(res, { format: "csv" }),
    ).rejects.toThrow(/either .* or .* must be provided/i);

    expect(withReadSnapshot).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("runs the count, probe and chunks on one read snapshot", async () => {
    const { query, settled } = useSnapshotResults(
      { rows: [{ n: 1 }] },
      { rows: [{ "?column?": 1 }] },
      { rows: [exportRow()] },
    );
    const res = mockRes();

    await streamBulkTransactionExport(res, {
      ids: [1],
      format: "csv",
    });

    expect(withReadSnapshot).toHaveBeenCalledOnce();
    expect(settled).toEqual(["resolved"]);
    // Every statement ran on the snapshot client, none on the shared reader.
    expect(query).toHaveBeenCalledTimes(3);
    expect(dbQuery).not.toHaveBeenCalled();
    expect(must(query.mock.calls[0], "query.mock.calls[0]")[0]).toMatch(
      /count\(\*\) as "n".*json_each\(\?\)/is,
    );
    expect(must(query.mock.calls[0], "query.mock.calls[0]")[1]).toEqual([JSON.stringify([1])]);
    expect(methodMock(res, "end")).toHaveBeenCalledOnce();
    expect(res.setHeader).toHaveBeenCalledWith("X-Exported-Count", "1");
  });

  it("ends the snapshot with the error when the export has no rows", async () => {
    const { settled } = useSnapshotResults(
      { rows: [{ n: 1 }] },
      { rows: [] },
    );
    const res = mockRes();

    await expect(
      streamBulkTransactionExport(res, { ids: [1], format: "csv" }),
    ).rejects.toThrow("No transactions found");

    expect(withReadSnapshot).toHaveBeenCalledOnce();
    expect(settled).toEqual(["rejected"]);
    expect(methodMock(res, "end")).not.toHaveBeenCalled();
  });
});
