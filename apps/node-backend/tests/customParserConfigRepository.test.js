import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockConnection } from './helpers/repoMocks.js';
vi.mock('../src/database/connection.js', () => mockConnection());

import { query } from '../src/database/connection.js';
import repo from '../src/repositories/customParserConfigRepository.js';

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

function dbRow(overrides = {}) {
  return {
    id: 1,
    name: 'My Bank',
    config_json: SAMPLE_CONFIG,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('customParserConfigRepository.getAll', () => {
  beforeEach(() => vi.clearAllMocks());

  it('orders by name and maps config_json to config', async () => {
    query.mockResolvedValue({ rows: [dbRow()] });
    const result = await repo.getAll();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY name ASC'), ['transaction']);
    expect(result[0]).toMatchObject({ id: 1, name: 'My Bank', config: SAMPLE_CONFIG });
    expect(result[0]).not.toHaveProperty('config_json');
  });

  it('parses config_json when stored as a string', async () => {
    query.mockResolvedValue({ rows: [dbRow({ config_json: JSON.stringify(SAMPLE_CONFIG) })] });
    const result = await repo.getAll();
    expect(result[0].config).toEqual(SAMPLE_CONFIG);
  });
});

describe('customParserConfigRepository.getById / getByName', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when not found', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await repo.getById(99)).toBeUndefined();
    expect(await repo.getByName('nope')).toBeUndefined();
  });

  it('returns a mapped row when found', async () => {
    query.mockResolvedValue({ rows: [dbRow()] });
    const result = await repo.getById(1);
    expect(result).toMatchObject({ id: 1, config: SAMPLE_CONFIG });
  });
});

describe('customParserConfigRepository.create', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts name + serialized config and returns the mapped row', async () => {
    query.mockResolvedValue({ rows: [dbRow()] });
    const result = await repo.create({ name: 'My Bank', config: SAMPLE_CONFIG });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO custom_parser_configs');
    expect(params[0]).toBe('My Bank');
    expect(params[1]).toBe('transaction'); // kind
    expect(JSON.parse(params[2])).toEqual(SAMPLE_CONFIG);
    expect(result.config).toEqual(SAMPLE_CONFIG);
  });
});

describe('customParserConfigRepository.update', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only updates provided fields', async () => {
    query.mockResolvedValue({ rows: [dbRow({ name: 'Renamed' })] });
    await repo.update(1, { name: 'Renamed' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('name = $1');
    expect(sql).not.toContain('config_json = ');
    expect(params).toEqual(['Renamed', 1]);
  });

  it('serializes config when provided', async () => {
    query.mockResolvedValue({ rows: [dbRow()] });
    await repo.update(1, { config: SAMPLE_CONFIG });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('config_json = $1::jsonb');
    expect(JSON.parse(params[0])).toEqual(SAMPLE_CONFIG);
  });

  it('returns the existing row without a query when no fields change', async () => {
    query.mockResolvedValue({ rows: [dbRow()] });
    await repo.update(1, {});
    // getById is the only query
    expect(query.mock.calls[0][0]).toContain('WHERE id = $1');
  });
});

describe('customParserConfigRepository.delete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when a row was deleted', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
    expect(await repo.delete(1)).toBe(true);
  });

  it('returns false when nothing was deleted', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await repo.delete(99)).toBe(false);
  });
});
