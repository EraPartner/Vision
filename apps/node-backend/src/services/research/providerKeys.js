/**
 * Provider API-key gating (ADR-079).
 *
 * Providers that require an API key are only usable when that key is present in
 * the environment (`.env.local`). A provider with no configured key is dropped
 * from the capability chain by the aggregator, so the system degrades to
 * whichever providers are keyed. Yahoo / Binance / Kinesis need no key.
 */

/** Provider key → required environment variable. */
export const ENV_VAR_BY_PROVIDER = Object.freeze({
  twelve_data: 'TWELVE_DATA_API_KEY',
  finnhub: 'FINNHUB_API_KEY',
  fmp: 'FMP_API_KEY',
  alpha_vantage: 'ALPHA_VANTAGE_API_KEY',
});

/**
 * True if the provider needs no key, or its key is present and non-empty.
 * @param {string} provider
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isProviderKeyed(provider, env = process.env) {
  const varName = ENV_VAR_BY_PROVIDER[provider];
  if (!varName) return true; // no key required
  return Boolean(env[varName] && String(env[varName]).trim());
}

/**
 * The API key for a provider, or undefined.
 * @param {string} provider
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function providerKey(provider, env = process.env) {
  const varName = ENV_VAR_BY_PROVIDER[provider];
  if (!varName) return undefined;
  const value = env[varName];
  return value && String(value).trim() ? String(value).trim() : undefined;
}
