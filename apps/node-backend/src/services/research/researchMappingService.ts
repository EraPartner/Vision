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

import { resolveProviderChain } from "./capabilityMap.ts";
import { isProviderKeyed } from "./providerKeys.ts";
import {
  ADAPTERS,
  defaultGovernor,
  adapterSupports,
  recordProviderError,
} from "./providerRegistry.ts";
import type { AdapterMap, ResearchSearchItem } from "./providerRegistry.ts";
import type { QuotaReserver } from "./quotaGovernor.ts";
import * as providerHealth from "../providerHealthService.ts";
import * as mapRepo from "../../repositories/instrumentProviderMapRepository.ts";
import investmentRepo from "../../repositories/investmentRepository.ts";
import type { InstrumentProviderMapRow } from "../../types/rows.ts";

/** Relative price agreement tolerance for the self-audit (5%). */
const AUDIT_PRICE_TOLERANCE = 0.05;

const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** One per-provider row of a resolve() result. */
export interface MappingProposal {
  provider: string;
  status: string;
  providerSymbol?: string | null;
  resolvedName?: string | null;
  exchange?: string | null;
  currency?: string | null;
  candidates?: ResearchSearchItem[];
  reason?: string;
  error?: string;
  fromHolding?: boolean;
  fromStore?: boolean;
}

/** One provider's entry in an audit() result. */
export interface AuditQuote {
  provider: string;
  currency?: string | null;
  price?: number | null;
  error?: string;
  skipped?: string;
}

export type AuditDiscrepancy =
  | { type: "currency_mismatch"; currencies: Array<string | null | undefined> }
  | { type: "price_outlier"; provider: string; price: number; median: number };

/** A user-confirmed mapping as save() reads it (camelCase or snake_case). */
export interface MappingInput {
  provider: string;
  providerSymbol?: string;
  provider_symbol?: string;
  resolvedName?: string;
  resolved_name?: string;
  exchange?: string;
  currency?: string;
  status?: string;
}

/**
 * @param deps.adapters  provider key → adapter object
 */
