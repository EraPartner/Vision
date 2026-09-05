import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.js";

const portfolioRemovalMocks = vi.hoisted(() => ({
  remove: vi.fn().mockResolvedValue(true),
  removeByImportBatch: vi.fn().mockResolvedValue([]),
  validateImportBatchRemoval: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/database/connection.js", () =>
  mockTxConnection(undefined, {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
  }),
);

vi.mock("../src/repositories/portfolioTransactionRepository.js", () => ({
  default: {
    hardDelete: portfolioRemovalMocks.remove,
    hardDeleteByImportBatch: portfolioRemovalMocks.removeByImportBatch,
  },
}));

vi.mock("../src/services/portfolio/portfolioTransactionService.js", () => ({
  default: {
    validateImportBatchRemoval:
      portfolioRemovalMocks.validateImportBatchRemoval,
  },
}));

vi.mock("../src/repositories/investmentRepository.js", () => ({
  default: {
    create: vi.fn(),
    getById: vi.fn(),
  },
}));

vi.mock("../src/repositories/portfolioImportBatchRepository.js", () => ({
  getRowForInvestmentCreation: vi.fn(),
  lockBatchForUpdate: vi.fn(),
  lockInvestmentResolutionRows: vi.fn(),
  overrideInvestment: vi.fn(),
  overrideInvestments: vi.fn(),
  getCommittedRows: vi.fn(),
  markBatchAborted: vi.fn(),
  resetCommittedRowsToMatched: vi.fn(),
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  setBatchAccount: vi.fn(),
}));

import { query, withTransaction } from "../src/database/connection.js";
import portfolioTransactionRepository from "../src/repositories/portfolioTransactionRepository.js";
import investmentRepository from "../src/repositories/investmentRepository.js";
import {
  getRowForInvestmentCreation,
  lockBatchForUpdate,
  lockInvestmentResolutionRows,
  overrideInvestment,
  overrideInvestments,
  getCommittedRows,
  markBatchAborted,
  resetCommittedRowsToMatched,
  getPreviewRows,
} from "../src/repositories/portfolioImportBatchRepository.js";
import {
  createInvestmentForRow,
  getPortfolioImportBatchPreview,
  resolveInvestmentRows,
  rollbackBatch,
} from "../src/services/portfolioImportBatchService.js";

/**
 * Default query mock: answer rollbackBatch's is_brokerage lookup (true unless a
 * test says otherwise — most of these fixtures model the brokerage cash flow),
 * `{rowCount: 1}` for everything else (the ledger DELETE).
 * @param {boolean} isBrokerage
 */
function mockQueries(isBrokerage) {
  query.mockImplementation(async (/** @type {string} */ sql) =>
    /is_brokerage/.test(String(sql))
      ? { rows: [{ is_brokerage: isBrokerage }], rowCount: 1 }
      : { rows: [], rowCount: 1 },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueries(true);
  portfolioTransactionRepository.hardDelete.mockResolvedValue(true);
  // Default: nothing carries the 0086 stamp, i.e. the pre-migration world. Each
  // test that exercises the bulk path says so explicitly.
  portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([]);
  lockBatchForUpdate.mockResolvedValue({
    status: "complete",
    is_brokerage: true,
  });
  lockInvestmentResolutionRows.mockResolvedValue({
    batchStatus: "awaiting_review",
    rows: [10, 11, 12].map((id) => ({
      id,
      status: "matched",
      user_override_investment_id: null,
    })),
  });
});

describe("getPortfolioImportBatchPreview", () => {
  it("preserves investment/raw/cash grouping, error precedence, row values, and totals", async () => {
    getPreviewRows.mockResolvedValue([
      {
        id: 1,
        row_index: 0,
        status: "matched",
        route: "trade",
        effective_investment_id: 9,
        investment_name: "Fund",
        investment_symbol: "FND",
        investment_asset_class: "stocks_etfs",
        symbol_raw: "FND",
        name_raw: "Fund",
        match_source: "symbol",
        amount: "100.50",
        units: "2.5",
      },
      {
        id: 2,
        row_index: 1,
        status: "matched",
        route: "trade",
        effective_investment_id: null,
        symbol_raw: "ABC",
        name_raw: "Alpha",
        match_source: "name_exact",
        amount: "20.00",
      },
      {
        id: 3,
        row_index: 2,
        status: "matched",
        route: "trade",
        effective_investment_id: null,
        symbol_raw: "abc",
        name_raw: "Other",
        match_source: null,
        amount: "30.00",
      },
      {
        id: 4,
        row_index: 3,
        status: "matched",
        route: "cash",
        effective_investment_id: null,
        symbol_raw: "CASH",
        name_raw: "Cash",
        match_source: null,
        amount: "40.00",
      },
      {
        id: 5,
        row_index: 4,
        status: "error",
        route: "trade",
        effective_investment_id: null,
        symbol_raw: "ERR",
        name_raw: "Error",
        match_source: "symbol",
        error_message: "bad row",
        amount: "50.00",
      },
    ]);

    const result = await getPortfolioImportBatchPreview(4);

    expect(getPreviewRows).toHaveBeenCalledWith(4);
    expect(result.totals).toEqual({
      symbol: 1,
      name_exact: 1,
      unresolved: 2,
      error: 1,
    });
    expect(result.groups).toHaveLength(4);
    expect(result.groups[0]).toEqual(
      expect.objectContaining({ investment_id: 9, row_count: 1 }),
    );
    expect(result.groups[0].rows[0]).toEqual(
      expect.objectContaining({
        id: 1,
        amount: "100.50",
        units: "2.5",
      }),
    );
    expect(result.groups[1].row_count).toBe(2);
    expect(result.groups[1].rows.map((row) => row.id)).toEqual([2, 3]);
    expect(result.groups[2]).toEqual(
      expect.objectContaining({
        is_cash: true,
        raw_symbol: null,
        raw_name: null,
      }),
    );
    expect(result.groups[3].rows[0].error_message).toBe("bad row");
  });

  it("returns the complete zeroed totals shape for an empty preview", async () => {
    getPreviewRows.mockResolvedValue([]);
    await expect(getPortfolioImportBatchPreview(1)).resolves.toEqual({
      groups: [],
      totals: { symbol: 0, name_exact: 0, unresolved: 0, error: 0 },
    });
  });
});

describe("rollbackBatch — route-aware deletion (ADR-095)", () => {
  it("deletes a cash row from transactions, never through the portfolio repo", async () => {
    // The critical cross-table id bug: transactions.id 812 fed to the
    // portfolio hard-delete removed UNRELATED portfolio trade 812.
    getCommittedRows.mockResolvedValue([{ id: 812, route: "cash" }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM transactions WHERE id = ANY($1::int[])",
      [[812]],
    );
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
    expect(markBatchAborted).toHaveBeenCalledWith(5);
  });

  it("guards route='cash' on a NON-brokerage batch: rolled back as the trade it was committed as", async () => {
    // A non-brokerage commit ignores `route` and writes every row as a trade
    // (commit.js checks `isBrokerage && route === 'cash'`), so its
    // committed_txn_id is a PORTFOLIO id. Feeding it to the ledger DELETE
    // would destroy an unrelated transactions row of the same number.
    mockQueries(false);
    lockBatchForUpdate.mockResolvedValue({
      status: "complete",
      is_brokerage: false,
    });
    getCommittedRows.mockResolvedValue([{ id: 812, route: "cash" }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(query).not.toHaveBeenCalledWith(
      "DELETE FROM transactions WHERE id = ANY($1::int[])",
      expect.anything(),
    );
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(812);
  });

  it("runs inside one transaction and resets committed staging rows before aborting", async () => {
    getCommittedRows.mockResolvedValue([
      { id: 42, route: "portfolio", investment_id: 8 },
      { id: 43, route: "portfolio", investment_id: 8 },
    ]);

    await rollbackBatch(5);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(
      portfolioRemovalMocks.validateImportBatchRemoval,
    ).toHaveBeenCalledWith(5, [
      { id: 42, route: "portfolio", investment_id: 8 },
      { id: 43, route: "portfolio", investment_id: 8 },
    ]);
    expect(resetCommittedRowsToMatched).toHaveBeenCalledWith(5);
    expect(markBatchAborted).toHaveBeenCalledWith(5);
    // Reset happens before the abort mark (both inside the transaction).
    expect(
      portfolioRemovalMocks.validateImportBatchRemoval.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      portfolioTransactionRepository.hardDeleteByImportBatch.mock
        .invocationCallOrder[0],
    );
    expect(
      resetCommittedRowsToMatched.mock.invocationCallOrder[0],
    ).toBeLessThan(markBatchAborted.mock.invocationCallOrder[0]);
  });

  it("locks and rejects a pending batch before reading or deleting committed rows", async () => {
    lockBatchForUpdate.mockResolvedValue({
      status: "pending",
      is_brokerage: false,
    });

    await expect(rollbackBatch(5)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    expect(lockBatchForUpdate).toHaveBeenCalledWith(5);
    expect(getCommittedRows).not.toHaveBeenCalled();
    expect(
      portfolioTransactionRepository.hardDeleteByImportBatch,
    ).not.toHaveBeenCalled();
  });

  it("never passes a cash id to the batch-stamped bulk delete", async () => {
    // transactions.import_batch_id FKs to the BANK import_batches table, so a
    // portfolio batch id is never stamped there — the bulk DELETE is keyed on
    // the batch, not on ids, and cash is structurally out of its reach.
    getCommittedRows.mockResolvedValue([{ id: 812, route: "cash" }]);

    await rollbackBatch(5);

    expect(
      portfolioTransactionRepository.hardDeleteByImportBatch,
    ).toHaveBeenCalledWith(5);
    expect(
      portfolioTransactionRepository.hardDeleteByImportBatch,
    ).toHaveBeenCalledTimes(1);
  });

  it("deletes a trade through the portfolio repo, never the transactions table", async () => {
    getCommittedRows.mockResolvedValue([{ id: 42, route: "portfolio" }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(42);
    expect(query).not.toHaveBeenCalledWith(
      "DELETE FROM transactions WHERE id = ANY($1::int[])",
      [[42]],
    );
  });

  it("treats a NULL route (plain non-brokerage batch) as a portfolio row", async () => {
    getCommittedRows.mockResolvedValue([{ id: 7, route: null }]);

    await rollbackBatch(5);

    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(7);
  });

  it("handles a mixed batch and counts only actual deletions", async () => {
    getCommittedRows.mockResolvedValue([
      { id: 812, route: "cash" },
      { id: 42, route: "portfolio" },
      { id: 43, route: "portfolio" },
    ]);
    portfolioTransactionRepository.hardDelete
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false); // already gone

    const res = await rollbackBatch(5);
    expect(res).toEqual({ deleted: 2 });
  });
});

describe("resolveInvestmentRows — atomic group resolution", () => {
  it("checks one existing investment and sends the complete row set to one bulk write", async () => {
    investmentRepository.getById.mockResolvedValue({ id: 88 });
    overrideInvestments.mockResolvedValue({
      requestedCount: 3,
      eligibleCount: 3,
      updatedCount: 3,
    });

    const result = await resolveInvestmentRows({
      batchId: 5,
      rowIds: [10, 11, 12],
      investmentId: 88,
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(investmentRepository.getById).toHaveBeenCalledWith(88);
    expect(overrideInvestments).toHaveBeenCalledTimes(1);
    expect(overrideInvestments).toHaveBeenCalledWith({
      batchId: 5,
      rowIds: [10, 11, 12],
      investmentId: 88,
    });
    expect(result).toMatchObject({
      investmentId: 88,
      created: false,
      resolved: 3,
    });
  });

  it("creates one holding inside the transaction and resolves the full row set to it", async () => {
    lockInvestmentResolutionRows.mockResolvedValue({
      batchStatus: "awaiting_review",
      rows: [10, 11].map((id) => ({
        id,
        status: "matched",
        user_override_investment_id: null,
      })),
    });
    getRowForInvestmentCreation.mockResolvedValue({
      symbol_raw: "VWCE",
      name_raw: "Vanguard FTSE All-World",
      currency: "EUR",
      default_asset_class: "etf",
    });
    investmentRepository.create.mockResolvedValue({
      id: 91,
      name: "Vanguard FTSE All-World",
    });
    overrideInvestment.mockResolvedValue(1);
    overrideInvestments.mockResolvedValue({
      requestedCount: 2,
      eligibleCount: 2,
      updatedCount: 2,
    });

    const result = await resolveInvestmentRows({
      batchId: 5,
      rowIds: [10, 11],
      createNew: true,
    });

    expect(investmentRepository.create).toHaveBeenCalledTimes(1);
    expect(overrideInvestments).toHaveBeenCalledWith({
      batchId: 5,
      rowIds: [10, 11],
      investmentId: 91,
    });
    expect(result).toMatchObject({
      investmentId: 91,
      created: true,
      resolved: 2,
    });
  });

  it("throws inside the transaction when any requested row is ineligible", async () => {
    lockInvestmentResolutionRows.mockResolvedValue({
      batchStatus: "awaiting_review",
      rows: [10, 11].map((id) => ({
        id,
        status: "matched",
        user_override_investment_id: null,
      })),
    });

    await expect(
      resolveInvestmentRows({
        batchId: 5,
        rowIds: [10, 11, 999],
        investmentId: 88,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(investmentRepository.getById).not.toHaveBeenCalled();
    expect(overrideInvestments).not.toHaveBeenCalled();
  });

  it("rejects a cash row before single-row create can orphan a holding", async () => {
    lockInvestmentResolutionRows.mockResolvedValue({
      batchStatus: "awaiting_review",
      rows: [
        {
          id: 10,
          status: "error",
          route: "cash",
          user_override_investment_id: null,
        },
      ],
    });

    await expect(
      createInvestmentForRow({ batchId: 5, rowId: 10 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(investmentRepository.create).not.toHaveBeenCalled();
    expect(overrideInvestment).not.toHaveBeenCalled();
  });

  it("rejects an aborted batch before any investment lookup, creation, or row write", async () => {
    lockInvestmentResolutionRows.mockResolvedValue({
      batchStatus: "aborted",
      rows: [],
    });

    await expect(
      resolveInvestmentRows({
        batchId: 5,
        rowIds: [10, 11],
        createNew: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(investmentRepository.create).not.toHaveBeenCalled();
    expect(investmentRepository.getById).not.toHaveBeenCalled();
    expect(overrideInvestments).not.toHaveBeenCalled();
  });

  it("rejects a batch that is still matching before any investment or row write", async () => {
    lockInvestmentResolutionRows.mockResolvedValue({
      batchStatus: "matching",
      rows: [],
    });

    await expect(
      resolveInvestmentRows({
        batchId: 5,
        rowIds: [10],
        investmentId: 88,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(investmentRepository.getById).not.toHaveBeenCalled();
    expect(overrideInvestments).not.toHaveBeenCalled();
  });

  it("rejects create-new after a concurrent request has resolved the locked row set", async () => {
    lockInvestmentResolutionRows.mockResolvedValue({
      batchStatus: "awaiting_review",
      rows: [
        { id: 10, status: "matched", user_override_investment_id: 91 },
        { id: 11, status: "matched", user_override_investment_id: 91 },
      ],
    });

    await expect(
      resolveInvestmentRows({
        batchId: 5,
        rowIds: [10, 11],
        createNew: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(investmentRepository.create).not.toHaveBeenCalled();
    expect(overrideInvestments).not.toHaveBeenCalled();
  });
});

describe("rollbackBatch — bulk delete on the 0086 import_batch_id stamp", () => {
  it("deletes stamped trades in ONE statement, with no per-row hard-delete", async () => {
    getCommittedRows.mockResolvedValue([
      { id: 42, route: "portfolio" },
      { id: 43, route: "portfolio" },
      { id: 44, route: "portfolio" },
    ]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([
      42, 43, 44,
    ]);

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 3 });
    expect(
      portfolioTransactionRepository.hardDeleteByImportBatch,
    ).toHaveBeenCalledWith(9);
    // The whole point of the change: N rows, one statement.
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
  });

  it("falls back to the per-id path for rows committed before the migration", async () => {
    // A batch committed pre-0086: its lots carry import_batch_id NULL, so the
    // bulk DELETE reports nothing. Those rows must NOT be stranded.
    getCommittedRows.mockResolvedValue([
      { id: 42, route: "portfolio" },
      { id: 43, route: "portfolio" },
    ]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue(
      [],
    );

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 2 });
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(42);
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(43);
  });

  it("does not re-delete (or double-count) a row the bulk pass already removed", async () => {
    // Mixed-vintage batch: 42 was stamped, 43 predates the migration.
    getCommittedRows.mockResolvedValue([
      { id: 42, route: "portfolio" },
      { id: 43, route: "portfolio" },
    ]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([
      42,
    ]);

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 2 });
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledTimes(1);
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(43);
  });

  it("matches bulk-deleted ids across pg BIGINT-as-string vs number", async () => {
    getCommittedRows.mockResolvedValue([{ id: 42, route: "portfolio" }]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([
      "42",
    ]);

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 1 });
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
  });

  it("counts lots the stamp reached that no staging row still points at", async () => {
    // The stamp is the authority on what the batch created; committed_txn_id can
    // be missing (staging row edited/cleared) without the lot ceasing to be ours.
    getCommittedRows.mockResolvedValue([]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([
      42, 43,
    ]);

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 2 });
  });
});
