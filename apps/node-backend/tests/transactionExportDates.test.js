import { describe, it, expect, vi, beforeEach } from "vitest";

import { mockLogger } from "./helpers/mockLogger.js";
// Export date serialization (TODO E11): the CSV column was String(pg Date)
// ("Wed Jul 01 2026 00:00:00 GMT+0200 …" — unusable in Excel, a day off on
// cross-TZ re-import) and buildNdjsonRow went through JSON.stringify's
// toISOString — the PREVIOUS day's timestamp on any backend east of UTC.

vi.mock("../src/config/logger.js", () => ({
  logger: mockLogger(),
}));
vi.mock("../src/database/connection.js", () => ({
  getClient: vi.fn(),
  query: vi.fn(),
}));

import { getClient, query as dbQuery } from "../src/database/connection.js";
import {
  streamBulkTransactionExport,
  streamCsvExport,
  streamNdjsonExport,
} from "../src/services/transactionExport.js";

// A pg DATE arrives as a LOCAL-midnight Date object; this is the shape the
// export must turn back into a plain calendar day regardless of process TZ.
const JULY_FIRST = new Date(2026, 6, 1);

function exportRow(overrides = {}) {
  return {
    id: 1,
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
  };
}

function mockRes() {
  const chunks = [];
  return {
    chunks,
    setHeader: vi.fn(),
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    end: vi.fn(),
    destroy: vi.fn(),
    once: vi.fn(),
    headersSent: true,
  };
}

function primeQueries(rows) {
  dbQuery
    .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // probe
    .mockResolvedValueOnce({ rows }); // single chunk (< EXPORT_CHUNK_SIZE ends the loop)
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

    expect(dbQuery.mock.calls[0][0]).toMatch(/t\.account_id IN \(\$1, \$2\)/);
    expect(dbQuery.mock.calls[0][0]).toContain("t.amount < 0");
    expect(dbQuery.mock.calls[0][1]).toEqual([3, 9]);
  });

  it("destroys and rejects a response when a database failure happens after headers", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] })
      .mockRejectedValueOnce(new Error("stream failed"));
    const res = mockRes();

    await expect(
      streamCsvExport(res, { whereSql: "1=1", params: [], nextParamIdx: 1 }),
    ).rejects.toThrow("stream failed");
    expect(res.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "stream failed" }),
    );
    expect(res.end).not.toHaveBeenCalled();
  });

  it("CSV emits the calendar day, not String(pg Date)", async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamCsvExport(res, {
      whereSql: "1=1",
      params: [],
      nextParamIdx: 1,
    });

    const dataRow = res.chunks[1]; // [0] is the header line
    expect(dataRow.startsWith("2026-07-01,")).toBe(true);
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
      whereSql: "1=1",
      params: [],
      nextParamIdx: 1,
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
      whereSql: "1=1",
      params: [],
      nextParamIdx: 1,
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
      whereSql: "1=1",
      params: [],
      nextParamIdx: 1,
    });

    const parsed = JSON.parse(res.chunks[0]);
    expect(parsed.date).toBe("2026-07-01");
  });
});

describe("export tag aggregation", () => {
  it("CSV joins a multi-tag transaction on the slug-ordered array", async () => {
    primeQueries([exportRow({ tags: ["alpha", "beta", "gamma"] })]);
    const res = mockRes();

    await streamCsvExport(res, {
      whereSql: "1=1",
      params: [],
      nextParamIdx: 1,
    });

    // Tags column (10th) preserves order and joins with ';'.
    expect(res.chunks[1]).toContain("alpha;beta;gamma");
  });

  it("NDJSON emits the multi-tag array unchanged", async () => {
    primeQueries([exportRow({ tags: ["alpha", "beta", "gamma"] })]);
    const res = mockRes();

    await streamNdjsonExport(res, {
      whereSql: "1=1",
      params: [],
      nextParamIdx: 1,
    });

    expect(JSON.parse(res.chunks[0]).tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("fetches tags via a single pre-aggregated LEFT JOIN, not a per-row correlated subquery", async () => {
    primeQueries([exportRow()]);
    const res = mockRes();

    await streamNdjsonExport(res, {
      whereSql: "1=1",
      params: [],
      nextParamIdx: 1,
    });

    // dbQuery calls: [0] probe, [1] first chunk.
    const chunkSql = dbQuery.mock.calls[1][0];
    // Slug ordering + active-only filter preserved …
    expect(chunkSql).toContain("array_agg(tg.slug ORDER BY tg.slug)");
    expect(chunkSql).toContain("WHERE tg.is_active = true");
    // … as a grouped LEFT JOIN, not a t.id-correlated subquery.
    expect(chunkSql).toContain("GROUP BY tt.transaction_id");
    expect(chunkSql).not.toContain("WHERE tt.transaction_id = t.id");
  });
});

describe("bulk export service snapshot", () => {
  function useClientResults(...results) {
    const query = vi.fn();
    for (const result of results) query.mockResolvedValueOnce(result);
    const release = vi.fn();
    getClient.mockResolvedValue({ query, release });
    return { query, release };
  }

  it("rejects a malformed selector before acquiring a database client", async () => {
    const res = mockRes();

    await expect(
      streamBulkTransactionExport(res, { format: "csv" }),
    ).rejects.toThrow(/either .* or .* must be provided/i);

    expect(getClient).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("commits and releases one repeatable-read snapshot after streaming", async () => {
    const { query, release } = useClientResults(
      {},
      { rows: [{ n: 1 }] },
      { rows: [{ "?column?": 1 }] },
      { rows: [exportRow()] },
      {},
    );
    const res = mockRes();

    await streamBulkTransactionExport(res, {
      ids: [1],
      format: "csv",
    });

    expect(query.mock.calls[0][0]).toBe(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(query.mock.calls.at(-1)[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
    expect(res.end).toHaveBeenCalledOnce();
    expect(res.setHeader).toHaveBeenCalledWith("X-Exported-Count", "1");
  });

  it("rolls back and releases the snapshot when the export has no rows", async () => {
    const { query, release } = useClientResults(
      {},
      { rows: [{ n: 1 }] },
      { rows: [] },
      {},
    );
    const res = mockRes();

    await expect(
      streamBulkTransactionExport(res, { ids: [1], format: "csv" }),
    ).rejects.toThrow("No transactions found");

    expect(query.mock.calls.at(-1)[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
    expect(res.end).not.toHaveBeenCalled();
  });
});
