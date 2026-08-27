import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from './helpers/mockLogger.js';
import { mockConnection } from './helpers/repoMocks.js';
import { routeAgent, okEnvelope } from './helpers/routeApp.js';

// Mock the DB layer used by the settings repository
vi.mock('../src/database/connection.js', () => mockConnection());

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { query } from '../src/database/connection.js';
import settingsRepository from '../src/repositories/settingsRepository.js';
const { default: settingsRouter } = await import('../src/routes/settings.js');

const api = routeAgent(settingsRouter, { mountPath: '/api/settings' });
const BASE = '/api/settings';

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
    const res = await api.put(`${BASE}/dashboard_settings`).send(payload).expect(200);

    expect(res.body).toEqual(okEnvelope({ key: 'dashboard_settings', value: payload.value }));
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

  it('self-heals a legacy jsonb-string boolean on get (double-encoded row)', async () => {
    query.mockResolvedValue({ rows: [{ value: 'true' }] });
    const result = await settingsRepository.get('includeTransfers');
    expect(result).toBe(true);
  });

  it('does NOT type-flip string-valued keys whose value parses as JSON', async () => {
    // A cost_basis_method (string by contract) of "123" must stay the
    // string "123" — the legacy JSON.parse self-heal used to return 123.
    query.mockResolvedValue({ rows: [{ value: '123' }] });
    const result = await settingsRepository.get('cost_basis_method');
    expect(result).toBe('123');
  });

  it('getAll keeps string-valued keys as strings while self-healing others', async () => {
    query.mockResolvedValue({
      rows: [
        { key: 'cost_basis_method', value: 'true' },
        { key: 'includeTransfers', value: 'true' },
      ],
    });
    const result = await settingsRepository.getAll();
    expect(result).toEqual({
      cost_basis_method: 'true',
      includeTransfers: true,
    });
  });

  it('settingsRepository.setMany stores the values validated by the route without secondary coercion', async () => {
    query.mockResolvedValue({});

    await settingsRepository.setMany({
      dashboard_settings: {
        excludedCategoryIds: [1, 2],
        excludedRecipientIds: [10],
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

describe('rebalance_plans setting (ADR-098 custom rebalancing plans)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validPlan = {
    id: 'plan-1',
    name: 'My Custom Mix',
    targetWeights: { stocks: 0.7, bonds: 0.3 },
    cashCap: 5000,
  };

  it('accepts a valid list of plans and upserts it', async () => {
    query.mockResolvedValue({});

    const res = await api.put(`${BASE}/rebalance_plans`).send({ value: [validPlan] }).expect(200);

    expect(res.body).toEqual(okEnvelope({ key: 'rebalance_plans', value: [validPlan] }));
  });

  it('accepts a plan without a cashCap', async () => {
    query.mockResolvedValue({});
    const { cashCap: _cashCap, ...noCap } = validPlan;

    const res = await api.put(`${BASE}/rebalance_plans`).send({ value: [noCap] }).expect(200);

    expect(res.body).toEqual(okEnvelope({ key: 'rebalance_plans', value: [noCap] }));
  });

  it('rejects a non-array value', async () => {
    const res = await api.put(`${BASE}/rebalance_plans`).send({ value: { not: 'an array' } }).expect(400);
    expect(res.body.error.message).toMatch(/expected array/);
  });

  it('rejects a plan with a blank name', async () => {
    const res = await api.put(`${BASE}/rebalance_plans`)
      .send({ value: [{ ...validPlan, name: '   ' }] })
      .expect(400);
    expect(res.body.error.message).toMatch(/name must not be blank/);
  });

  it('rejects a plan with empty targetWeights', async () => {
    const res = await api.put(`${BASE}/rebalance_plans`)
      .send({ value: [{ ...validPlan, targetWeights: {} }] })
      .expect(400);
    expect(res.body.error.message).toMatch(/at least one sleeve/);
  });

  it('rejects a negative target weight', async () => {
    const res = await api.put(`${BASE}/rebalance_plans`)
      .send({ value: [{ ...validPlan, targetWeights: { stocks: -0.1 } }] })
      .expect(400);
    expect(res.body.error.message).toMatch(/non-negative number/);
  });

  it('rejects a negative cashCap', async () => {
    const res = await api.put(`${BASE}/rebalance_plans`)
      .send({ value: [{ ...validPlan, cashCap: -1 }] })
      .expect(400);
    expect(res.body.error.message).toMatch(/cashCap must be a non-negative number/);
  });

  it('returns an empty list as the default when unset', async () => {
    query.mockResolvedValue({ rows: [] });

    const res = await api.get(`${BASE}/rebalance_plans`).expect(200);

    expect(res.body).toEqual(okEnvelope({ key: 'rebalance_plans', value: [] }));
  });
});

describe('belgian_tax_profile setting validation (TODO E6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const put = async (key, value) => {
    query.mockResolvedValue({});
    return api.put(`${BASE}/${key}`).send({ value });
  };

  const validProfile = {
    profileConfigured: true,
    grossAnnualIncome: 55000,
    communalSurchargePercent: 7,
    dependentChildren: 2,
    childcareEligibleDays: 120,
    taxYear: 2026,
    additionalResidences: [{ cadastralIncome: 1200, centimesOverride: 1400 }],
  };

  it('accepts a well-formed profile', async () => {
    const res = await put('belgian_tax_profile', validProfile);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects a negative communal surcharge (would become a tax credit)', async () => {
    const res = await put('belgian_tax_profile', { ...validProfile, communalSurchargePercent: -7 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a fat-fingered 70% surcharge (10x the real 7.0)', async () => {
    const res = await put('belgian_tax_profile', { ...validProfile, communalSurchargePercent: 70 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects negative and absurd money fields', async () => {
    let res = await put('belgian_tax_profile', { ...validProfile, grossAnnualIncome: -50000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    res = await put('belgian_tax_profile', { ...validProfile, medicalExpenses: 1e15 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    res = await put('belgian_tax_profile', { ...validProfile, unionDues: 'lots' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects negative childcareEligibleDays and non-integer counts', async () => {
    let res = await put('belgian_tax_profile', { ...validProfile, childcareEligibleDays: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    res = await put('belgian_tax_profile', { ...validProfile, dependentChildren: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects bad additional residences and non-object profiles', async () => {
    let res = await put('belgian_tax_profile', {
      ...validProfile,
      additionalResidences: [{ cadastralIncome: -1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    res = await put('belgian_tax_profile', [validProfile]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates each snapshot in the year-keyed snapshots map', async () => {
    let res = await put('belgian_tax_profile_snapshots_v1', { 2025: validProfile });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    res = await put('belgian_tax_profile_snapshots_v1', {
      2025: { ...validProfile, communalSurchargePercent: -3 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires snapshot meta to be a year-keyed object map', async () => {
    let res = await put('belgian_tax_profile_snapshot_meta_v1', { 2025: { history: [] } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    res = await put('belgian_tax_profile_snapshot_meta_v1', { 2025: 'filed' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    res = await put('belgian_tax_profile_snapshot_meta_v1', 'nope');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('bulk PUT enforces the same profile rules', async () => {
    query.mockResolvedValue({});
    const res = await api.put(BASE)
      .send({ belgian_tax_profile: { ...validProfile, communalSurchargePercent: -1 } })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
