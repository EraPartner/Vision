/**
 * Research API client (ADR-079).
 *
 * Unlike the rest of the API layer — which unwraps the envelope to bare `data`
 * via `apiRequest` — the research endpoints carry provenance in `meta`
 * (`provider`, `source`). The UI needs that to render "live data unavailable"
 * instead of a silent blank, so these helpers return `{ data, meta }` together.
 *
 * See docs/api/research.md and docs/features/research.md.
 */

import { API_BASE_URL, apiRequest, parseEnvelopeError, rawFetch } from '@/lib/api/client';
import { buildQuery, type QueryParams } from '@/lib/api/helpers';
import type {
    InstrumentProviderMapping,
    MappingAuditResponse,
    MappingKeyType,
    MappingResolveResponse,
    MappingSaveInput,
    MappingsResponse,
    ResearchAnalyst,
    ResearchAssetClass,
    ResearchChartResponse,
    ResearchMeta,
    ResearchNewsResponse,
    ResearchRange,
    ResearchResult,
    ResearchSearchResponse,
    ResearchScorecardResponse,
    PortfolioForecast,
    PortfolioForecastInput,
    ProviderKeysResponse,
    MacroProvider,
    MacroSearchResponse,
    MacroSeriesResponse,
} from '@/types/research';

interface RawEnvelope<T> {
    ok?: boolean;
    data?: T;
    meta?: Partial<ResearchMeta> & Record<string, unknown>;
}

function normalizeMeta(meta: RawEnvelope<unknown>['meta']): ResearchMeta {
    return {
        provider: (meta?.provider as string | null | undefined) ?? null,
        source: (meta?.source as ResearchMeta['source']) ?? 'unavailable',
        requestId: meta?.requestId as string | undefined,
    };
}

/**
 * GET an `/api/research/*` endpoint and return `{ data, meta }`. Keeps the
 * tracked transport (timeout, abort registration, correlation id) and unified
 * envelope error parsing, but preserves `meta` instead of discarding it.
 */
async function researchGet<T>(endpoint: string, params?: QueryParams): Promise<ResearchResult<T>> {
    const query = buildQuery(params);
    const url = `${API_BASE_URL}${endpoint}${query ? `?${query}` : ''}`;
    const response = await rawFetch(url);
    if (!response.ok) {
        throw await parseEnvelopeError(response, 'Research request failed');
    }
    const body = (await response.json()) as RawEnvelope<T>;
    return { data: body.data as T, meta: normalizeMeta(body.meta) };
}

async function researchSend<T>(
    endpoint: string,
    method: 'POST' | 'DELETE',
    payload?: unknown,
): Promise<ResearchResult<T>> {
    const url = `${API_BASE_URL}${endpoint}`;
    const response = await rawFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) {
        throw await parseEnvelopeError(response, 'Research request failed');
    }
    const body = (await response.json()) as RawEnvelope<T>;
    return { data: body.data as T, meta: normalizeMeta(body.meta) };
}

// ── Data endpoints ──────────────────────────────────────────────────────────

export function searchResearch(query: string): Promise<ResearchResult<ResearchSearchResponse>> {
    return researchGet<ResearchSearchResponse>('/api/research/search', { q: query });
}

export function getResearchChart(
    symbol: string,
    range: ResearchRange,
    assetClass?: ResearchAssetClass,
    /** Pin a preferred provider (still falls through if it fails / is unkeyed). */
    provider?: string,
): Promise<ResearchResult<ResearchChartResponse>> {
    return researchGet<ResearchChartResponse>('/api/research/chart', {
        symbol,
        range,
        asset_class: assetClass,
        provider,
    });
}

export function getResearchAnalyst(
    symbol: string,
): Promise<ResearchResult<ResearchAnalyst | null>> {
    return researchGet<ResearchAnalyst | null>('/api/research/analyst', { symbol });
}

export function getResearchNews(symbol: string): Promise<ResearchResult<ResearchNewsResponse>> {
    return researchGet<ResearchNewsResponse>('/api/research/news', { symbol });
}

