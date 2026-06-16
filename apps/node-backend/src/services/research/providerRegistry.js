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

import yahooAdapter from './adapters/yahooAdapter.js';
import { createQuotaGovernor } from './quotaGovernor.js';
import { createDbQuotaStore } from '../../repositories/providerQuotaRepository.js';

/** provider key → adapter object. */
export const ADAPTERS = Object.freeze({
  yahoo: yahooAdapter,
});

/** Process-wide governor shared by all research consumers. */
export const defaultGovernor = createQuotaGovernor({ store: createDbQuotaStore() });

/**
 * True if `provider` has an adapter implementing `dataType`.
 * @param {string} provider
 * @param {string} method  adapter method name (search/quote/chart/...)
 * @param {Record<string, any>} [adapters]
 * @returns {boolean}
 */
export function adapterSupports(provider, method, adapters = ADAPTERS) {
  const adapter = adapters[provider];
  return Boolean(adapter && typeof adapter[method] === 'function');
}