function createResearchMappingService({
  repo = mapRepo,
  investments = investmentRepo,
  adapters = ADAPTERS,
  governor = defaultGovernor,
  isKeyed = isProviderKeyed,
  recordSuccess = providerHealth.recordSuccess,
  recordError = recordProviderError,
}: {
  repo?: typeof mapRepo;
  investments?: Pick<typeof investmentRepo, "getById">;
  adapters?: AdapterMap;
  governor?: QuotaReserver;
  isKeyed?: (provider: string) => boolean;
  recordSuccess?: (provider: string) => unknown;
  recordError?: (provider: string, error: unknown) => unknown;
} = {}) {
  const noteSuccess = (p: string) =>
    Promise.resolve(recordSuccess(p)).catch(() => {});
  const noteError = (p: string, e: unknown) =>
    Promise.resolve(recordError(p, e)).catch(() => {});
  async function reserveProvider(provider: string) {
    if (typeof governor.reserve === "function")
      return governor.reserve(provider);
    if (!(await governor.canSpend(provider))) return false;
    await governor.spend(provider);
    return true;
  }

  function list(instrumentKey: string, keyType: string) {
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
   */
  async function resolve({
    instrumentKey,
    keyType,
    assetClass,
    query,
    investmentId,
  }: {
    instrumentKey: string;
    keyType: string;
    assetClass?: string;
    query: string;
    investmentId?: number;
  }) {
    const existing = await repo.listByInstrument(instrumentKey, keyType);
    const existingByProvider = new Map(existing.map((r) => [r.provider, r]));

    // Pre-seed from a held investment's already-configured provider, if asked.
    // Not user-scoped: Vision is single-tenant/self-hosted — `investments` has no
    // owner column and there is no per-user request identity (see ADR-034); this
    // `getById` mirrors the existing GET /api/investments/:id read. A missing id
    // returns null and is silently skipped (no existence oracle beyond that route).
    // If Vision ever becomes multi-tenant, scope this AND every other :id read.
    const holdingByProvider = new Map<string, MappingProposal>();
    if (investmentId !== undefined) {
      const holding = await investments.getById(investmentId);
      if (holding && holding.price_provider && holding.price_provider_id) {
        holdingByProvider.set(holding.price_provider, {
          provider: holding.price_provider,
          status: "confirmed",
          providerSymbol: holding.price_provider_id,
          resolvedName: holding.name,
          currency: holding.currency,
          fromHolding: true,
        });
      }
    }

    // Search-capable providers first, then any already-mapped or held provider not in that chain.
    const searchChain = resolveProviderChain("search", assetClass);
    const providerOrder = [...searchChain];
    for (const r of existing)
      if (!providerOrder.includes(r.provider)) providerOrder.push(r.provider);
    for (const p of holdingByProvider.keys())
      if (!providerOrder.includes(p)) providerOrder.push(p);

    const proposals: MappingProposal[] = [];
    for (const provider of providerOrder) {
      const ex = existingByProvider.get(provider);

      if (ex && ex.status === "confirmed") {
        proposals.push(fromStore(provider, ex, "confirmed"));
        continue;
      }
      // A held provider is known-good: pre-seed it confirmed and skip the live search.
      const held = holdingByProvider.get(provider);
      if (held) {
        proposals.push(held);
        continue;
      }
      if (
        !adapterSupports(provider, "search", adapters) ||
        !isKeyed(provider)
      ) {
        proposals.push(
          ex
            ? fromStore(provider, ex, ex.status)
            : { provider, status: "unavailable" },
        );
        continue;
      }
      if (!(await reserveProvider(provider))) {
        proposals.push({ provider, status: "skipped", reason: "quota" });
        continue;
      }
      try {
        // adapterSupports() above guarantees the search method exists.
        const { items = [] } = await adapters[provider]!.search!(query);
        noteSuccess(provider);
        const top = items[0];
        proposals.push(
          top
            ? {
                provider,
                status: "auto",
                providerSymbol: top.symbol,
                resolvedName: top.name,
                exchange: top.exchange,
                candidates: items.slice(0, 5),
              }
            : { provider, status: "none" },
        );
      } catch (err) {
        noteError(provider, err);
        proposals.push({ provider, status: "error", error: errMessage(err) });
      }
    }

    return { instrumentKey, keyType, proposals, existing };
  }

  /** Persist user-confirmed mappings. */
  async function save({
    instrumentKey,
    keyType,
    mappings,
  }: {
    instrumentKey: string;
    keyType: string;
    mappings: MappingInput[];
  }) {
    for (const m of mappings) {
      await repo.upsert({
        instrumentKey,
        keyType,
        provider: m.provider,
        providerSymbol: m.providerSymbol ?? m.provider_symbol,
        resolvedName: m.resolvedName ?? m.resolved_name,
        exchange: m.exchange,
        currency: m.currency,
        status: m.status ?? "confirmed",
      });
    }
    return repo.listByInstrument(instrumentKey, keyType);
  }

  function remove(id: number) {
    return repo.deleteById(id);
  }

  /** Cross-provider self-audit: compare currency + price across mapped providers. */
  async function audit({
    instrumentKey,
    keyType,
  }: {
    instrumentKey: string;
    keyType: string;
  }) {
    const rows = await repo.listByInstrument(instrumentKey, keyType);
    const mapped = rows.filter(
      (r): r is InstrumentProviderMapRow & { provider_symbol: string } =>
        Boolean(r.provider_symbol),
    );

    const quotes: AuditQuote[] = [];
    for (const r of mapped) {
      if (
        !adapterSupports(r.provider, "quote", adapters) ||
        !isKeyed(r.provider)
      )
        continue;
      if (!(await reserveProvider(r.provider))) {
        quotes.push({ provider: r.provider, skipped: "quota" });
        continue;
      }
      try {
        // adapterSupports() above guarantees the quote method exists.
        const q = await adapters[r.provider]!.quote!(r.provider_symbol);
        noteSuccess(r.provider);
        quotes.push({
          provider: r.provider,
          currency: q.currency,
          price: q.price,
        });
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

function fromStore(
  provider: string,
  row: InstrumentProviderMapRow,
  status: string,
): MappingProposal {
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

/** Flag currency mismatches and price outliers across provider quotes. */
function analyzeQuotes(quotes: AuditQuote[]): AuditDiscrepancy[] {
  const discrepancies: AuditDiscrepancy[] = [];
  const priced = quotes.filter((q): q is AuditQuote & { price: number } =>
    Number.isFinite(q.price),
  );

  const currencies = [
    ...new Set(priced.map((q) => q.currency).filter(Boolean)),
  ];
  if (currencies.length > 1) {
    discrepancies.push({ type: "currency_mismatch", currencies });
  }

  if (priced.length >= 2) {
    const prices = priced.map((q) => q.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    if (median !== undefined && median > 0) {
      for (const q of priced) {
        if (Math.abs(q.price - median) / median > AUDIT_PRICE_TOLERANCE) {
          discrepancies.push({
            type: "price_outlier",
            provider: q.provider,
            price: q.price,
            median,
          });
        }
      }
    }
  }

  return discrepancies;
}

/** Process-wide singleton used by the research routes. */
export const researchMappingService = createResearchMappingService();

export {
  createResearchMappingService as __createResearchMappingService,
  analyzeQuotes as __analyzeQuotes,
};
