import { describe, it, expect, vi, beforeEach } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";
import { mockConnection } from "./helpers/repoMocks.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

// Repository writes that were one PostgreSQL statement now run as a short
// sequence inside withTransaction(); the fake runs the callback in place and
// reports an ambient transaction while it runs.
vi.mock("../src/database/connection.ts", () => {
  let inTransaction = false;
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return mockConnection({
    query,
    withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await fn({ query });
      } finally {
        inTransaction = false;
      }
    }),
    __getAmbientTransactionClient: vi.fn(() => (inTransaction ? { query } : null)),
  });
});

vi.mock("../src/services/portfolioImportPipeline/commit.ts", () => ({
  commitBatch: vi.fn(),
}));

vi.mock("../src/services/info/cache.ts", () => ({
  invalidatePortfolioCaches: vi.fn(),
}));

import { query as rawQuery } from "../src/database/connection.ts";
import { commitBatch as rawCommitBatch } from "../src/services/portfolioImportPipeline/commit.ts";
import { commitPortfolioImport } from "../src/services/portfolioImportPipeline/index.ts";
import {
  lockInvestmentResolutionRows,
  overrideInvestment,
  overrideInvestments,
  setBatchAccount,
} from "../src/repositories/portfolioImportBatchRepository.ts";
import { must } from "./helpers/must.ts";

const query = vi.mocked(rawQuery);
const commitBatch = vi.mocked(rawCommitBatch);

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("commitPortfolioImport — status reflects remaining error rows", () => {
  it('sets status by EXISTS(error rows), not a hardcoded "complete"', async () => {
    commitBatch.mockResolvedValue({ imported: 3, duplicates: 0, errors: 1 });

    await commitPortfolioImport({ batchId: 5 });

    const statusUpdate = query.mock.calls.find(([sql]) =>
      /update "?portfolio_import_batches"?[\s\S]*set "?status"?/i.test(sql),
    );
    expect(statusUpdate).toBeTruthy();
    const [sql, params] = must(statusUpdate, "statusUpdate");
    // Branches on the actual remaining error rows rather than unconditionally
    // marking the batch clean — this is what re-opens a partially-failed batch.
    expect(sql).toContain("'complete_with_errors'");
    expect(sql).toMatch(/status = 'error'/);
    expect(sql).not.toMatch(/SET status = 'complete'\s*,/); // no unconditional literal
    // [batch id in the EXISTS probe, batch id in WHERE].
    expect(params).toEqual([5, "5"]);
  });

  it("still returns the commit counts to the caller", async () => {
    commitBatch.mockResolvedValue({ imported: 2, duplicates: 1, errors: 0 });
    const res = await commitPortfolioImport({ batchId: 9 });
    expect(res).toMatchObject({ imported: 2, duplicates: 1, errors: 0 });
  });
});

