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
import { MACRO_PROVIDERS } from './adapters/macroCatalog.js';

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
 * @param {typeof defaultGovernor} [deps.governor]
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
  // Coalesce concurrent identical fetches: without this, N requests for the same
  // cold key all miss the cache and all fan out to providers (and all spend
  // quota). Keyed by the same cache key; cleared in `finally`.
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map();

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

    const cached = /** @type {{ provider?: string, data?: unknown } | undefined} */ (cache.get(key));
    if (cached !== undefined) return { ...cached, source: 'cache' };

    const existing = inFlight.get(key);
    if (existing) return existing;

    const work = /** @type {Promise<{ provider?: string, data?: unknown, source: 'live'|'cache'|'unavailable', attempted?: any[] }>} */ ((async () => {
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
    })().finally(() => inFlight.delete(key)));

    inFlight.set(key, work);
    return work;
  }

  /**
   * Field-level merge of fundamentals snapshots in precedence order (earliest =
   * highest precedence). A higher-precedence provider's value wins per field, but
   * only when present — a null/NaN never clobbers a real value from a
   * lower-precedence provider. This is the "FMP where possible, Yahoo otherwise"
   * union: FMP-only fields (interestCoverage), Yahoo-only fields (forwardPE,
   * revenue, freeCashFlow), and shared fields (FMP wins) all survive.
   * @param {Array<Record<string, any>>} snapshots  highest-precedence first
   */
  function mergeFundamentals(snapshots) {
    const merged = {};
    // Overlay lowest → highest so the highest-precedence present value lands last.
    for (const snap of [...snapshots].reverse()) {
      if (!snap || typeof snap !== 'object') continue;
      for (const [field, value] of Object.entries(snap)) {
        const missing = value == null || (typeof value === 'number' && !Number.isFinite(value));
        if (!missing) merged[field] = value;
      }
    }
    return merged;
  }

  /**
   * Fundamentals are MERGED rather than raced: FMP and Yahoo are fetched in
   * parallel (each gated by key + quota) and combined field-by-field, FMP
   * preferred. This is the one data type the user wants composed from two
   * providers; every other type stays single-provider race-to-first via `fetch`.
   *
   * @param {{ symbol?: string, assetClass?: string }} [params]
   * @returns {Promise<{ provider?: string, data?: unknown, source: 'cache'|'live'|'unavailable', attempted?: object[] }>}
   */
  async function fetchFundamentals({ symbol, assetClass } = {}) {
    const key = `fundamentals:merged:${assetClass ?? ''}:${symbol ?? ''}`;
    const cached = /** @type {{ provider?: string, data?: unknown } | undefined} */ (cache.get(key));
    if (cached !== undefined) return { ...cached, source: 'cache' };

    // Precedence order: FMP first (richest US fundamentals), Yahoo as the keyless
    // fallback. Drop any provider without an adapter method or key.
    const order = ['fmp', 'yahoo'].filter((p) => supports(p, 'fundamentals') && isKeyed(p));

    const attempted = [];
    const settled = await Promise.all(
      order.map(async (provider) => {
        if (!(await governor.canSpend(provider))) {
          attempted.push({ provider, skipped: 'quota' });
          return undefined;
        }
        try {
          const data = await adapters[provider].fundamentals(symbol, {});
          await governor.spend(provider);
          Promise.resolve(recordSuccess(provider)).catch(() => {});
          return { provider, data };
        } catch (err) {
          Promise.resolve(recordError(provider, err)).catch(() => {});
          attempted.push({ provider, error: err instanceof Error ? err.message : String(err) });
          return undefined;
        }
      }),
    );

    // `settled` preserves `order`, so filtering keeps FMP ahead of Yahoo.
    const contributions = settled.filter(Boolean);
    if (contributions.length === 0) return { source: 'unavailable', attempted };

    const result = {
      provider: contributions.map((c) => c.provider).join('+'),
      data: mergeFundamentals(contributions.map((c) => c.data)),
    };
    cache.set(key, result, ttlForType('fundamentals'));
    return { ...result, source: 'live' };
  }

  /**
   * Macro series search (ADR-082). Fans out to every usable macro adapter (has a
   * `macroSearch` method + key) in PARALLEL and UNIONs their results — not a race
   * and not a field-merge. Each item carries its own provider; a provider that
   * errors or is unkeyed (e.g. no FRED key) is simply absent from the union.
   * @param {string} query
   * @returns {Promise<{ items: object[], source: 'cache'|'live', attempted?: object[] }>}
   */
  async function searchMacro(query) {
    const q = String(query ?? '').trim();
    if (!q) return { items: [], source: 'live' };

    const key = `macro_search::${q.toLowerCase()}`;
    const cached = /** @type {{ items: object[] } | undefined} */ (cache.get(key));
    if (cached !== undefined) return { ...cached, source: 'cache' };

    const providers = MACRO_PROVIDERS.filter(
      (p) => adapterSupports(p, 'macroSearch', adapters) && isKeyed(p),
    );
    const attempted = [];
    const settled = await Promise.all(
      providers.map(async (provider) => {
        if (!(await governor.canSpend(provider))) {
          attempted.push({ provider, skipped: 'quota' });
          return [];
        }
        try {
          const res = await adapters[provider].macroSearch(q);
          await governor.spend(provider);
          Promise.resolve(recordSuccess(provider)).catch(() => {});
          return Array.isArray(res?.items) ? res.items : [];
        } catch (err) {
          Promise.resolve(recordError(provider, err)).catch(() => {});
          attempted.push({ provider, error: err instanceof Error ? err.message : String(err) });
          return [];
        }
      }),
    );

    const result = { items: settled.flat() };
    cache.set(key, result, ttlForType('macro_search'));
    return { ...result, source: 'live', attempted };
  }

  /**
   * Provider-pinned macro series fetch (ADR-082). A macro series lives at exactly
   * one provider, so this routes to the named adapter with NO fallback chain.
   * @param {{ provider?: string, seriesId?: string, range?: string }} [params]
   * @returns {Promise<{ provider?: string, data?: unknown, source: 'cache'|'live'|'unavailable', attempted?: object[] }>}
   */
  async function fetchMacroSeries({ provider, seriesId, range } = {}) {
    if (!provider || !seriesId) throw new Error('provider and seriesId required');

    const key = `macro_series::${provider}::${seriesId}::${range ?? ''}`;
    const cached = /** @type {{ provider?: string, data?: unknown } | undefined} */ (cache.get(key));
    if (cached !== undefined) return { ...cached, source: 'cache' };

    if (!adapterSupports(provider, 'macroSeries', adapters)) {
      return { source: 'unavailable', attempted: [{ provider, skipped: 'unsupported' }] };
    }
    if (!isKeyed(provider)) {
      return { source: 'unavailable', attempted: [{ provider, skipped: 'no_key' }] };
    }
    if (!(await governor.canSpend(provider))) {
      return { source: 'unavailable', attempted: [{ provider, skipped: 'quota' }] };
    }
    try {
      const data = await adapters[provider].macroSeries(seriesId, { range });
      await governor.spend(provider);
      Promise.resolve(recordSuccess(provider)).catch(() => {});
      const result = { provider, data };
      cache.set(key, result, ttlForType('macro_series'));
      return { ...result, source: 'live' };
    } catch (err) {
      Promise.resolve(recordError(provider, err)).catch(() => {});
      return {
        source: 'unavailable',
        attempted: [{ provider, error: err instanceof Error ? err.message : String(err) }],
      };
    }
  }

  return { fetch, fetchFundamentals, searchMacro, fetchMacroSeries, usableChain };
}

/** Process-wide singleton used by the research routes. */
export const researchAggregator = createResearchAggregator();
