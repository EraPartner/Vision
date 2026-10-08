import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockConnection } from './helpers/repoMocks.ts';
import { mockLogger } from './helpers/mockLogger.ts';
vi.mock('../src/database/connection.ts', () => mockConnection());
vi.mock('../src/config/logger.ts', () => ({ logger: mockLogger() }));

import { query as rawQuery } from '../src/database/connection.ts';
import { logger } from '../src/config/logger.ts';
import type { PgQueryResult } from '../src/database/connection.ts';
import repo from '../src/repositories/customParserConfigRepository.ts';
import { partial } from './helpers/partial.ts';

const query = vi.mocked(rawQuery);

const SAMPLE_CONFIG = {
  dateColumn: 'Date',
  recipientColumn: 'Name',
  amountColumn: 'Amount',
  memoColumn: '',
  dateFormat: '%Y-%m-%d',
  separator: ',',
  encoding: 'utf-8',
  skipRows: 0,
};

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'My Bank',
    kind: 'transaction',
    config_json: SAMPLE_CONFIG,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('customParserConfigRepository.getAll', () => {
  beforeEach(() => vi.clearAllMocks());

  it('orders by name and maps config_json to config', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [dbRow()] }));
    const result = await repo.getAll();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY name ASC'), ['transaction']);
    expect(result[0]).toMatchObject({ id: 1, name: 'My Bank', config: SAMPLE_CONFIG });
    expect(result[0]).not.toHaveProperty('config_json');
  });

  it('parses config_json when stored as a string', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [dbRow({ config_json: JSON.stringify(SAMPLE_CONFIG) })] }));
    const result = await repo.getAll();
    expect(result[0].config).toEqual(SAMPLE_CONFIG);
  });
});

describe('customParserConfigRepository.getById / getByName', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when not found', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [] }));
    expect(await repo.getById(99)).toBeUndefined();
    expect(await repo.getByName('nope')).toBeUndefined();
  });

  it('returns a mapped row when found', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [dbRow()] }));
    const result = await repo.getById(1);
    expect(result).toMatchObject({ id: 1, config: SAMPLE_CONFIG });
  });
});

describe('customParserConfigRepository.create', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts name + serialized config and returns the mapped row', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [dbRow()] }));
    const result = await repo.create({ name: 'My Bank', config: SAMPLE_CONFIG });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO custom_parser_configs');
    expect(params![0]).toBe('My Bank');
    expect(params![1]).toBe('transaction'); // kind
    expect(JSON.parse(params![2] as string)).toEqual(SAMPLE_CONFIG);
    expect(result.config).toEqual(SAMPLE_CONFIG);
  });
});

describe('customParserConfigRepository.update', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only updates provided fields', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [dbRow({ name: 'Renamed' })] }));
    await repo.update(1, { name: 'Renamed' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('name = $1');
    expect(sql).not.toContain('config_json = ');
    expect(params).toEqual(['Renamed', 1]);
  });

  it('serializes config when provided', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [dbRow()] }));
    await repo.update(1, { config: SAMPLE_CONFIG });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('config_json = $1::jsonb');
    expect(JSON.parse(params![0] as string)).toEqual(SAMPLE_CONFIG);
  });

  it('returns the existing row without a query when no fields change', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [dbRow()] }));
    await repo.update(1, {});
    // getById is the only query
    expect(query.mock.calls[0][0]).toContain('WHERE id = $1');
  });
});

describe('customParserConfigRepository.delete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when a row was deleted', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [{ id: 1 }] }));
    expect(await repo.delete(1)).toBe(true);
  });

  it('returns false when nothing was deleted', async () => {
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [] }));
    expect(await repo.delete(99)).toBe(false);
  });
});

// Stored config_json must still pass the save-path schema of its kind
// (lib/parserConfigSchema.ts). A row that does not is a data-contract
// violation: strict in tests/development, logged and passed through in
// production — never a 400.
describe('customParserConfigRepository stored config contract', () => {
  const PORTFOLIO_CONFIG = { dateColumn: 'Date', symbolColumn: 'Ticker', defaultAssetClass: 'stock' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('accepts stored configs of both kinds, including legacy rows without number_format', async () => {
    query.mockResolvedValue(
      partial<PgQueryResult>({
        rows: [dbRow(), dbRow({ id: 2, kind: 'portfolio', config_json: PORTFOLIO_CONFIG })],
      }),
    );
    const result = await repo.getAll();
    expect(result.map((r) => r.config)).toEqual([SAMPLE_CONFIG, PORTFOLIO_CONFIG]);
  });

  it('throws on a stored config the save path would reject, naming paths but not values', async () => {
    query.mockResolvedValue(
      partial<PgQueryResult>({
        rows: [dbRow({ id: 7, config_json: { ...SAMPLE_CONFIG, amountColumn: '', encoding: 'SECRET-ENC' } })],
      }),
    );
    const error = await repo.getById(7).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Data contract violated: custom_parser_configs row 7 at config.amountColumn (custom), config.encoding (custom)',
    );
    expect((error as Error).message).not.toContain('SECRET-ENC');
    expect(error).not.toHaveProperty('status');
  });

  it('checks a portfolio row against the portfolio schema', async () => {
    query.mockResolvedValue(
      partial<PgQueryResult>({
        rows: [dbRow({ kind: 'portfolio', config_json: { dateColumn: 'Date', defaultAssetClass: 'stock' } })],
      }),
    );
    await expect(repo.getById(1)).rejects.toThrow('custom_parser_configs row 1 at config (custom)');
  });

  it('logs issue paths and passes the stored config through unchanged in production', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('ENVIRONMENT', '');
    vi.stubEnv('NODE_ENV', 'production');
    const broken = { ...SAMPLE_CONFIG, dateColumn: 42, encoding: 'SECRET-ENC' };
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [dbRow({ config_json: broken })] }));

    const result = await repo.getById(1);

    expect(result?.config).toBe(broken);
    expect(logger.warn).toHaveBeenCalledWith(
      '[data-contract] custom_parser_configs row 1 does not match its schema',
      { issues: ['config.dateColumn (custom)', 'config.encoding (custom)'], issueCount: 2 },
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('SECRET-ENC');
  });
});
