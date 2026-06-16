/**
 * Research aggregator (ADR-079).
 *
 * Orchestrates a single research data fetch across providers:
 *   1. Cache first — a hit avoids the call and the quota spend entirely.
 *   2. Walk the capability chain for (dataType, assetClass), keeping only
 *      providers that have an adapter method, are keyed, and (per provider, at
 *      attempt time) have quota left.
 *   3. Race-to-first: the first provider that returns wins; we record the spend,
 *      mark provider health success, cache the result, and return it.
 *   4. On a provider error, record health error and fall through to the next.
 *
 * Lazy per-tab merge (ADR-079) is realised at the route layer: each research tab
 * maps to one dataType call, so a composite is only assembled for data the user
 * actually views. All dependencies are injectable for testing.
 */

import { resolveProviderChain } from './capabilityMap.js';
import { isProviderKeyed } from './providerKeys.js';
import { researchCache, ttlForType } from './researchCache.js';
import * as providerHealth from '../providerHealthService.js';
import { ADAPTERS, defaultGovernor, adapterSupports } from './providerRegistry.js';

/** Research data type → adapter method name. */
const METHOD_BY_TYPE = Object.freeze({
  search: 'search',
  quote: 'quote',
  chart: 'chart',
  fundamentals: 'fundamentals',
  analyst: 'analyst',
  news: 'news',
});

/**
 * @param {Object} [deps]
 * @param {Record<string, any>} [deps.adapters]  provider key → adapter object
 * @param {ReturnType<typeof createQuotaGovernor>} [deps.governor]
 * @param {typeof researchCache} [deps.cache]
 * @param {(provider: string) => boolean} [deps.isKeyed]
 * @param {(provider: string) => unknown} [deps.recordSuccess]
 * @param {(provider: string, error: unknown) => unknown} [deps.recordError]
 */
export function createResearchAggregator({
  adapters = ADAPTERS,
  governor = defaultGovernor,
  cache = researchCache,
  isKeyed = isProviderKeyed,
  recordSuccess = providerHealth.recordSuccess,
  recordError = providerHealth.recordError,
} = {}) {
  function supports(provider, dataType) {
    return adapterSupports(provider, METHOD_BY_TYPE[dataType], adapters);
  }

  /** Usable, ordered provider chain (adapter present + method + keyed). Quota is checked per attempt. */
  function usableChain(dataType, assetClass) {
    return resolveProviderChain(dataType, assetClass, {
      isUsable: (provider) => supports(provider, dataType) && isKeyed(provider),
    });
  }

  /**
   * @param {string} dataType
   * @param {{ symbol?: string, assetClass?: string, range?: string, count?: number, cacheKey?: string }} [params]
   * @returns {Promise<{ provider?: string, data?: unknown, source: 'cache'|'live'|'unavailable', attempted?: object[] }>}
   */
  async function fetch(dataType, params = {}) {
    const method = METHOD_BY_TYPE[dataType];
    if (!method) throw new Error(`Unknown research data type: ${dataType}`);

    const { symbol, assetClass, range, count, cacheKey } = params;
    const key = cacheKey ?? `${dataType}:${assetClass ?? ''}:${symbol ?? ''}:${range ?? ''}`;

    const cached = cache.get(key);
    if (cached !== undefined) return { ...cached, source: 'cache' };

    const attempted = [];
    for (const provider of usableChain(dataType, assetClass)) {
      if (!(await governor.canSpend(provider))) {
        attempted.push({ provider, skipped: 'quota' });
        continue;
      }
      try {
        const data = await adapters[provider][method](symbol, { range, count });
        await governor.spend(provider);
        Promise.resolve(recordSuccess(provider)).catch(() => {});
        const result = { provider, data };
        cache.set(key, result, ttlForType(dataType));
        return { ...result, source: 'live' };
      } catch (err) {
        Promise.resolve(recordError(provider, err)).catch(() => {});
        attempted.push({ provider, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { source: 'unavailable', attempted };
  }

  return { fetch, usableChain };
}

/** Process-wide singleton used by the research routes. */
export const researchAggregator = createResearchAggregator();