describe("overrideInvestment — repair path for errored rows", () => {
  it("resets an error row to matched and decrements rows_error", async () => {
    // The guarded read reports the row was previously in 'error'.
    query
      .mockResolvedValueOnce({ rows: [{ old_status: "error" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const rowCount = await overrideInvestment({
      batchId: 5,
      rowId: 2,
      investmentId: 88,
    });

    expect(rowCount).toBe(1);
    const [guardSql, guardParams] = must(query.mock.calls[0], "query.mock.calls[0]");
    expect(guardSql).toContain(
      "error_message = 'unresolved instrument — pick or create a holding'",
    );
    expect(guardSql).toMatch(/status = 'matched'/);
    expect(guardParams).toEqual([5, 2]);
    // The row update re-points it and resets the error in the same write.
    const [updateSql, updateParams] = must(query.mock.calls[1], "query.mock.calls[1]");
    expect(updateSql).toMatch(
      /update "portfolio_import_staging_rows" set "user_override_investment_id" = \?, "status" = \?, "error_message" = \?/,
    );
    expect(updateParams).toEqual([88, "matched", null, "5", "2"]);
    // Third call decrements the batch counter (never below zero).
    const decrement = must(query.mock.calls[2], "query.mock.calls[2]");
    expect(decrement[0]).toMatch(
      /"?rows_error"? = max\(COALESCE\(rows_error, 0\) - 1, 0\)/,
    );
    expect(decrement[1]).toEqual(["5"]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("does not decrement when the row was already matched (plain re-point)", async () => {
    query.mockResolvedValueOnce({
      rows: [{ old_status: "matched" }],
      rowCount: 1,
    });

    await overrideInvestment({ batchId: 5, rowId: 2, investmentId: 88 });

    // The guarded read and the re-point; no counter update.
    expect(query).toHaveBeenCalledTimes(2);
    expect(must(query.mock.calls[1], "query.mock.calls[1]")[1]).toEqual([88, "5", "2"]);
  });

  it("does not decrement when clearing the override (investmentId null)", async () => {
    query.mockResolvedValueOnce({
      rows: [{ old_status: "error" }],
      rowCount: 1,
    });

    await overrideInvestment({ batchId: 5, rowId: 2, investmentId: null });

    // The error row keeps its status: only the override is cleared.
    expect(query).toHaveBeenCalledTimes(2);
    expect(must(query.mock.calls[1], "query.mock.calls[1]")[1]).toEqual([null, "5", "2"]);
  });

  it("returns 0 when the row is not in a reviewable status", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const rowCount = await overrideInvestment({
      batchId: 5,
      rowId: 2,
      investmentId: 88,
    });
    expect(rowCount).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("cash-row review guards and repair", () => {
  it("does not let an investment override target a cash row", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await overrideInvestment({ batchId: 5, rowId: 2, investmentId: 88 });

    // `IS NOT` is SQLite's IS DISTINCT FROM: a NULL route stays eligible.
    expect(must(query.mock.calls[0], "query.mock.calls[0]")[0]).toMatch(/route IS NOT 'cash'/);
  });

  it("repairs only the missing-account cash error when setting an account", async () => {
    // Two cash rows carried the missing-account error.
    query.mockResolvedValueOnce({ rows: [], rowCount: 2 });

    await setBatchAccount(5, 77);

    const [sql, params] = must(query.mock.calls[0], "query.mock.calls[0]");
    expect(sql).toMatch(
      /update "portfolio_import_staging_rows" set "status" = \?, "error_message" = \?/,
    );
    expect(sql).toMatch(/"route" = \?/);
    expect(sql).toMatch(/"error_message" = \?/);
    expect(params).toEqual([
      "matched",
      null,
      "5",
      "cash",
      "error",
      "brokerage cash row requires a batch account",
    ]);
    const [batchSql, batchParams] = must(query.mock.calls[1], "query.mock.calls[1]");
    expect(batchSql).toMatch(/"rows_error" = max\(COALESCE\(rows_error, 0\) - \?, 0\)/);
    // [account, repaired rows, batch id].
    expect(batchParams).toEqual([77, 2, "5"]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("repairs no cash row when clearing the account", async () => {
    await setBatchAccount(5, null);

    expect(query).toHaveBeenCalledTimes(1);
    const [batchSql, batchParams] = must(query.mock.calls[0], "query.mock.calls[0]");
    expect(batchSql).toMatch(/update "portfolio_import_batches"/);
    expect(batchParams).toEqual([null, 0, "5"]);
  });

  it("keeps bulk investment overrides away from cash rows", async () => {
    query.mockResolvedValueOnce({
      rows: [{ eligible_count: 0, error_count: 0 }],
      rowCount: 1,
    });

    await overrideInvestments({ batchId: 5, rowIds: [2], investmentId: 88 });

    expect(must(query.mock.calls[0], "query.mock.calls[0]")[0]).toMatch(/route IS NOT 'cash'/);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("overrideInvestments — atomic row-set guard", () => {
  it("updates the complete eligible set in one statement and repairs error counters once", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ eligible_count: 3, error_count: 2 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await overrideInvestments({
      batchId: 5,
      rowIds: [10, 11, 12],
      investmentId: 88,
    });

    expect(result).toEqual({
      requestedCount: 3,
      eligibleCount: 3,
      updatedCount: 3,
      resetErrorCount: 2,
    });
    const [sql, params] = must(query.mock.calls[0], "query.mock.calls[0]");
    expect(sql).toContain(
      "error_message = 'unresolved instrument — pick or create a holding'",
    );
    expect(sql).toMatch(/id IN \(SELECT value FROM json_each\(\?\)\)/);
    expect(params).toEqual([5, "[10,11,12]"]);
    // One update over the same guarded row set.
    const [updateSql, updateParams] = must(query.mock.calls[1], "query.mock.calls[1]");
    expect(updateSql).toMatch(/update "portfolio_import_staging_rows"/);
    expect(updateSql).toContain(
      "error_message = 'unresolved instrument — pick or create a holding'",
    );
    expect(updateSql).toMatch(/CASE WHEN status = 'error' THEN 'matched' ELSE status END/);
    expect(updateParams).toEqual([88, 5, "[10,11,12]"]);
    // [reset error count, batch id].
    expect(must(query.mock.calls[2], "query.mock.calls[2]")[1]).toEqual([2, "5"]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("counts a repeated requested id once", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ eligible_count: 2, error_count: 0 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const result = await overrideInvestments({
      batchId: 5,
      rowIds: [10, 11, 10],
      investmentId: 88,
    });

    expect(result).toEqual({
      requestedCount: 2,
      eligibleCount: 2,
      updatedCount: 2,
      resetErrorCount: 0,
    });
    expect(must(query.mock.calls[0], "query.mock.calls[0]")[1]).toEqual([5, "[10,11]"]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("performs no update and no counter write when one requested row is ineligible", async () => {
    query.mockResolvedValueOnce({
      rows: [{ eligible_count: 2, error_count: 1 }],
      rowCount: 1,
    });

    const result = await overrideInvestments({
      batchId: 5,
      rowIds: [10, 11, 999],
      investmentId: 88,
    });

    expect(result.updatedCount).toBe(0);
    expect(result.eligibleCount).toBe(2);
    expect(result.resetErrorCount).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("lockInvestmentResolutionRows — batch-first serialization", () => {
  // PostgreSQL took FOR UPDATE on the batch and then on the rows. Under SQLite
  // the caller's withTransaction() (BEGIN IMMEDIATE on the single writer)
  // provides that exclusion, and SQLite has no FOR UPDATE clause; the order
  // of the reads is what remains to check here.
  it("reads the batch before the complete ordered row set", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            status: "awaiting_review",
            is_brokerage: false,
            adapter_name: "portfolio_generic",
            custom_config: null,
            account_id: null,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        // BIGINT ids as pg returns them.
        rows: [
          {
            id: "10",
            status: "matched",
            route: "portfolio",
            error_message: null,
            user_override_investment_id: null,
          },
          {
            id: "11",
            status: "error",
            route: "portfolio",
            error_message: "unresolved investment",
            user_override_investment_id: null,
          },
        ],
        rowCount: 2,
      });

    const result = await lockInvestmentResolutionRows({
      batchId: 5,
      rowIds: [11, 10],
    });

    expect(result.batchStatus).toBe("awaiting_review");
    expect(result.rows.map((row) => row.id)).toEqual(["10", "11"]);
    const [batchSql] = must(query.mock.calls[0], "query.mock.calls[0]");
    expect(batchSql).toMatch(/from "portfolio_import_batches"/i);
    expect(batchSql).not.toMatch(/for update/i);
    const [rowsSql, rowsParams] = must(query.mock.calls[1], "query.mock.calls[1]");
    expect(rowsSql).toMatch(/from "portfolio_import_staging_rows"[\s\S]*order by "id"$/i);
    expect(rowsSql).not.toMatch(/for update/i);
    expect(rowsParams).toEqual(["5", "[11,10]"]);
  });

  it("does not read rows when the batch does not exist", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(
      lockInvestmentResolutionRows({ batchId: 999, rowIds: [10] }),
    ).resolves.toEqual({ batchStatus: undefined, rows: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