// ── Macro economic indicators (ADR-082) ──────────────────────────────────────

/** Search macro series (CPI, rates, unemployment, …) across the macro providers. */
export function searchMacro(query: string): Promise<ResearchResult<MacroSearchResponse>> {
    return researchGet<MacroSearchResponse>('/api/research/macro/search', { q: query });
}

/** Observations for one provider-pinned macro series. */
export function getMacroSeries(
    provider: MacroProvider,
    seriesId: string,
    range: ResearchRange,
): Promise<ResearchResult<MacroSeriesResponse>> {
    return researchGet<MacroSeriesResponse>('/api/research/macro/series', {
        provider,
        series_id: seriesId,
        range,
    });
}

// ── Analytics (ADR-081) ───────────────────────────────────────────────────────

export function getResearchScorecard(
    symbol: string,
    assetClass?: ResearchAssetClass,
): Promise<ResearchResult<ResearchScorecardResponse | null>> {
    return researchGet<ResearchScorecardResponse | null>('/api/research/scorecard', {
        symbol,
        asset_class: assetClass,
    });
}

export function getPortfolioForecast(
    input: PortfolioForecastInput,
): Promise<ResearchResult<PortfolioForecast>> {
    return researchSend<PortfolioForecast>('/api/research/portfolio-forecast', 'POST', {
        horizon_months: input.horizonMonths,
        monthly_contribution: input.monthlyContribution,
        paths: input.paths,
        forward_blend: input.forwardBlend,
        method: input.method,
        target_value: input.targetValue,
        currency: input.currency,
        seed: input.seed,
    });
}

// ── Symbol-mapping endpoints ────────────────────────────────────────────────

export function getResearchMappings(
    instrumentKey: string,
    keyType: MappingKeyType = 'isin',
): Promise<ResearchResult<MappingsResponse>> {
    return researchGet<MappingsResponse>('/api/research/mappings', {
        instrument_key: instrumentKey,
        key_type: keyType,
    });
}

export function resolveResearchMappings(input: {
    instrument_key: string;
    key_type?: MappingKeyType;
    asset_class?: ResearchAssetClass;
    query: string;
    /** When set, the held investment's configured provider is pre-seeded as confirmed. */
    investment_id?: number;
}): Promise<ResearchResult<MappingResolveResponse>> {
    return researchSend<MappingResolveResponse>('/api/research/mappings/resolve', 'POST', input);
}

export function saveResearchMappings(input: {
    instrument_key: string;
    key_type?: MappingKeyType;
    mappings: MappingSaveInput[];
}): Promise<ResearchResult<MappingsResponse>> {
    return researchSend<MappingsResponse>('/api/research/mappings', 'POST', input);
}

export function deleteResearchMapping(id: number): Promise<ResearchResult<{ removed: boolean }>> {
    return researchSend<{ removed: boolean }>(`/api/research/mappings/${id}`, 'DELETE');
}

export function auditResearchMappings(input: {
    instrument_key: string;
    key_type?: MappingKeyType;
}): Promise<ResearchResult<MappingAuditResponse>> {
    return researchSend<MappingAuditResponse>('/api/research/mappings/audit', 'POST', input);
}

// ── Provider API keys (Settings) ──────────────────────────────────────────────
// Plain envelopes (no provenance meta); keys are returned masked, never in full.

export function getResearchProviderKeys(): Promise<ProviderKeysResponse> {
    return apiRequest('/api/research/provider-keys');
}

export function setResearchProviderKey(provider: string, apiKey: string): Promise<ProviderKeysResponse> {
    return apiRequest(`/api/research/provider-keys/${encodeURIComponent(provider)}`, {
        method: 'PUT',
        body: JSON.stringify({ api_key: apiKey }),
    });
}

export function clearResearchProviderKey(
    provider: string,
): Promise<{ removed: boolean } & ProviderKeysResponse> {
    return apiRequest(`/api/research/provider-keys/${encodeURIComponent(provider)}`, {
        method: 'DELETE',
    });
}

export type { InstrumentProviderMapping };
