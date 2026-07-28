import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from './helpers/mockLogger.js';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  withTransaction: vi.fn(async (cb) => cb({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

const getAdapter = vi.fn();
vi.mock('../src/services/importPipeline/adapters/index.js', () => ({
  getAdapter: (...args) => getAdapter(...args),
}));

const genericParseWithConfig = vi.fn().mockResolvedValue([]);
vi.mock('../src/services/importPipeline/adapters/generic.js', () => ({
  default: { name: 'generic', parseWithConfig: (...args) => genericParseWithConfig(...args) },
}));

import { stageBatch, createBatch } from '../src/services/importPipeline/stage.js';
import { createBatch as createPortfolioBatch } from '../src/services/portfolioImportPipeline/stage.js';
import { query } from '../src/database/connection.js';

const CONFIG = { dateColumn: 'D', recipientColumn: 'R', amountColumn: 'A' };

/**
 * The single boundary where a batch id enters the application. `import_batches.id`
 * is BIGSERIAL and node-postgres emits BIGINT as a STRING, so without this
 * normalization POST /api/import/csv answered `batch_id: "12"` while the
 * review-commit route (routes/importRoutes.js:570), which reads the id back off
 * the URL through `coercedIdSchema`, answered `batch_id: 12`.
 */
describe('createBatch normalizes the BIGSERIAL id to a number', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a NUMBER even though pg hands back a string', async () => {
    query.mockResolvedValue({ rows: [{ id: '12' }] });

    const id = await createBatch({ adapterName: 'vision' });

    expect(id).toBe(12);
    expect(typeof id).toBe('number');
  });

  it('does the same in the portfolio pipeline, so both agree on the wire', async () => {
    query.mockResolvedValue({ rows: [{ id: '12' }] });

    const id = await createPortfolioBatch({ adapterName: 'generic' });

    expect(id).toBe(12);
    expect(typeof id).toBe('number');
  });

  it('is exact for ids up to Number.MAX_SAFE_INTEGER (the documented ceiling)', async () => {
    query.mockResolvedValue({ rows: [{ id: String(Number.MAX_SAFE_INTEGER) }] });

    expect(await createBatch({ adapterName: 'vision' })).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('stageBatch adapter resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    genericParseWithConfig.mockResolvedValue([]);
  });

  it('falls back to the generic adapter when a named custom adapter is not in the registry', async () => {
    getAdapter.mockReturnValue(null); // "My Bank" is not a registered adapter

    await stageBatch({ batchId: 1, filePath: '/tmp/x.csv', adapterName: 'My Bank', customConfig: CONFIG });

    expect(genericParseWithConfig).toHaveBeenCalledWith('/tmp/x.csv', CONFIG);
  });

  it('uses a registered adapter\'s parseWithConfig when the name resolves', async () => {
    const adapterParseWithConfig = vi.fn().mockResolvedValue([]);
    getAdapter.mockReturnValue({ name: 'vision', parseWithConfig: adapterParseWithConfig, parse: vi.fn() });

    await stageBatch({ batchId: 2, filePath: '/tmp/y.csv', adapterName: 'vision', customConfig: CONFIG });

    expect(adapterParseWithConfig).toHaveBeenCalledWith('/tmp/y.csv', CONFIG);
    expect(genericParseWithConfig).not.toHaveBeenCalled();
  });

  it('throws for an unknown adapter when no customConfig is supplied', async () => {
    getAdapter.mockReturnValue(null);

    await expect(
      stageBatch({ batchId: 3, filePath: '/tmp/z.csv', adapterName: 'Nope' }),
    ).rejects.toThrow(/Unknown adapter/);
  });
});
