import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB layer used by the settings repository
vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import settingsRepository from '../src/repositories/settingsRepository.js';
import settingsRouter from '../src/routes/settings.js';
import express from 'express';
import bodyParser from 'body-parser';
import request from 'supertest';

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
    const app = express();
    app.use(bodyParser.json());
    app.use('/api/settings', settingsRouter);

    // Mock repository.set to return the saved key/value
    query.mockResolvedValue({});

    const payload = { value: { excludedCategoryIds: [7], excludedRecipientIds: [8] } };
    const resp = await request(app)
      .put('/api/settings/dashboard_settings')
      .send(payload)
      .expect(200);

    expect(resp.body).toEqual({ key: 'dashboard_settings', value: payload.value });
  });
});
