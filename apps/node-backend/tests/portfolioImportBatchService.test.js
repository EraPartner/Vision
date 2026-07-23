import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
}));

vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({
  default: { hardDelete: vi.fn().mockResolvedValue(true) },
}));

vi.mock('../src/repositories/investmentRepository.js', () => ({
  default: {},
}));

vi.mock('../src/repositories/portfolioImportBatchRepository.js', () => ({
  getRowForInvestmentCreation: vi.fn(),
  overrideInvestment: vi.fn(),
  getCommittedRows: vi.fn(),
  markBatchAborted: vi.fn(),
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  setBatchAccount: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import portfolioTransactionRepository from '../src/repositories/portfolioTransactionRepository.js';
import { getCommittedRows, markBatchAborted } from '../src/repositories/portfolioImportBatchRepository.js';
import { rollbackBatch } from '../src/services/portfolioImportBatchService.js';

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [], rowCount: 1 });
  portfolioTransactionRepository.hardDelete.mockResolvedValue(true);
});

describe('rollbackBatch — route-aware deletion (ADR-095)', () => {
  it('deletes a cash row from transactions, never through the portfolio repo', async () => {
    // The critical cross-table id bug: transactions.id 812 fed to the
    // portfolio hard-delete removed UNRELATED portfolio trade 812.
    getCommittedRows.mockResolvedValue([{ id: 812, route: 'cash' }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(query).toHaveBeenCalledWith('DELETE FROM transactions WHERE id = $1', [812]);
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
    expect(markBatchAborted).toHaveBeenCalledWith(5);
  });

  it('deletes a trade through the portfolio repo, never the transactions table', async () => {
    getCommittedRows.mockResolvedValue([{ id: 42, route: 'portfolio' }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(42);
    expect(query).not.toHaveBeenCalledWith('DELETE FROM transactions WHERE id = $1', [42]);
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
