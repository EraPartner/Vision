import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConnectionModule({
  settings = {
    database: {
      url: 'postgresql://test',
      poolSize: 5,
      maxOverflow: 10,
      echo: false,
    },
  },
} = {}) {
  vi.resetModules();

  const pool = {
    on: vi.fn(),
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    totalCount: 3,
    idleCount: 2,
    waitingCount: 1,
  };

  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  const poolCtor = vi.fn().mockImplementation(function MockPool() {
    return pool;
  });

  vi.doMock('pg', () => ({
    default: {
      Pool: poolCtor,
    },
  }));

  vi.doMock('../src/config/config.js', () => ({
    getSettings: vi.fn(() => settings),
  }));

  vi.doMock('../src/config/logger.js', () => ({
    logger,
  }));

  const module = await import('../src/database/connection.js');
  return { module, pool, poolCtor, logger };
}

describe('database connection module', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('logs idle client pool errors through logger.error', async () => {
    const { pool, logger } = await loadConnectionModule();

    const onErrorCall = pool.on.mock.calls.find(([event]) => event === 'error');
    expect(onErrorCall).toBeDefined();

    const err = new Error('idle client failure');
    onErrorCall[1](err);

    expect(logger.error).toHaveBeenCalledWith('Unexpected error on idle database client', err);
  });

  it('query retries once on transient ECONNRESET and then succeeds', async () => {
    vi.useFakeTimers();
    const { module, pool, logger } = await loadConnectionModule();

    pool.query
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ rows: [{ ok: true }] });

    const queryPromise = module.query('SELECT 1', [], { retries: 1 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await queryPromise;

    expect(result).toEqual({ rows: [{ ok: true }] });
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('query does not retry non-transient errors', async () => {
    const { module, pool, logger } = await loadConnectionModule();
    const err = Object.assign(new Error('syntax'), { code: '42601' });
    pool.query.mockRejectedValueOnce(err);

    await expect(module.query('SELECT bad', [], { retries: 2 })).rejects.toThrow('syntax');

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('query throws after max retries for transient errors and logs error', async () => {
    vi.useFakeTimers();
    const { module, pool, logger } = await loadConnectionModule();

    const transient = Object.assign(new Error('Connection terminated by server'), { code: '08006' });
    pool.query.mockRejectedValue(transient);

    const queryPromise = module.query('SELECT 1', [], { retries: 1 });
    const rejectionAssertion = expect(queryPromise).rejects.toThrow('Connection terminated by server');
    await vi.advanceTimersByTimeAsync(200);

    await rejectionAssertion;
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('checkConnection returns true on success and false on failure', async () => {
    const loaded = await loadConnectionModule();
    loaded.pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(loaded.module.checkConnection()).resolves.toBe(true);

    loaded.pool.query.mockRejectedValueOnce(new Error('down'));
    await expect(loaded.module.checkConnection()).resolves.toBe(false);
  });

  it('getTableCount parses integer from rows[0].count', async () => {
    const { module, pool } = await loadConnectionModule();
    pool.query.mockResolvedValueOnce({ rows: [{ count: '42' }] });

    await expect(module.getTableCount()).resolves.toBe(42);
  });

  it('getPoolStats exposes pool counters and configured maxConnections', async () => {
    const { module } = await loadConnectionModule({
      settings: {
        database: {
          url: 'postgresql://test',
          poolSize: 4,
          maxOverflow: 12,
          echo: false,
        },
      },
    });

    expect(module.getPoolStats()).toEqual({
      totalCount: 3,
      idleCount: 2,
      waitingCount: 1,
      maxConnections: 12,
    });
  });

  it('closePool calls pool.end', async () => {
    const { module, pool } = await loadConnectionModule();
    pool.end.mockResolvedValueOnce(undefined);

    await module.closePool();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('queryPrepared sends named prepared statement object to pool.query', async () => {
    const { module, pool } = await loadConnectionModule();
    pool.query.mockResolvedValueOnce({ rows: [] });

    await module.queryPrepared('select-one', 'SELECT 1', [1]);

    expect(pool.query).toHaveBeenCalledWith({
      name: 'select-one',
      text: 'SELECT 1',
      values: [1],
    });
  });

  it('getClient proxies to pool.connect', async () => {
    const { module, pool } = await loadConnectionModule();
    const mockClient = { release: vi.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);

    await expect(module.getClient()).resolves.toBe(mockClient);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });
});
