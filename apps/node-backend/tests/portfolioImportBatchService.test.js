import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
  // rollbackBatch wraps its passes in one transaction; in the mocked world the
  // callback just runs (atomicity itself is proven on real Postgres in
  // portfolioImportRollback.db.test.js).
  withTransaction: vi.fn(async (fn) => fn({})),
}));

vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({
  default: {
    hardDelete: vi.fn().mockResolvedValue(true),
    hardDeleteByImportBatch: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/repositories/investmentRepository.js', () => ({
  default: {},
}));

vi.mock('../src/repositories/portfolioImportBatchRepository.js', () => ({
  getRowForInvestmentCreation: vi.fn(),
  overrideInvestment: vi.fn(),
  getCommittedRows: vi.fn(),
  markBatchAborted: vi.fn(),
  resetCommittedRowsToMatched: vi.fn(),
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  setBatchAccount: vi.fn(),
}));

import { query, withTransaction } from '../src/database/connection.js';
import portfolioTransactionRepository from '../src/repositories/portfolioTransactionRepository.js';
import {
  getCommittedRows,
  markBatchAborted,
  resetCommittedRowsToMatched,
} from '../src/repositories/portfolioImportBatchRepository.js';
import { rollbackBatch } from '../src/services/portfolioImportBatchService.js';

/**
 * Default query mock: answer rollbackBatch's is_brokerage lookup (true unless a
 * test says otherwise — most of these fixtures model the brokerage cash flow),
 * `{rowCount: 1}` for everything else (the ledger DELETE).
 * @param {boolean} isBrokerage
 */
function mockQueries(isBrokerage) {
  query.mockImplementation(async (/** @type {string} */ sql) => (
    /is_brokerage/.test(String(sql))
      ? { rows: [{ is_brokerage: isBrokerage }], rowCount: 1 }
      : { rows: [], rowCount: 1 }
  ));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueries(true);
  portfolioTransactionRepository.hardDelete.mockResolvedValue(true);
  // Default: nothing carries the 0086 stamp, i.e. the pre-migration world. Each
  // test that exercises the bulk path says so explicitly.
  portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([]);
});

describe('rollbackBatch — route-aware deletion (ADR-095)', () => {
  it('deletes a cash row from transactions, never through the portfolio repo', async () => {
    // The critical cross-table id bug: transactions.id 812 fed to the
    // portfolio hard-delete removed UNRELATED portfolio trade 812.
    getCommittedRows.mockResolvedValue([{ id: 812, route: 'cash' }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(query).toHaveBeenCalledWith('DELETE FROM transactions WHERE id = ANY($1::int[])', [[812]]);
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
    expect(markBatchAborted).toHaveBeenCalledWith(5);
  });

  it("guards route='cash' on a NON-brokerage batch: rolled back as the trade it was committed as", async () => {
    // A non-brokerage commit ignores `route` and writes every row as a trade
    // (commit.js checks `isBrokerage && route === 'cash'`), so its
    // committed_txn_id is a PORTFOLIO id. Feeding it to the ledger DELETE
    // would destroy an unrelated transactions row of the same number.
    mockQueries(false);
    getCommittedRows.mockResolvedValue([{ id: 812, route: 'cash' }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(query).not.toHaveBeenCalledWith('DELETE FROM transactions WHERE id = ANY($1::int[])', expect.anything());
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(812);
  });

  it('runs inside one transaction and resets committed staging rows before aborting', async () => {
    getCommittedRows.mockResolvedValue([{ id: 42, route: 'portfolio' }]);

    await rollbackBatch(5);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(resetCommittedRowsToMatched).toHaveBeenCalledWith(5);
    expect(markBatchAborted).toHaveBeenCalledWith(5);
    // Reset happens before the abort mark (both inside the transaction).
    expect(resetCommittedRowsToMatched.mock.invocationCallOrder[0])
      .toBeLessThan(markBatchAborted.mock.invocationCallOrder[0]);
  });

  it('never passes a cash id to the batch-stamped bulk delete', async () => {
    // transactions.import_batch_id FKs to the BANK import_batches table, so a
    // portfolio batch id is never stamped there — the bulk DELETE is keyed on
    // the batch, not on ids, and cash is structurally out of its reach.
    getCommittedRows.mockResolvedValue([{ id: 812, route: 'cash' }]);

    await rollbackBatch(5);

    expect(portfolioTransactionRepository.hardDeleteByImportBatch).toHaveBeenCalledWith(5);
    expect(portfolioTransactionRepository.hardDeleteByImportBatch).toHaveBeenCalledTimes(1);
  });

  it('deletes a trade through the portfolio repo, never the transactions table', async () => {
    getCommittedRows.mockResolvedValue([{ id: 42, route: 'portfolio' }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(42);
    expect(query).not.toHaveBeenCalledWith('DELETE FROM transactions WHERE id = ANY($1::int[])', [[42]]);
  });

  it('treats a NULL route (plain non-brokerage batch) as a portfolio row', async () => {
    getCommittedRows.mockResolvedValue([{ id: 7, route: null }]);

    await rollbackBatch(5);

    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(7);
  });

  it('handles a mixed batch and counts only actual deletions', async () => {
    getCommittedRows.mockResolvedValue([
      { id: 812, route: 'cash' },
      { id: 42, route: 'portfolio' },
      { id: 43, route: 'portfolio' },
    ]);
    portfolioTransactionRepository.hardDelete
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false); // already gone

    const res = await rollbackBatch(5);
    expect(res).toEqual({ deleted: 2 });
  });
});

describe('rollbackBatch — bulk delete on the 0086 import_batch_id stamp', () => {
  it('deletes stamped trades in ONE statement, with no per-row hard-delete', async () => {
    getCommittedRows.mockResolvedValue([
      { id: 42, route: 'portfolio' },
      { id: 43, route: 'portfolio' },
      { id: 44, route: 'portfolio' },
    ]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([42, 43, 44]);

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 3 });
    expect(portfolioTransactionRepository.hardDeleteByImportBatch).toHaveBeenCalledWith(9);
    // The whole point of the change: N rows, one statement.
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
  });

  it('falls back to the per-id path for rows committed before the migration', async () => {
    // A batch committed pre-0086: its lots carry import_batch_id NULL, so the
    // bulk DELETE reports nothing. Those rows must NOT be stranded.
    getCommittedRows.mockResolvedValue([
      { id: 42, route: 'portfolio' },
      { id: 43, route: 'portfolio' },
    ]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([]);

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 2 });
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(42);
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(43);
  });

  it('does not re-delete (or double-count) a row the bulk pass already removed', async () => {
    // Mixed-vintage batch: 42 was stamped, 43 predates the migration.
    getCommittedRows.mockResolvedValue([
      { id: 42, route: 'portfolio' },
      { id: 43, route: 'portfolio' },
    ]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([42]);

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 2 });
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledTimes(1);
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(43);
  });

  it('matches bulk-deleted ids across pg BIGINT-as-string vs number', async () => {
    getCommittedRows.mockResolvedValue([{ id: 42, route: 'portfolio' }]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue(['42']);

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 1 });
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
  });

  it('counts lots the stamp reached that no staging row still points at', async () => {
    // The stamp is the authority on what the batch created; committed_txn_id can
    // be missing (staging row edited/cleared) without the lot ceasing to be ours.
    getCommittedRows.mockResolvedValue([]);
    portfolioTransactionRepository.hardDeleteByImportBatch.mockResolvedValue([42, 43]);

    const res = await rollbackBatch(9);

    expect(res).toEqual({ deleted: 2 });
  });
});
