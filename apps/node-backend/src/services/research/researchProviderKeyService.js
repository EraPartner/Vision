/**
 * Research provider API-key service (ADR-079).
 *
 * Backs the Settings UI for managing keyed-provider API keys. Persists to
 * provider_api_keys (migration 0043) and keeps the in-memory override map in
 * providerKeys in sync so changes take effect immediately (no restart). Keys are
 * masked in responses and never returned in full.
 */

import * as keyRepo from '../../repositories/providerApiKeyRepository.js';
import {
  KEYED_PROVIDERS,
  ENV_VAR_BY_PROVIDER,
  providerKey,
  keySource,
  setKeyOverride,
  loadKeyOverrides,
} from './providerKeys.js';
import { ValidationError } from '../../middleware/errorHandler.js';

const LABELS = Object.freeze({
  twelve_data: 'Twelve Data',
  finnhub: 'Finnhub',
  fmp: 'FMP',
  alpha_vantage: 'Alpha Vantage',
  fred: 'FRED (economic data)',
});

/**
 * Mask a key to its last 4 chars; never expose the full value.
 * @param {string | undefined} key
 */
function mask(key) {
  if (!key) return undefined;
  return key.length > 4 ? `••••${key.slice(-4)}` : '••••';
}

/** Load persisted overrides into the in-memory map. Call once at startup. */
export async function hydrate() {
  const rows = await keyRepo.listAll();
  loadKeyOverrides(rows);
  return rows.length;
}

/**
 * Status of every keyed provider for the Settings UI. Never includes a full key.
 * @returns {Promise<Array<{
 *   provider: string,
 *   label: string,
 *   envVar: string | undefined,
 *   configured: boolean,
 *   source: 'settings' | 'env' | 'none',
 *   masked: string | undefined,
 * }>>}
 */
export async function listKeyStatuses() {
  return KEYED_PROVIDERS.map((provider) => {
    const source = keySource(provider);
    return {
      provider,
      label: LABELS[/** @type {keyof typeof LABELS} */ (provider)] ?? provider,
      envVar: ENV_VAR_BY_PROVIDER[/** @type {keyof typeof ENV_VAR_BY_PROVIDER} */ (provider)],
      configured: source !== 'none',
      source, // 'settings' | 'env' | 'none'
      masked: mask(providerKey(provider)),
    };
  });
}

/** @param {string} provider */
function assertKeyedProvider(provider) {
  if (!KEYED_PROVIDERS.includes(provider)) {
    throw new ValidationError(`Unknown keyed provider: ${provider}`);
  }
}

/**
 * Store (or replace) a provider's key. Updates DB + in-memory override.
 * @param {string} provider
 * @param {string} apiKey
 */
export async function setKey(provider, apiKey) {
  assertKeyedProvider(provider);
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmed) throw new ValidationError('api_key must be a non-empty string');
  await keyRepo.upsert(provider, trimmed);
  setKeyOverride(provider, trimmed);
}

/**
 * Clear a provider's stored key (env fallback, if any, then applies).
 * @param {string} provider
 * @returns {Promise<boolean>}
 */
export async function clearKey(provider) {
  assertKeyedProvider(provider);
  const removed = await keyRepo.remove(provider);
  setKeyOverride(provider, undefined);
  return removed;
}
