/**
 * Research symbol-mapping service (ADR-079).
 *
 * The cross-provider symbol map is the fool-proof anchor against silent
 * wrong-instrument merges. This service:
 *
 *   - resolve(): auto-proposes a per-provider symbol by running each search-capable
 *     provider's search, returning the resolved name/exchange so the UI can show
 *     what each symbol actually backs (the user confirms, catching ticker
 *     collisions like APLE vs AAPL). Existing confirmed mappings are kept as-is.
 *   - save(): persists user-confirmed mappings.
 *   - list() / remove(): read + delete stored mappings.
 *   - audit(): cross-provider self-check — fetches a quote per mapped provider and
 *     flags currency mismatches or price disagreement beyond tolerance, stamping
 *     verified_at.
 *
 * All dependencies are injectable for testing. The shared adapter registry and
 * governor (providerRegistry) are used so quota is tracked once across data
 * fetches and mapping calls.
 */

import { resolveProviderChain } from './capabilityMap.js';
import { isProviderKeyed } from './providerKeys.js';
import { ADAPTERS, defaultGovernor, adapterSupports } from './providerRegistry.js';
import * as providerHealth from '../providerHealthService.js';
import * as mapRepo from '../../repositories/instrumentProviderMapRepository.js';
import investmentRepo from '../../repositories/investmentRepository.js';

/** Relative price agreement tolerance for the self-audit (5%). */
export const AUDIT_PRICE_TOLERANCE = 0.05;

const errMessage = (err) => (err instanceof Error ? err.message : String(err));

