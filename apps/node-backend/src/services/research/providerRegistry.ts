/**
 * Shared research provider wiring (ADR-079).
 *
 * Single source of the adapter registry and the quota governor so every research
 * consumer (the aggregator's data fetches and the mapping service's resolve/audit
 * calls) shares ONE set of token buckets — otherwise per-minute/day quota would be
 * tracked twice and the limits could be exceeded.
 *
 * Adapters light up here as their API keys are provisioned; today only Yahoo
 * (which needs no key) is wired.
 */

import yahooAdapter from './adapters/yahooAdapter.ts';
import twelveDataAdapter from './adapters/twelveDataAdapter.ts';
import finnhubAdapter from './adapters/finnhubAdapter.ts';
import fmpAdapter from './adapters/fmpAdapter.ts';
import alphaVantageAdapter from './adapters/alphaVantageAdapter.ts';
import fredAdapter from './adapters/fredAdapter.ts';
import eurostatAdapter from './adapters/eurostatAdapter.ts';
import dbnomicsAdapter from './adapters/dbnomicsAdapter.ts';
import { createQuotaGovernor } from './quotaGovernor.ts';
import * as providerHealth from '../providerHealthService.js';
import { createDbQuotaStore } from '../../repositories/providerQuotaRepository.ts';

/** A search hit as the adapters normalise it (leaves may be absent). */
export interface ResearchSearchItem {
  symbol?: string | null;
  name?: string | null;
  type?: string | null;
  exchange?: string | null;
}

/** Options the aggregator forwards to symbol-centric adapter methods. */
export interface AdapterOptions {
  range?: string;
  count?: number;
}

/**
 * Structural adapter contract the aggregator and mapping service dispatch on.
 * Every method is optional (adapters implement a subset). Declared as method
 * signatures so concrete adapters typed `(symbol: string)` stay assignable even
 * though the aggregator forwards an optional `symbol`.
 */
export interface ResearchAdapter {
  key?: string;
  search?(
    query: string | undefined,
    opts?: AdapterOptions,
  ): Promise<{ items?: ResearchSearchItem[] }>;
  quote?(
    symbol: string | undefined,
    opts?: AdapterOptions,
  ): Promise<{ currency?: string | null; price?: number | null }>;
  chart?(symbol: string | undefined, opts?: AdapterOptions): Promise<unknown>;
  fundamentals?(
    symbol: string | undefined,
    opts?: AdapterOptions,
  ): Promise<unknown>;
  analyst?(symbol: string | undefined, opts?: AdapterOptions): Promise<unknown>;
  news?(symbol: string | undefined, opts?: AdapterOptions): Promise<unknown>;
  macroSearch?(query: string): Promise<{ items?: unknown }>;
  macroSeries?(
    seriesId: string,
    opts?: { range?: string },
  ): Promise<unknown>;
}

export type AdapterMethod = Exclude<keyof ResearchAdapter, 'key'>;

export type AdapterMap = Readonly<Record<string, ResearchAdapter>>;

/**
 * provider key → adapter object. Yahoo/Eurostat/DBnomics need no key; the others
 * self-throw if their key is absent and are dropped from the capability chain by
 * the aggregator's `isProviderKeyed` gate, so listing them here is always safe.
 * FRED/Eurostat/DBnomics implement the macro method set (macroSearch/macroSeries,
 * ADR-082) rather than the symbol-centric methods.
 */
export const ADAPTERS: AdapterMap = Object.freeze({
  yahoo: yahooAdapter,
  twelve_data: twelveDataAdapter,
  finnhub: finnhubAdapter,
  fmp: fmpAdapter,
  alpha_vantage: alphaVantageAdapter,
  fred: fredAdapter,
  eurostat: eurostatAdapter,
  dbnomics: dbnomicsAdapter,
});

/** Process-wide governor shared by all research consumers. */
export const defaultGovernor = createQuotaGovernor({ store: createDbQuotaStore() });

/**
 * True if `provider` has an adapter implementing `dataType`.
 * @param method  adapter method name (search/quote/chart/...)
 */
export function adapterSupports(
  provider: string,
  method: AdapterMethod,
  adapters: AdapterMap = ADAPTERS,
): boolean {
  const adapter = adapters[provider];
  return Boolean(adapter && typeof adapter[method] === 'function');
}

/**
 * Default provider-health error sink for research consumers. providerHealth's
 * recordError already stringifies any non-Error, so this only adapts its
 * declared `Error | string` parameter to the `unknown` a catch clause yields.
 */
export function recordProviderError(provider: string, error: unknown) {
  return providerHealth.recordError(
    provider,
    error instanceof Error ? error : String(error),
  );
}
