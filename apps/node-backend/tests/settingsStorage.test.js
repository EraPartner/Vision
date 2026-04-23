import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer used by the settings repository
vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...args) => { routeHandlers[`get:${path}`] = args[args.length - 1]; }),
  post: vi.fn((path, ...args) => { routeHandlers[`post:${path}`] = args[args.length - 1]; }),
  put: vi.fn((path, ...args) => { routeHandlers[`put:${path}`] = args[args.length - 1]; }),
  patch: vi.fn((path, ...args) => { routeHandlers[`patch:${path}`] = args[args.length - 1]; }),
  delete: vi.fn((path, ...args) => { routeHandlers[`delete:${path}`] = args[args.length - 1]; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { query } from '../src/database/connection.js';
import settingsRepository from '../src/repositories/settingsRepository.js';
await import('../src/routes/settings.js');

describe('Settings storage and retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('settingsRepository.set should call DB and return saved key/value', async () => {
    // Make query resolve as successful insert
    query.mockResolvedValue({});

    const key = 'dashboard_settings';
    const value = { excludedCategoryIds: [1, 2], excludedRecipientIds: [10] };

    const res = await settingsRepository.set(key, value);
    expect(res).toEqual({ key, value });

    // Ensure DB was called with the key and JSON payload.
    expect(query).toHaveBeenCalled();
    const upsertCall = query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO user_settings'));
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[1][0]).toBe(key);
    expect(upsertCall[1][1]).toBe(JSON.stringify(value));
  });

  it('settingsRepository.set should serialize primitive arrays as JSON', async () => {
    query.mockResolvedValue({});

    const key = 'dismissed_recurring_patterns';
    const value = [373];

    const res = await settingsRepository.set(key, value);
    expect(res).toEqual({ key, value });

    const upsertCall = query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO user_settings'));
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[1][0]).toBe(key);
    expect(upsertCall[1][1]).toBe('[373]');
  });

  it('settingsRepository.get should return parsed value from DB', async () => {
    const key = 'dashboard_settings';
    const stored = { excludedCategoryIds: [5], excludedRecipientIds: [6] };
    query.mockResolvedValue({ rows: [{ value: stored }] });

    const result = await settingsRepository.get(key);
    expect(result).toEqual(stored);
    expect(query).toHaveBeenCalledWith('SELECT value FROM user_settings WHERE key = $1', [key]);
  });

  it('settings API routes should upsert and return settings', async () => {
    query.mockResolvedValue({});

    const payload = { value: { excludedCategoryIds: [7], excludedRecipientIds: [8] } };
    const req = { params: { key: 'dashboard_settings' }, body: payload };
    const res = mockResponse();

    await routeHandlers['put:/:key'](req, res);

    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { key: 'dashboard_settings', value: payload.value } });
  });

  it('settingsRepository.getAll should parse JSON string values and preserve invalid JSON strings', async () => {
    query.mockResolvedValue({
      rows: [
        { key: 'dashboard_settings', value: '{"excludedCategoryIds":[1]}' },
        { key: 'raw_string', value: 'not-json' },
      ],
    });

    const result = await settingsRepository.getAll();

    expect(result).toEqual({
      dashboard_settings: { excludedCategoryIds: [1] },
      raw_string: 'not-json',
    });
  });

  it('settingsRepository.setMany should normalize object values before bulk upsert', async () => {
    query.mockResolvedValue({});

    await settingsRepository.setMany({
      dashboard_settings: {
        excludedCategoryIds: ['1', '2'],
        excludedRecipientIds: ['10'],
      },
    });

    const upsertCall = query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO user_settings'));
    expect(upsertCall).toBeTruthy();
    expect(upsertCall[1][0]).toEqual(['dashboard_settings']);
    expect(upsertCall[1][1]).toEqual([
      JSON.stringify({
        excludedCategoryIds: [1, 2],
        excludedRecipientIds: [10],
      }),
    ]);
  });

  it('settingsRepository.setMany should return early for empty object payload', async () => {
    query.mockResolvedValue({});

    await settingsRepository.setMany({});

    const hasBulkUpsert = query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO user_settings')
    );
    expect(hasBulkUpsert).toBe(false);
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
}
