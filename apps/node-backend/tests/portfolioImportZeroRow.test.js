import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
import { mockConnection } from './helpers/repoMocks.js';
// Zero-row import guard (TODO E9): a bad column mapping (nonexistent date
// column, wrong date format) null-parses every row — the adapter skips them
// all and the batch used to auto-complete {imported: 0, errors: 0} with a
// success toast. The pipeline also dropped the adapter's `skipped` count, so
// a partially unparseable file looked fully imported.

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));
vi.mock('../src/database/connection.js', () =>
  mockConnection({ query: vi.fn().mockResolvedValue({ rows: [{ is_brokerage: false }] }) }));
vi.mock('../src/services/info/cache.js', () => ({ invalidatePortfolioCaches: vi.fn() }));
vi.mock('../src/services/portfolioImportPipeline/stage.js', () => ({
  createBatch: vi.fn().mockResolvedValue(42),
  stageBatch: vi.fn(),
}));
vi.mock('../src/services/portfolioImportPipeline/validate.js', () => ({
  validateBatch: vi.fn().mockResolvedValue({ errors: 0 }),
}));
vi.mock('../src/services/portfolioImportPipeline/matchInvestments.js', () => ({
  matchBatch: vi.fn().mockResolvedValue({ matchSourceCounts: { symbol: 5 }, unresolved: 0 }),
}));
vi.mock('../src/services/portfolioImportPipeline/commit.js', () => ({
  commitBatch: vi.fn().mockResolvedValue({ imported: 5, duplicates: 0, errors: 0 }),
}));

import { query } from '../src/database/connection.js';
import { stageBatch } from '../src/services/portfolioImportPipeline/stage.js';
import { validateBatch } from '../src/services/portfolioImportPipeline/validate.js';
import { matchBatch } from '../src/services/portfolioImportPipeline/matchInvestments.js';
import { ValidationError } from '../src/middleware/errorHandler.js';
import { prepareImport, runPortfolioImportPipeline } from '../src/services/portfolioImportPipeline/index.js';

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [{ is_brokerage: false }] });
  validateBatch.mockResolvedValue({ errors: 0 });
  matchBatch.mockResolvedValue({ matchSourceCounts: { symbol: 5 }, unresolved: 0 });
});

describe('portfolio import zero-row guard', () => {
  it('rejects a batch where every row failed to parse, before validation runs', async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 0, rowsSkipped: 7 });

    await expect(prepareImport({ batchId: 42, filePath: '/tmp/f.csv', customConfig: {} }))
      .rejects.toThrowError(/all 7 data rows failed to parse/);
    await expect(prepareImport({ batchId: 42, filePath: '/tmp/f.csv', customConfig: {} }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(validateBatch).not.toHaveBeenCalled();
  });

  it('rejects an empty file with a distinct message', async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 0, rowsSkipped: 0 });

    await expect(prepareImport({ batchId: 42, filePath: '/tmp/f.csv', customConfig: {} }))
      .rejects.toThrowError(/No importable rows found/);
  });

  it('marks the batch failed when the full pipeline hits the guard', async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 0, rowsSkipped: 3 });

    await expect(runPortfolioImportPipeline({ filePath: '/tmp/f.csv', adapterName: 'x', customConfig: {} }))
      .rejects.toBeInstanceOf(ValidationError);

    const failedUpdate = query.mock.calls.find(([sql]) => /SET status = 'failed'/.test(sql));
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate[1][0]).toBe(42);
    expect(failedUpdate[1][1]).toMatch(/failed to parse/);
  });
});

describe('portfolio import skipped-count propagation', () => {
  it('returns the skipped count on the auto-commit path', async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 5, rowsSkipped: 3 });

    const result = await runPortfolioImportPipeline({ filePath: '/tmp/f.csv', adapterName: 'x', customConfig: {} });

    expect(result).toMatchObject({ total: 5, skipped: 3, imported: 5, requiresReview: false });
  });

  it('returns the skipped count on the review path', async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 5, rowsSkipped: 2 });
    matchBatch.mockResolvedValue({ matchSourceCounts: { symbol: 3 }, unresolved: 2 });

    const result = await runPortfolioImportPipeline({ filePath: '/tmp/f.csv', adapterName: 'x', customConfig: {} });

    expect(result).toMatchObject({ total: 5, skipped: 2, requiresReview: true });
  });
});
