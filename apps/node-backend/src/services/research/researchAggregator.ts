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

import { resolveProviderChain } from "./capabilityMap.ts";
import { isProviderKeyed } from "./providerKeys.ts";
import { researchCache, ttlForType } from "./researchCache.ts";
import type { ResearchCache } from "./researchCache.ts";
import * as providerHealth from "../providerHealthService.js";
import {
  ADAPTERS,
  defaultGovernor,
  adapterSupports,
  recordProviderError,
} from "./providerRegistry.ts";
import type { AdapterMap } from "./providerRegistry.ts";
import type { QuotaReserver } from "./quotaGovernor.ts";
import { MACRO_PROVIDERS } from "./adapters/macroCatalog.ts";

/** One provider the aggregator tried (or skipped) for a request. */
export interface ResearchAttempt {
  provider: string;
  skipped?: string;
  error?: string;
}

export type ResearchSource = "cache" | "live" | "unavailable";

/** Envelope every aggregator fetch resolves to. */
export interface ResearchFetchResult {
  provider?: string;
  data?: unknown;
  source: ResearchSource;
  attempted?: ResearchAttempt[];
}

/** What the aggregator stores per cache key (the envelope minus `source`). */
type CachedFetch = { provider?: string; data?: unknown };

/** Research data type → adapter method name. */
const METHOD_BY_TYPE = Object.freeze({
  search: "search",
  quote: "quote",
  chart: "chart",
  fundamentals: "fundamentals",
  analyst: "analyst",
  news: "news",
});

/**
 * @param deps.adapters  provider key → adapter object
 */
