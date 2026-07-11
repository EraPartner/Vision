import { beforeEach, describe, expect, it, vi } from 'vitest';

// Rollback must route each committed id to the table it was written to:
// cash rows → `transactions`, trades → `portfolio_transactions`. The two tables
// have independent sequences, so a cross-table delete would destroy an unrelated
// record (finding: "Brokerage-batch rollback deletes wrong-table ids").

const { targets, portfolioHardDelete, txHardDelete, markAborted, deleteCashLegs } = vi.hoisted(() => ({
  targets: vi.fn(),
  portfolioHardDelete: vi.fn(async () => true),
  txHardDelete: vi.fn(async () => true),
  markAborted: vi.fn(async () => {}),
  deleteCashLegs: vi.fn(async () => 0),
}));

vi.mock('../src/repositories/portfolioImportBatchRepository.js', () => ({
  getCommittedTxnTargets: targets,
  markBatchAborted: markAborted,
  getRowForInvestmentCreation: vi.fn(),
  overrideInvestment: vi.fn(),
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  setBatchAccount: vi.fn(),
}));
vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({
  default: { hardDelete: portfolioHardDelete },
}));
vi.mock('../src/repositories/transactionRepository.js', () => ({
  default: { hardDelete: txHardDelete },
}));
vi.mock('../src/repositories/investmentRepository.js', () => ({ default: {} }));
vi.mock('../src/services/portfolio/tradeCashLegService.js', () => ({
  deleteTradeCashLegs: deleteCashLegs,
}));

import { rollbackBatch } from '../src/services/portfolioImportBatchService.js';

beforeEach(() => vi.clearAllMocks());

describe('rollbackBatch table routing', () => {
  it('deletes cash ids from transactions and trade ids from portfolio_transactions', async () => {
    targets.mockResolvedValue([
      { id: 812, route: 'cash' },       // a transactions id
      { id: 5, route: 'portfolio' },    // a portfolio_transactions id
      { id: 9, route: null },           // non-brokerage import → portfolio table
    ]);

    const { deleted } = await rollbackBatch(42);

    expect(txHardDelete).toHaveBeenCalledTimes(1);
    expect(txHardDelete).toHaveBeenCalledWith(812);
    expect(portfolioHardDelete).toHaveBeenCalledTimes(2);
    expect(portfolioHardDelete).toHaveBeenCalledWith(5);
    expect(portfolioHardDelete).toHaveBeenCalledWith(9);
    // Critically, the cash id 812 must NOT be sent to the portfolio table.
    expect(portfolioHardDelete).not.toHaveBeenCalledWith(812);
    // Trade rollbacks drop their ADR-090 cash leg first (no FK cascade).
    expect(deleteCashLegs).toHaveBeenCalledWith(5);
    expect(deleteCashLegs).toHaveBeenCalledWith(9);
    expect(deleteCashLegs).not.toHaveBeenCalledWith(812);
    expect(deleted).toBe(3);
    expect(markAborted).toHaveBeenCalledWith(42);
  });
});
