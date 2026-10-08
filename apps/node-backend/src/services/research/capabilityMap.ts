/**
 * Research capability map (ADR-079).
 *
 * Static routing table: for a given research data type and asset class, returns
 * the ordered list of providers to try, best-first. The aggregation router walks
 * this chain and falls through to the next provider when one is unusable
 * (no API key configured, quota exhausted per the quota governor, or reported
 * unhealthy by providerHealthService).
 *
 * Pure module — no I/O, no env reads. Usability is injected via `isUsable` so the
 * map itself stays deterministic and unit-testable.
 */

/** Canonical provider keys (match DB provider keys + adapter module names). */
const PROVIDERS = Object.freeze({
  yahoo: "yahoo",
  twelveData: "twelve_data",
  finnhub: "finnhub",
  fmp: "fmp",
  alphaVantage: "alpha_vantage",
  binance: "binance",
  kinesis: "kinesis",
  // Macro vertical (ADR-082): provider-pinned, not raced — no CAPABILITY entries.
  fred: "fred",
  eurostat: "eurostat",
  dbnomics: "dbnomics",
});

const { yahoo, twelveData, finnhub, fmp, alphaVantage, binance, kinesis } =
  PROVIDERS;

/**
 * dataType -> assetClass -> ordered provider preference.
 * `default` applies when the asset class has no specific override (stocks/ETFs are
 * the common case and use the default chains).
 */
const CAPABILITY: Readonly<
  Record<string, { default: string[] } & Partial<Record<string, string[]>>>
> = Object.freeze({
  search: {
    default: [yahoo, twelveData, finnhub, fmp],
  },
  quote: {
    default: [yahoo, twelveData, finnhub, fmp, alphaVantage],
    crypto: [binance, twelveData, yahoo],
    metals: [kinesis, yahoo, twelveData],
  },
  chart: {
    default: [yahoo, twelveData, finnhub, alphaVantage],
    crypto: [binance, twelveData, yahoo],
    metals: [kinesis, yahoo, twelveData],
  },
  // NOTE: the /api/research/fundamentals + /scorecard routes do NOT race this
  // chain — they call researchAggregator.fetchFundamentals(), which MERGES FMP +
  // Yahoo field-by-field (FMP preferred). This chain is retained for the generic
  // fetch('fundamentals') path and as documented preference.
  fundamentals: {
    default: [fmp, finnhub, yahoo],
  },
  analyst: {
    default: [yahoo, finnhub, fmp],
  },
  news: {
    default: [yahoo, finnhub],
  },
});

/**
 * The raw, unfiltered preference chain for a (dataType, assetClass) pair.
 * Returns a fresh array (never the shared frozen one) so callers may filter it.
 * Unknown data type → empty array.
 */
function providerChain(dataType: string, assetClass?: string): string[] {
  const byClass = CAPABILITY[dataType];
  if (!byClass) return [];
  const chain = byClass[assetClass ?? ""] ?? byClass.default ?? [];
  return [...chain];
}

/**
 * The usable preference chain: `providerChain` filtered by `isUsable`.
 * The router passes an `isUsable` that combines key-presence + quota + health.
 */
export function resolveProviderChain(
  dataType: string,
  assetClass?: string,
  { isUsable = () => true }: { isUsable?: (provider: string) => boolean } = {},
): string[] {
  return providerChain(dataType, assetClass).filter(isUsable);
}

export { PROVIDERS, providerChain as __providerChain };
