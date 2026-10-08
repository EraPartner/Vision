/**
 * Provider API-key gating (ADR-079).
 *
 * Providers that require an API key are only usable when that key is configured.
 * A key can come from two sources, in precedence order:
 *   1. a Settings-managed override (persisted in provider_api_keys, migration 0043)
 *   2. the environment variable (root `.env`, ADR-080)
 * The Settings value wins so the in-app UI can override deployment config. A
 * provider with no key from either source is dropped from the capability chain by
 * the aggregator. Yahoo / Binance / Kinesis need no key.
 *
 * Overrides live in a sync in-memory map hydrated from the DB at startup and
 * updated on Settings changes, so `providerKey`/`isProviderKeyed` stay synchronous
 * for the adapters and the aggregator's usability gate.
 */

/** Provider key → required environment variable. */
export const ENV_VAR_BY_PROVIDER = Object.freeze({
  twelve_data: 'TWELVE_DATA_API_KEY',
  finnhub: 'FINNHUB_API_KEY',
  fmp: 'FMP_API_KEY',
  alpha_vantage: 'ALPHA_VANTAGE_API_KEY',
  fred: 'FRED_API_KEY', // macro vertical (ADR-082); Eurostat/DBnomics are keyless
});

/** The keyed provider list (those that require an API key). */
export const KEYED_PROVIDERS = Object.freeze(Object.keys(ENV_VAR_BY_PROVIDER));

export type KeyedProvider = keyof typeof ENV_VAR_BY_PROVIDER;

/** String-keyed view of ENV_VAR_BY_PROVIDER for lookups by arbitrary provider. */
const ENV_VAR_LOOKUP: Readonly<Record<string, string | undefined>> =
  ENV_VAR_BY_PROVIDER;

/** provider → Settings-managed key override. */
const overrides = new Map<string, string>();

/**
 * Set or clear a single override (used by the Settings service on change).
 * @param value  falsy clears the override
 */
export function setKeyOverride(provider: string, value: string | undefined) {
  const trimmed = value && String(value).trim();
  if (trimmed) overrides.set(provider, trimmed);
  else overrides.delete(provider);
}

/**
 * Replace all overrides from persisted rows (used at startup hydration).
 */
export function loadKeyOverrides(
  rows: Array<{ provider: string; api_key: string }>,
) {
  overrides.clear();
  for (const row of rows || []) {
    if (row?.provider && row?.api_key) overrides.set(row.provider, String(row.api_key).trim());
  }
}

function envKey(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  const varName = ENV_VAR_LOOKUP[provider];
  if (!varName) return undefined;
  const value = env[varName];
  return value && String(value).trim() ? String(value).trim() : undefined;
}

/**
 * The effective API key for a provider, or undefined. Settings override > env.
 */
export function providerKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return overrides.get(provider) ?? envKey(provider, env);
}

/**
 * Effective key for a keyed provider, or the provider's configuration error.
 * Adapter request builders use this so all five keyed providers share one guard.
 */
export function requireProviderKey(
  provider: KeyedProvider,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = providerKey(provider, env);
  if (!key) throw new Error(`${ENV_VAR_BY_PROVIDER[provider]} not configured`);
  return key;
}

/**
 * True if the provider needs no key, or has one from settings or env.
 */
export function isProviderKeyed(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!ENV_VAR_LOOKUP[provider]) return true; // no key required
  return Boolean(providerKey(provider, env));
}

/**
 * Where the effective key comes from.
 */
export function keySource(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): "settings" | "env" | "none" {
  if (overrides.get(provider)) return 'settings';
  if (envKey(provider, env)) return 'env';
  return 'none';
}
