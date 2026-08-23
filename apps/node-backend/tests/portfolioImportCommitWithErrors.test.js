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

vi.mock('../src/services/info/cache.js', () => ({
  invalidatePortfolioCaches: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import { commitBatch } from '../src/services/portfolioImportPipeline/commit.js';
import { commitPortfolioImport } from '../src/services/portfolioImportPipeline/index.js';
import {
  lockInvestmentResolutionRows,
  overrideInvestment,
  overrideInvestments,
} from '../src/repositories/portfolioImportBatchRepository.js';

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

describe('overrideInvestments — atomic row-set guard', () => {
  it('updates the complete eligible set in one statement and repairs error counters once', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          requested_count: 3,
          eligible_count: 3,
          updated_count: 3,
          reset_error_count: 2,
        }],
        rowCount: 1,
      })
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
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/counts\.requested_count = counts\.eligible_count/);
    expect(sql).toMatch(/ORDER BY r\.id\s+FOR UPDATE OF r/);
    expect(sql).toMatch(/FOR UPDATE OF r/);
    expect(params).toEqual([5, [10, 11, 12], 88]);
    expect(query.mock.calls[1][1]).toEqual([5, 2]);
  });

  it('performs no update and no counter write when one requested row is ineligible', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        requested_count: 3,
        eligible_count: 2,
        updated_count: 0,
        reset_error_count: 0,
      }],
      rowCount: 1,
    });

    const result = await overrideInvestments({
      batchId: 5,
      rowIds: [10, 11, 999],
      investmentId: 88,
    });

    expect(result.updatedCount).toBe(0);
    expect(result.eligibleCount).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('lockInvestmentResolutionRows — batch-first serialization', () => {
  it('locks the batch before locking the complete ordered row set', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'awaiting_review', is_brokerage: false }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          { id: 10, status: 'matched', user_override_investment_id: null },
          { id: 11, status: 'error', user_override_investment_id: null },
        ],
        rowCount: 2,
      });

    const result = await lockInvestmentResolutionRows({ batchId: 5, rowIds: [11, 10] });

    expect(result.batchStatus).toBe('awaiting_review');
    expect(query.mock.calls[0][0]).toMatch(/portfolio_import_batches[\s\S]*FOR UPDATE/);
    expect(query.mock.calls[1][0]).toMatch(/ORDER BY id\s+FOR UPDATE/);
    expect(query.mock.calls[1][1]).toEqual([5, [11, 10]]);
  });

  it('does not try to lock rows when the batch does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(lockInvestmentResolutionRows({ batchId: 999, rowIds: [10] }))
      .resolves.toEqual({ batchStatus: undefined, rows: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
