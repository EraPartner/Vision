import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  withTransaction: vi.fn(async (cb) => cb({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const getAdapter = vi.fn();
vi.mock('../src/services/importPipeline/adapters/index.js', () => ({
  getAdapter: (...args) => getAdapter(...args),
}));

const genericParseWithConfig = vi.fn().mockResolvedValue([]);
vi.mock('../src/services/importPipeline/adapters/generic.js', () => ({
  default: { name: 'generic', parseWithConfig: (...args) => genericParseWithConfig(...args) },
}));

import { stageBatch } from '../src/services/importPipeline/stage.js';

const CONFIG = { dateColumn: 'D', recipientColumn: 'R', amountColumn: 'A' };

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
