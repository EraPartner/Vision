/**
 * Types for the Research section (ADR-079).
 *
 * The `/api/research/*` endpoints return the standard ADR-026 envelope with two
 * extra provenance fields in `meta` (`provider`, `source`). The API client
 * unwraps `data`; the research module re-surfaces `meta` alongside it (see
 * `lib/api/research.ts`) so the UI can render unavailability rather than a
 * silent blank.
 */

/** Provenance of a research response, lifted from the envelope `meta`. */
export type ResearchSource = 'cache' | 'live' | 'unavailable';

export interface ResearchMeta {
    provider: string | null;
    source: ResearchSource;
    requestId?: string;
}

/** A research response paired with its provenance. */
export interface ResearchResult<T> {
    data: T;
    meta: ResearchMeta;
}

// ── Data endpoints ──────────────────────────────────────────────────────────

export interface ResearchSearchItem {
    symbol: string;
    name: string;
    type: string;
    exchange: string;
}

export interface ResearchSearchResponse {
    items: ResearchSearchItem[];
}

export interface ResearchQuote {
    symbol: string;
    name: string;
    price: number;
    change: number;
    changePercent: number;
    currency: string;
    exchange: string;
    type: string;
    open: number;
    dayHigh: number;
    dayLow: number;
    prevClose: number;
    volume: number;
    avgVolume: number;
    high52w: number;
    low52w: number;
}

export interface ResearchChartPoint {
    time: number;
    close: number;
    high: number;
    low: number;
    volume: number;
}

export interface ResearchChartResponse {
    symbol: string;
    currency: string;
    points: ResearchChartPoint[];
}

export interface ResearchFundamentals {
    symbol: string;
    name: string;
    currency: string;
    marketCap: number | null;
    pe: number | null;
    forwardPE: number | null;
    dividendYield: number | null;
    eps: number | null;
    beta: number | null;
    priceToBook: number | null;
    profitMargin: number | null;
    revenue: number | null;
    returnOnEquity: number | null;
    // Extended fields (ADR-081) — optional; providers expose different subsets.
    sector?: string | null;
    pegRatio?: number | null;
    payoutRatio?: number | null;
    grossMargin?: number | null;
    operatingMargin?: number | null;
    revenueGrowth?: number | null;
    earningsGrowth?: number | null;
    debtToEquity?: number | null;
    currentRatio?: number | null;
    quickRatio?: number | null;
    interestCoverage?: number | null;
    freeCashFlow?: number | null;
    fcfYield?: number | null;
}

export interface ResearchAnalystConsensus {
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
}

export interface ResearchAnalystAction {
    date: string | number;
    firm: string;
    toGrade: string;
    fromGrade: string | null;
    action: string;
}

export interface ResearchAnalyst {
    symbol: string;
    consensus: ResearchAnalystConsensus | null;
    targetMean: number | null;
    targetHigh: number | null;
    targetLow: number | null;
    numberOfAnalysts: number | null;
    recentActions: ResearchAnalystAction[];
}

export interface ResearchNewsArticle {
    title: string;
    link: string;
    publisher: string;
    publishedAt: number | null;
    thumbnail: string | null;
    relatedSymbols: string[];
}

export interface ResearchNewsResponse {
    articles: ResearchNewsArticle[];
}

/** Time ranges accepted by the chart endpoint. */
export type ResearchRange = '1d' | '5d' | '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y' | 'max';

/** Asset-class routing hint passed to quote/chart/fundamentals. */
export type ResearchAssetClass = 'stock' | 'etf' | 'crypto' | 'metals';

// ── Symbol-mapping endpoints ────────────────────────────────────────────────

export type MappingKeyType = 'isin' | 'internal';

export type MappingStatus =
    | 'confirmed'
    | 'auto'
    | 'failed'
    | 'skipped'
    | 'none'
    | 'unavailable'
    | 'error';

export interface InstrumentProviderMapping {
    id: number;
    instrument_key: string;
    key_type: MappingKeyType;
    provider: string;
    provider_symbol: string;
    resolved_name: string | null;
    exchange: string | null;
    currency: string | null;
    status: MappingStatus;
    verified_at: string | null;
}

export interface MappingProposalCandidate {
    providerSymbol: string;
    resolvedName?: string;
    exchange?: string;
    currency?: string;
}

