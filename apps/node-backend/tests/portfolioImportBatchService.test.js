import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({
  default: { hardDelete: vi.fn().mockResolvedValue(true) },
}));

vi.mock('../src/repositories/transactionRepository.js', () => ({
  default: { hardDelete: vi.fn().mockResolvedValue(true) },
}));

vi.mock('../src/repositories/investmentRepository.js', () => ({
  default: {},
}));

vi.mock('../src/services/portfolio/tradeCashLegService.js', () => ({
  deleteTradeCashLegs: vi.fn().mockResolvedValue(0),
}));

vi.mock('../src/repositories/portfolioImportBatchRepository.js', () => ({
  getRowForInvestmentCreation: vi.fn(),
  overrideInvestment: vi.fn(),
  getCommittedTxnTargets: vi.fn(),
  markBatchAborted: vi.fn(),
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  setBatchAccount: vi.fn(),
}));

import portfolioTransactionRepository from '../src/repositories/portfolioTransactionRepository.js';
import transactionRepository from '../src/repositories/transactionRepository.js';
import { deleteTradeCashLegs } from '../src/services/portfolio/tradeCashLegService.js';
import { getCommittedTxnTargets, markBatchAborted } from '../src/repositories/portfolioImportBatchRepository.js';
import { rollbackBatch } from '../src/services/portfolioImportBatchService.js';

beforeEach(() => {
  vi.clearAllMocks();
  portfolioTransactionRepository.hardDelete.mockResolvedValue(true);
  transactionRepository.hardDelete.mockResolvedValue(true);
});

describe('rollbackBatch — route-aware deletion (ADR-095)', () => {
  it('deletes a cash row from transactions, never through the portfolio repo', async () => {
    // The critical cross-table id bug: transactions.id 812 fed to the
    // portfolio hard-delete removed UNRELATED portfolio trade 812.
    getCommittedTxnTargets.mockResolvedValue([{ id: 812, route: 'cash' }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(transactionRepository.hardDelete).toHaveBeenCalledWith(812);
    expect(portfolioTransactionRepository.hardDelete).not.toHaveBeenCalled();
    expect(markBatchAborted).toHaveBeenCalledWith(5);
  });

  it('deletes a trade through the portfolio repo, dropping its ADR-090 cash leg first', async () => {
    getCommittedTxnTargets.mockResolvedValue([{ id: 42, route: 'portfolio' }]);

    const res = await rollbackBatch(5);

    expect(res).toEqual({ deleted: 1 });
    expect(deleteTradeCashLegs).toHaveBeenCalledWith(42);
    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(42);
    expect(transactionRepository.hardDelete).not.toHaveBeenCalled();
  });

  it('treats a NULL route (plain non-brokerage batch) as a portfolio row', async () => {
    getCommittedTxnTargets.mockResolvedValue([{ id: 7, route: null }]);

    await rollbackBatch(5);

    expect(portfolioTransactionRepository.hardDelete).toHaveBeenCalledWith(7);
  });

  it('handles a mixed batch and counts only actual deletions', async () => {
    getCommittedTxnTargets.mockResolvedValue([
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
