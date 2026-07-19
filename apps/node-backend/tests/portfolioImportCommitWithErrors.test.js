import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';

vi.mock('../src/config/logger.js', () => ({ logger: mockLogger() }));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: vi.fn(),
}));

vi.mock('../src/services/portfolioImportPipeline/commit.js', () => ({
  commitBatch: vi.fn(),
}));

vi.mock('../src/routes/info/_cache.js', () => ({
  invalidatePortfolioCaches: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import { commitBatch } from '../src/services/portfolioImportPipeline/commit.js';
import { commitPortfolioImport } from '../src/services/portfolioImportPipeline/index.js';
import { overrideInvestment } from '../src/repositories/portfolioImportBatchRepository.js';

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('commitPortfolioImport — status reflects remaining error rows', () => {
  it('sets status by EXISTS(error rows), not a hardcoded "complete"', async () => {
    commitBatch.mockResolvedValue({ imported: 3, duplicates: 0, errors: 1 });

    await commitPortfolioImport({ batchId: 5 });

    const statusUpdate = query.mock.calls.find(([sql]) =>
      /UPDATE portfolio_import_batches[\s\S]*SET status/.test(sql));
    expect(statusUpdate).toBeTruthy();
    const [sql, params] = statusUpdate;
    // Branches on the actual remaining error rows rather than unconditionally
    // marking the batch clean — this is what re-opens a partially-failed batch.
    expect(sql).toContain("'complete_with_errors'");
    expect(sql).toMatch(/status = 'error'/);
    expect(sql).not.toMatch(/SET status = 'complete'\s*,/); // no unconditional literal
    expect(params).toEqual([5]);
  });

  it('still returns the commit counts to the caller', async () => {
    commitBatch.mockResolvedValue({ imported: 2, duplicates: 1, errors: 0 });
    const res = await commitPortfolioImport({ batchId: 9 });
    expect(res).toMatchObject({ imported: 2, duplicates: 1, errors: 0 });
  });
});

describe('overrideInvestment — repair path for errored rows', () => {
  it('resets an error row to matched and decrements rows_error', async () => {
    // Main CTE update reports the row was previously in 'error'.
    query
      .mockResolvedValueOnce({ rows: [{ old_status: 'error' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const rowCount = await overrideInvestment({ batchId: 5, rowId: 2, investmentId: 88 });

    expect(rowCount).toBe(1);
    const updateSql = query.mock.calls[0][0];
    expect(updateSql).toMatch(/status IN \('matched', 'error'\)/);
    expect(updateSql).toMatch(/'matched'/);
    // Second call decrements the batch counter (never below zero).
    const decrement = query.mock.calls[1];
    expect(decrement[0]).toMatch(/rows_error = GREATEST\(COALESCE\(rows_error, 0\) - 1, 0\)/);
    expect(decrement[1]).toEqual([5]);
  });

  it('does not decrement when the row was already matched (plain re-point)', async () => {
    query.mockResolvedValueOnce({ rows: [{ old_status: 'matched' }], rowCount: 1 });

    await overrideInvestment({ batchId: 5, rowId: 2, investmentId: 88 });

    expect(query).toHaveBeenCalledTimes(1); // no counter update
  });

  it('does not decrement when clearing the override (investmentId null)', async () => {
    query.mockResolvedValueOnce({ rows: [{ old_status: 'error' }], rowCount: 1 });

    await overrideInvestment({ batchId: 5, rowId: 2, investmentId: null });

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when the row is not in a reviewable status', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const rowCount = await overrideInvestment({ batchId: 5, rowId: 2, investmentId: 88 });
    expect(rowCount).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
