/**
 * Research provider API-key service (ADR-079).
 *
 * Backs the Settings UI for managing keyed-provider API keys. Persists to
 * provider_api_keys (migration 0043) and keeps the in-memory override map in
 * providerKeys in sync so changes take effect immediately (no restart). Keys are
 * masked in responses and never returned in full.
 */

import * as keyRepo from '../../repositories/providerApiKeyRepository.ts';
import {
  KEYED_PROVIDERS,
  ENV_VAR_BY_PROVIDER,
  providerKey,
  keySource,
  setKeyOverride,
  loadKeyOverrides,
} from './providerKeys.ts';
import { ValidationError } from '../../middleware/errorHandler.ts';

const LABELS = Object.freeze({
  twelve_data: 'Twelve Data',
  finnhub: 'Finnhub',
  fmp: 'FMP',
  alpha_vantage: 'Alpha Vantage',
  fred: 'FRED (economic data)',
});

/** Mask a key to its last 4 chars; never expose the full value. */
function mask(key: string | undefined) {
  if (!key) return undefined;
  return key.length > 4 ? `••••${key.slice(-4)}` : '••••';
}

/** Load persisted overrides into the in-memory map. Call once at startup. */
export async function hydrate() {
  const rows = await keyRepo.listAll();
  loadKeyOverrides(rows);
  return rows.length;
}

export interface ProviderKeyStatus {
  provider: string;
  label: string;
  envVar: string | undefined;
  configured: boolean;
  source: 'settings' | 'env' | 'none';
  masked: string | undefined;
}

/** Status of every keyed provider for the Settings UI. Never includes a full key. */
export async function listKeyStatuses(): Promise<ProviderKeyStatus[]> {
  return KEYED_PROVIDERS.map((provider) => {
    const source = keySource(provider);
    return {
      provider,
      label: LABELS[provider as keyof typeof LABELS] ?? provider,
      envVar: ENV_VAR_BY_PROVIDER[provider as keyof typeof ENV_VAR_BY_PROVIDER],
      configured: source !== 'none',
      source, // 'settings' | 'env' | 'none'
      masked: mask(providerKey(provider)),
    };
  });
}

function assertKeyedProvider(provider: string) {
  if (!KEYED_PROVIDERS.includes(provider)) {
    throw new ValidationError(`Unknown keyed provider: ${provider}`);
  }
}

/** Store (or replace) a provider's key. Updates DB + in-memory override. */
export async function setKey(provider: string, apiKey: string) {
  assertKeyedProvider(provider);
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmed) throw new ValidationError('api_key must be a non-empty string');
  await keyRepo.upsert(provider, trimmed);
  setKeyOverride(provider, trimmed);
}

/** Clear a provider's stored key (env fallback, if any, then applies). */
export async function clearKey(provider: string): Promise<boolean> {
  assertKeyedProvider(provider);
  const removed = await keyRepo.remove(provider);
  setKeyOverride(provider, undefined);
  return removed;
}
