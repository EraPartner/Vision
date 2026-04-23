/**
 * Feature Flag Service tests.
 *
 * Covers: listFeatureFlags, getFeatureFlag, isFeatureEnabled, setFeatureFlag.
 * All repository calls are mocked — no DB required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/repositories/featureFlagRepository.js', () => ({
  default: {
    listAll: vi.fn(),
    findByKey: vi.fn(),
    isEnabled: vi.fn(),
    setEnabled: vi.fn(),
  },
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import featureFlagRepository from '../src/repositories/featureFlagRepository.js';
import {
  listFeatureFlags,
  getFeatureFlag,
  isFeatureEnabled,
  setFeatureFlag,
} from '../src/services/featureFlagService.js';
import { NotFoundError, ValidationError, AppError } from '../src/middleware/errorHandler.js';

const FLAG_AI = { id: 1, key: 'ai_chat', enabled: false, description: 'AI chat', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
const FLAG_AGG = { id: 2, key: 'aggregations_v2', enabled: true, description: 'Agg v2', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

beforeEach(() => vi.clearAllMocks());

// ── listFeatureFlags ──────────────────────────────────────────────────────────

describe('listFeatureFlags', () => {
  it('returns all flags from repository', async () => {
    featureFlagRepository.listAll.mockResolvedValue([FLAG_AI, FLAG_AGG]);

    const result = await listFeatureFlags();

    expect(result).toHaveLength(2);
    expect(result[0].key).toBe('ai_chat');
    expect(featureFlagRepository.listAll).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no flags exist', async () => {
    featureFlagRepository.listAll.mockResolvedValue([]);

    const result = await listFeatureFlags();

    expect(result).toEqual([]);
  });
});

// ── getFeatureFlag ────────────────────────────────────────────────────────────

describe('getFeatureFlag', () => {
  it('returns flag when key exists', async () => {
    featureFlagRepository.findByKey.mockResolvedValue(FLAG_AI);

    const result = await getFeatureFlag('ai_chat');

    expect(result).toEqual(FLAG_AI);
  });

  it('throws NotFoundError when key does not exist', async () => {
    featureFlagRepository.findByKey.mockResolvedValue(null);

    await expect(getFeatureFlag('unknown_flag')).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── isFeatureEnabled ──────────────────────────────────────────────────────────

describe('isFeatureEnabled', () => {
  it('returns true when flag is enabled', async () => {
    featureFlagRepository.isEnabled.mockResolvedValue(true);

    const result = await isFeatureEnabled('aggregations_v2');

    expect(result).toBe(true);
  });

  it('returns false when flag is disabled', async () => {
    featureFlagRepository.isEnabled.mockResolvedValue(false);

    const result = await isFeatureEnabled('ai_chat');

    expect(result).toBe(false);
  });

  it('returns false for unknown flag keys without throwing', async () => {
    featureFlagRepository.isEnabled.mockResolvedValue(false);

    const result = await isFeatureEnabled('does_not_exist');

    expect(result).toBe(false);
  });
});

// ── setFeatureFlag ────────────────────────────────────────────────────────────

describe('setFeatureFlag', () => {
  it('enables a flag and returns updated row', async () => {
    const updated = { ...FLAG_AI, enabled: true };
    featureFlagRepository.findByKey.mockResolvedValue(FLAG_AI);
    featureFlagRepository.setEnabled.mockResolvedValue(updated);

    const result = await setFeatureFlag('ai_chat', true);

    expect(result.enabled).toBe(true);
    expect(featureFlagRepository.setEnabled).toHaveBeenCalledWith('ai_chat', true);
  });

  it('disables a flag and returns updated row', async () => {
    const updated = { ...FLAG_AGG, enabled: false };
    featureFlagRepository.findByKey.mockResolvedValue(FLAG_AGG);
    featureFlagRepository.setEnabled.mockResolvedValue(updated);

    const result = await setFeatureFlag('aggregations_v2', false);

    expect(result.enabled).toBe(false);
  });

  it('throws ValidationError when enabled is not a boolean', async () => {
    await expect(setFeatureFlag('ai_chat', 'yes')).rejects.toBeInstanceOf(ValidationError);
    await expect(setFeatureFlag('ai_chat', 1)).rejects.toBeInstanceOf(ValidationError);
    await expect(setFeatureFlag('ai_chat', null)).rejects.toBeInstanceOf(ValidationError);
    expect(featureFlagRepository.findByKey).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when key does not exist', async () => {
    featureFlagRepository.findByKey.mockResolvedValue(null);

    await expect(setFeatureFlag('ghost_flag', true)).rejects.toBeInstanceOf(NotFoundError);
    expect(featureFlagRepository.setEnabled).not.toHaveBeenCalled();
  });

  it('throws AppError when repository returns null after update', async () => {
    featureFlagRepository.findByKey.mockResolvedValue(FLAG_AI);
    featureFlagRepository.setEnabled.mockResolvedValue(null);

    await expect(setFeatureFlag('ai_chat', true)).rejects.toBeInstanceOf(AppError);
  });
});