function createResearchAggregator({
  adapters = ADAPTERS,
  governor = defaultGovernor,
  cache = researchCache,
  isKeyed = isProviderKeyed,
  recordSuccess = providerHealth.recordSuccess,
  recordError = recordProviderError,
}: {
  adapters?: AdapterMap;
  governor?: QuotaReserver;
  cache?: Pick<ResearchCache, "get" | "set">;
  isKeyed?: (provider: string) => boolean;
  recordSuccess?: (provider: string) => unknown;
  recordError?: (provider: string, error: unknown) => unknown;
} = {}) {
  // Coalesce concurrent identical fetches: without this, N requests for the same
  // cold key all miss the cache and all fan out to providers (and all spend
  // quota). Keyed by the same cache key; cleared in `finally`.
  const inFlight = new Map<string, Promise<ResearchFetchResult>>();

  async function reserveProvider(provider: string) {
    if (typeof governor.reserve === "function")
      return governor.reserve(provider);
    if (!(await governor.canSpend(provider))) return false;
    await governor.spend(provider);
    return true;
  }

  function supports(provider: string, dataType: string) {
    return adapterSupports(
      provider,
      METHOD_BY_TYPE[dataType as keyof typeof METHOD_BY_TYPE],
      adapters,
    );
  }

  /** Usable, ordered provider chain (adapter present + method + keyed). Quota is checked per attempt. */
  function usableChain(dataType: string, assetClass?: string) {
    return resolveProviderChain(dataType, assetClass, {
      isUsable: (provider) => supports(provider, dataType) && isKeyed(provider),
    });
  }

  async function fetch(
    dataType: string,
    params: {
      symbol?: string;
      assetClass?: string;
      range?: string;
      count?: number;
      cacheKey?: string;
    } = {},
  ): Promise<ResearchFetchResult> {
    const method = METHOD_BY_TYPE[dataType as keyof typeof METHOD_BY_TYPE];
    if (!method) throw new Error(`Unknown research data type: ${dataType}`);

    const { symbol, assetClass, range, count, cacheKey } = params;
    const key =
      cacheKey ??
      `${dataType}:${assetClass ?? ""}:${symbol ?? ""}:${range ?? ""}`;

    const cached = cache.get(key) as CachedFetch | undefined;
    if (cached !== undefined) return { ...cached, source: "cache" };

    const existing = inFlight.get(key);
    if (existing) return existing;

    const work = (async (): Promise<ResearchFetchResult> => {
      const attempted: ResearchAttempt[] = [];
      for (const provider of usableChain(dataType, assetClass)) {
        if (!(await reserveProvider(provider))) {
          attempted.push({ provider, skipped: "quota" });
          continue;
        }
        try {
          // usableChain() only yields providers whose adapter has `method`.
          const data = await adapters[provider][method]!(symbol, {
            range,
            count,
          });
          Promise.resolve(recordSuccess(provider)).catch(() => {});
          const result = { provider, data, attempted: [...attempted] };
          cache.set(key, result, ttlForType(dataType));
          return { ...result, source: "live" };
        } catch (err) {
          Promise.resolve(recordError(provider, err)).catch(() => {});
          attempted.push({
            provider,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { source: "unavailable", attempted };
    })().finally(() => inFlight.delete(key));

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
   * @param snapshots  highest-precedence first
   */
  function mergeFundamentals(snapshots: unknown[]) {
    const merged: Record<string, unknown> = {};
    // Overlay lowest → highest so the highest-precedence present value lands last.
    for (const snap of [...snapshots].reverse()) {
      if (!snap || typeof snap !== "object") continue;
      for (const [field, value] of Object.entries(snap)) {
        const missing =
          value == null ||
          (typeof value === "number" && !Number.isFinite(value));
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
   */
  async function fetchFundamentals({
    symbol,
    assetClass,
  }: {
    symbol?: string;
    assetClass?: string;
  } = {}): Promise<ResearchFetchResult> {
    const key = `fundamentals:merged:${assetClass ?? ""}:${symbol ?? ""}`;
    const cached = cache.get(key) as CachedFetch | undefined;
    if (cached !== undefined) return { ...cached, source: "cache" };

    // Precedence order: FMP first (richest US fundamentals), Yahoo as the keyless
    // fallback. Drop any provider without an adapter method or key.
    const order = ["fmp", "yahoo"].filter(
      (p) => supports(p, "fundamentals") && isKeyed(p),
    );

    const attempted: ResearchAttempt[] = [];
    const settled = await Promise.all(
      order.map(async (provider) => {
        if (!(await reserveProvider(provider))) {
          attempted.push({ provider, skipped: "quota" });
          return undefined;
        }
        try {
          // `order` keeps only providers whose adapter has fundamentals().
          const data = await adapters[provider].fundamentals!(symbol, {});
          Promise.resolve(recordSuccess(provider)).catch(() => {});
          return { provider, data };
        } catch (err) {
          Promise.resolve(recordError(provider, err)).catch(() => {});
          attempted.push({
            provider,
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        }
      }),
    );

    // `settled` preserves `order`, so filtering keeps FMP ahead of Yahoo.
    const contributions = settled.filter(
      (c): c is { provider: string; data: unknown } => Boolean(c),
    );
    if (contributions.length === 0) return { source: "unavailable", attempted };

    const result = {
      provider: contributions.map((c) => c.provider).join("+"),
      data: mergeFundamentals(contributions.map((c) => c.data)),
    };
    cache.set(key, result, ttlForType("fundamentals"));
    return { ...result, source: "live" };
  }

  /**
   * Macro series search (ADR-082). Fans out to every usable macro adapter (has a
   * `macroSearch` method + key) in PARALLEL and UNIONs their results — not a race
   * and not a field-merge. Each item carries its own provider; a provider that
   * errors or is unkeyed (e.g. no FRED key) is simply absent from the union.
   */
  async function searchMacro(query: string): Promise<{
    items: unknown[];
    source: "cache" | "live";
    attempted?: ResearchAttempt[];
  }> {
    const q = String(query ?? "").trim();
    if (!q) return { items: [], source: "live" };

    const key = `macro_search::${q.toLowerCase()}`;
    const cached = cache.get(key) as { items: unknown[] } | undefined;
    if (cached !== undefined) return { ...cached, source: "cache" };

    const providers = MACRO_PROVIDERS.filter(
      (p) => adapterSupports(p, "macroSearch", adapters) && isKeyed(p),
    );
    const attempted: ResearchAttempt[] = [];
    const settled = await Promise.all(
      providers.map(async (provider): Promise<unknown[]> => {
        if (!(await reserveProvider(provider))) {
          attempted.push({ provider, skipped: "quota" });
          return [];
        }
        try {
          // `providers` keeps only adapters that implement macroSearch().
          const res = await adapters[provider].macroSearch!(q);
          Promise.resolve(recordSuccess(provider)).catch(() => {});
          return Array.isArray(res?.items) ? res.items : [];
        } catch (err) {
          Promise.resolve(recordError(provider, err)).catch(() => {});
          attempted.push({
            provider,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      }),
    );

    const result = { items: settled.flat() };
    cache.set(key, result, ttlForType("macro_search"));
    return { ...result, source: "live", attempted };
  }

  /**
   * Provider-pinned macro series fetch (ADR-082). A macro series lives at exactly
   * one provider, so this routes to the named adapter with NO fallback chain.
   */
  async function fetchMacroSeries({
    provider,
    seriesId,
    range,
  }: {
    provider?: string;
    seriesId?: string;
    range?: string;
  } = {}): Promise<ResearchFetchResult> {
    if (!provider || !seriesId)
      throw new Error("provider and seriesId required");

    const key = `macro_series::${provider}::${seriesId}::${range ?? ""}`;
    const cached = cache.get(key) as CachedFetch | undefined;
    if (cached !== undefined) return { ...cached, source: "cache" };

    if (!adapterSupports(provider, "macroSeries", adapters)) {
      return {
        source: "unavailable",
        attempted: [{ provider, skipped: "unsupported" }],
      };
    }
    if (!isKeyed(provider)) {
      return {
        source: "unavailable",
        attempted: [{ provider, skipped: "no_key" }],
      };
    }
    if (!(await reserveProvider(provider))) {
      return {
        source: "unavailable",
        attempted: [{ provider, skipped: "quota" }],
      };
    }
    try {
      // adapterSupports() above guarantees the macroSeries method exists.
      const data = await adapters[provider].macroSeries!(seriesId, { range });
      Promise.resolve(recordSuccess(provider)).catch(() => {});
      const result = { provider, data };
      cache.set(key, result, ttlForType("macro_series"));
      return { ...result, source: "live" };
    } catch (err) {
      Promise.resolve(recordError(provider, err)).catch(() => {});
      return {
        source: "unavailable",
        attempted: [
          { provider, error: err instanceof Error ? err.message : String(err) },
        ],
      };
    }
  }

  return {
    fetch,
    fetchFundamentals,
    searchMacro,
    fetchMacroSeries,
    usableChain,
  };
}

/** Process-wide singleton used by the research routes. */
export const researchAggregator = createResearchAggregator();

export { createResearchAggregator as __createResearchAggregator };