export function createResearchMappingService({
  repo = mapRepo,
  investments = investmentRepo,
  adapters = ADAPTERS,
  governor = defaultGovernor,
  isKeyed = isProviderKeyed,
  recordSuccess = providerHealth.recordSuccess,
  recordError = providerHealth.recordError,
} = {}) {
  const noteSuccess = (p) => Promise.resolve(recordSuccess(p)).catch(() => {});
  const noteError = (p, e) => Promise.resolve(recordError(p, e)).catch(() => {});

  function list(instrumentKey, keyType) {
    return repo.listByInstrument(instrumentKey, keyType);
  }

  /**
   * Auto-propose per-provider symbols for an instrument. Does NOT persist.
   *
   * When `investmentId` is supplied and that holding already has a configured
   * `price_provider` + `price_provider_id`, that provider is pre-seeded as a
   * confirmed proposal (`fromHolding: true`) and its live search is skipped — the
   * user already mapped it on the investment, so there's nothing to re-map. An
   * existing stored `confirmed` mapping still wins; providers never appear twice.
   *
   * @param {{ instrumentKey: string, keyType: string, assetClass?: string, query: string, investmentId?: number }} params
   */
  async function resolve({ instrumentKey, keyType, assetClass, query, investmentId }) {
    const existing = await repo.listByInstrument(instrumentKey, keyType);
    const existingByProvider = new Map(existing.map((r) => [r.provider, r]));

    // Pre-seed from a held investment's already-configured provider, if asked.
    // Not user-scoped: Vision is single-tenant/self-hosted — `investments` has no
    // owner column and there is no per-user request identity (see ADR-034); this
    // `getById` mirrors the existing GET /api/investments/:id read. A missing id
    // returns null and is silently skipped (no existence oracle beyond that route).
    // If Vision ever becomes multi-tenant, scope this AND every other :id read.
    const holdingByProvider = new Map();
    if (investmentId !== undefined) {
      const holding = await investments.getById(investmentId);
      if (holding && holding.price_provider && holding.price_provider_id) {
        holdingByProvider.set(holding.price_provider, {
          provider: holding.price_provider,
          status: 'confirmed',
          providerSymbol: holding.price_provider_id,
          resolvedName: holding.name,
          currency: holding.currency,
          fromHolding: true,
        });
      }
    }

    // Search-capable providers first, then any already-mapped or held provider not in that chain.
    const searchChain = resolveProviderChain('search', assetClass);
    const providerOrder = [...searchChain];
    for (const r of existing) if (!providerOrder.includes(r.provider)) providerOrder.push(r.provider);
    for (const p of holdingByProvider.keys()) if (!providerOrder.includes(p)) providerOrder.push(p);

    const proposals = [];
    for (const provider of providerOrder) {
      const ex = existingByProvider.get(provider);

      if (ex && ex.status === 'confirmed') {
        proposals.push(fromStore(provider, ex, 'confirmed'));
        continue;
      }
      // A held provider is known-good: pre-seed it confirmed and skip the live search.
      if (holdingByProvider.has(provider)) {
        proposals.push(holdingByProvider.get(provider));
        continue;
      }
      if (!adapterSupports(provider, 'search', adapters) || !isKeyed(provider)) {
        proposals.push(ex ? fromStore(provider, ex, ex.status) : { provider, status: 'unavailable' });
        continue;
      }
      if (!(await governor.canSpend(provider))) {
        proposals.push({ provider, status: 'skipped', reason: 'quota' });
        continue;
      }
      try {
        const { items = [] } = await adapters[provider].search(query);
        await governor.spend(provider);
        noteSuccess(provider);
        const top = items[0];
        proposals.push(
          top
            ? {
                provider,
                status: 'auto',
                providerSymbol: top.symbol,
                resolvedName: top.name,
                exchange: top.exchange,
                candidates: items.slice(0, 5),
              }
            : { provider, status: 'none' },
        );
      } catch (err) {
        noteError(provider, err);
        proposals.push({ provider, status: 'error', error: errMessage(err) });
      }
    }

    return { instrumentKey, keyType, proposals, existing };
  }

  /**
   * Persist user-confirmed mappings.
   * @param {{ instrumentKey: string, keyType: string, mappings: object[] }} params
   */
  async function save({ instrumentKey, keyType, mappings }) {
    for (const m of mappings) {
      await repo.upsert({
        instrumentKey,
        keyType,
        provider: m.provider,
        providerSymbol: m.providerSymbol ?? m.provider_symbol,
        resolvedName: m.resolvedName ?? m.resolved_name,
        exchange: m.exchange,
        currency: m.currency,
        status: m.status ?? 'confirmed',
      });
    }
    return repo.listByInstrument(instrumentKey, keyType);
  }

  function remove(id) {
    return repo.deleteById(id);
  }

  /**
   * Cross-provider self-audit: compare currency + price across mapped providers.
   * @param {{ instrumentKey: string, keyType: string }} params
   */
  async function audit({ instrumentKey, keyType }) {
    const rows = await repo.listByInstrument(instrumentKey, keyType);
    const mapped = rows.filter((r) => r.provider_symbol);

    const quotes = [];
    for (const r of mapped) {
      if (!adapterSupports(r.provider, 'quote', adapters) || !isKeyed(r.provider)) continue;
      if (!(await governor.canSpend(r.provider))) {
        quotes.push({ provider: r.provider, skipped: 'quota' });
        continue;
      }
      try {
        const q = await adapters[r.provider].quote(r.provider_symbol);
        await governor.spend(r.provider);
        noteSuccess(r.provider);
        quotes.push({ provider: r.provider, currency: q.currency, price: q.price });
      } catch (err) {
        noteError(r.provider, err);
        quotes.push({ provider: r.provider, error: errMessage(err) });
      }
    }

    const discrepancies = analyzeQuotes(quotes);
    await repo.markVerified(instrumentKey, keyType);
    return { ok: discrepancies.length === 0, quotes, discrepancies };
  }

  return { list, resolve, save, remove, audit };
}

function fromStore(provider, row, status) {
  return {
    provider,
    status,
    providerSymbol: row.provider_symbol,
    resolvedName: row.resolved_name,
    exchange: row.exchange,
    currency: row.currency,
    fromStore: true,
  };
}

/**
 * Flag currency mismatches and price outliers across provider quotes.
 * @param {object[]} quotes
 * @returns {object[]} discrepancies
 */
export function analyzeQuotes(quotes) {
  const discrepancies = [];
  const priced = quotes.filter((q) => Number.isFinite(q.price));

  const currencies = [...new Set(priced.map((q) => q.currency).filter(Boolean))];
  if (currencies.length > 1) {
    discrepancies.push({ type: 'currency_mismatch', currencies });
  }

  if (priced.length >= 2) {
    const prices = priced.map((q) => q.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    if (median > 0) {
      for (const q of priced) {
        if (Math.abs(q.price - median) / median > AUDIT_PRICE_TOLERANCE) {
          discrepancies.push({ type: 'price_outlier', provider: q.provider, price: q.price, median });
        }
      }
    }
  }

  return discrepancies;
}

/** Process-wide singleton used by the research routes. */
export const researchMappingService = createResearchMappingService();
