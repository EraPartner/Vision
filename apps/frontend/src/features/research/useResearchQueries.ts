import { useQueries, useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import type {
    MacroProvider,
    MappingKeyType,
    ResearchRange,
} from "@/types/research";

export const researchMappingsKey = (
    instrumentKey: string,
    keyType: MappingKeyType,
) => ["research-mappings", instrumentKey, keyType] as const;

export function useResearchMappingsQuery(
    instrumentKey: string,
    keyType: MappingKeyType,
    enabled: boolean,
) {
    return useQuery({
        queryKey: researchMappingsKey(instrumentKey, keyType),
        queryFn: () => apiClient.getResearchMappings(instrumentKey, keyType),
        enabled: enabled && !!instrumentKey,
        staleTime: 60_000,
    });
}

export function useResearchAnalystQuery(symbol: string, enabled: boolean) {
    return useQuery({
        queryKey: ["research-analyst", symbol],
        queryFn: () => apiClient.getResearchAnalyst(symbol),
        enabled: enabled && !!symbol,
        staleTime: 24 * 60 * 60 * 1000,
    });
}

export function useResearchScorecardQuery(symbol: string, enabled: boolean) {
    return useQuery({
        queryKey: ["research-scorecard", symbol],
        queryFn: () => apiClient.getResearchScorecard(symbol),
        enabled: enabled && !!symbol,
        staleTime: 24 * 60 * 60 * 1000,
    });
}

export function useResearchNewsQuery(symbol: string, enabled: boolean) {
    return useQuery({
        queryKey: ["research-news", symbol],
        queryFn: () => apiClient.getResearchNews(symbol),
        enabled: enabled && !!symbol,
        staleTime: 2 * 60 * 60 * 1000,
    });
}

export function usePortfolioForecastQuery(
    input: Parameters<typeof apiClient.getPortfolioForecast>[0],
) {
    return useQuery({
        queryKey: ["portfolio-forecast", input],
        queryFn: () => apiClient.getPortfolioForecast(input),
        staleTime: 5 * 60 * 1000,
    });
}

export function useMacroSearchQuery(query: string) {
    return useQuery({
        queryKey: ["macro-search", query],
        queryFn: () => apiClient.searchMacro(query),
        enabled: query.length >= 1,
        staleTime: 60_000,
    });
}

export interface ChartBuilderFetchKey {
    key: string;
    symbol: string;
    provider: string;
    macro?: { provider: MacroProvider; seriesId: string; title: string };
}

export function useChartBuilderSeriesQueries(
    fetchKeys: ChartBuilderFetchKey[],
    range: ResearchRange,
) {
    return useQueries({
        queries: fetchKeys.map((fetchKey) => ({
            queryKey: ["research-chart", fetchKey.key, range],
            queryFn: () =>
                fetchKey.macro
                    ? apiClient.getMacroSeries(
                          fetchKey.macro.provider,
                          fetchKey.macro.seriesId,
                          range,
                      )
                    : apiClient.getResearchChart(
                          fetchKey.symbol,
                          range,
                          undefined,
                          fetchKey.provider || undefined,
                      ),
            enabled: fetchKey.macro ? true : !!fetchKey.symbol,
            staleTime: 60_000,
        })),
    });
}

export function useResearchCompareQueries(
    symbols: string[],
    range: ResearchRange,
) {
    const charts = useQueries({
        queries: symbols.map((symbol) => ({
            queryKey: ["research-chart", symbol, range],
            queryFn: () => apiClient.getResearchChart(symbol, range),
            enabled: !!symbol,
            staleTime: 60_000,
        })),
    });
    const fundamentals = useQueries({
        queries: symbols.map((symbol) => ({
            queryKey: ["research-scorecard", symbol],
            queryFn: () => apiClient.getResearchScorecard(symbol),
            enabled: !!symbol,
            staleTime: 24 * 60 * 60 * 1000,
        })),
    });
    return { charts, fundamentals };
}