export interface MappingProposal {
    provider: string;
    status: MappingStatus;
    providerSymbol?: string;
    resolvedName?: string;
    exchange?: string;
    currency?: string;
    candidates?: MappingProposalCandidate[];
    /** Kept from a stored mapping rather than freshly searched. */
    fromStore?: boolean;
    /** Pre-seeded from a held investment's already-configured provider. */
    fromHolding?: boolean;
}

export interface MappingResolveResponse {
    instrument_key: string;
    key_type: MappingKeyType;
    proposals: MappingProposal[];
    existing: InstrumentProviderMapping[];
}

export interface MappingSaveInput {
    provider: string;
    providerSymbol: string;
    resolvedName?: string;
    exchange?: string;
    currency?: string;
}

export interface MappingsResponse {
    mappings: InstrumentProviderMapping[];
}

export type MappingDiscrepancyType = 'currency_mismatch' | 'price_outlier';

export interface MappingDiscrepancy {
    type: MappingDiscrepancyType;
    provider?: string;
    [key: string]: unknown;
}

export interface MappingAuditQuote {
    provider: string;
    currency?: string;
    price?: number;
    skipped?: boolean;
    error?: string;
}

export interface MappingAuditResponse {
    ok: boolean;
    quotes: MappingAuditQuote[];
    discrepancies: MappingDiscrepancy[];
}

// ── Provider API keys (Settings) ──────────────────────────────────────────────

export interface ProviderKeyStatus {
    provider: string;
    label: string;
    envVar: string;
    configured: boolean;
    source: 'settings' | 'env' | 'none';
    masked?: string;
}

export interface ProviderKeysResponse {
    providers: ProviderKeyStatus[];
}

// ── Fundamentals scorecard (ADR-081) ─────────────────────────────────────────

export type ScorecardSeverity = 'ok' | 'caution' | 'warn' | 'risk';
export type ScorecardGrade = 'strong' | 'healthy' | 'mixed' | 'weak' | 'poor' | 'unknown';

export interface ScorecardFlag {
    metric: string;
    category: 'liquidity' | 'leverage' | 'profitability' | 'cashflow' | 'growth' | 'valuation' | 'dividend';
    better: 'higher' | 'lower';
    value: number;
    severity: ScorecardSeverity;
    /** Stable `<metric>.<severity>` code (severity-derived; can collide across reasons). */
    code: string;
    /** Stable `<metric>.<slug>` key, unique per distinct message — used for i18n lookup. */
    reasonKey: string;
    /** English fallback explanation (used when no localized `reasonKey` string exists). */
    reason: string;
    benchmark: string;
}

export interface ResearchScorecard {
    score: number | null;
    grade: ScorecardGrade;
    evaluated: number;
    counts: Record<ScorecardSeverity, number>;
    flags: ScorecardFlag[];
}

export interface ResearchScorecardResponse {
    symbol: string;
    fundamentals: ResearchFundamentals;
    scorecard: ResearchScorecard;
}

// ── Portfolio forecast (ADR-081, Pillar C) ───────────────────────────────────

export type ForecastMethod = 'parametric' | 'block_bootstrap';
export type ForecastReturnSource = 'historical' | 'blended';

export interface PortfolioForecastInput {
    horizonMonths: number;
    monthlyContribution?: number;
    paths?: number;
    /** 0 = pure historical drift, 1 = pure forward. */
    forwardBlend?: number;
    method?: ForecastMethod;
    targetValue?: number;
    currency?: string;
    seed?: string;
}

export interface ForecastPoint {
    monthIndex: number;
    date: string;
    netInvested: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
}

export interface ForecastForwardHolding {
    symbol: string;
    expectedAnnual: number;
    growth: number;
    dividendYield?: number;
}

export interface PortfolioForecast {
    available: boolean;
    reason?: 'no_holdings' | 'insufficient_history';
    currency?: string;
    method?: ForecastMethod;
    horizonMonths?: number;
    paths?: number;
    seed?: string;
    historyDays?: number;
    flowArtifactDays?: number;
    lowConfidence?: boolean;
    startValue?: number;
    startInvested?: number;
    monthlyContribution?: number;
    totalContributions?: number;
    netInvested?: number;
    expectedAnnualReturn?: number;
    historicalAnnualReturn?: number;
    annualVolatility?: number;
    forwardBlend?: number;
    usedForward?: boolean;
    forwardHoldings?: ForecastForwardHolding[];
    projected?: {
        mean: number;
        p10: number;
        p25: number;
        p50: number;
        p75: number;
        p90: number;
    };
    probBelowInvested?: number;
    targetValue?: number;
    probTarget?: number;
    points?: ForecastPoint[];
}
