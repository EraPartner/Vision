import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { apiEventBus, type ApiRequestEvent } from './apiEventBus';

export interface EndpointStat {
    endpoint: string;
    count: number;
    errorCount: number;
    p50: number;
    p95: number;
}

export interface QueryMetrics {
    totalRequests: number;
    errorRate: number;
    slowRequests: ApiRequestEvent[];
    topEndpoints: EndpointStat[];
    cacheHitRatio: number;
    mutationsSuccess: number;
    mutationsError: number;
}

const SLOW_THRESHOLD_MS = 1_000;

// Ring of completed events (max 200, same cap as request log)
const completedEvents: ApiRequestEvent[] = [];

// TanStack cache stats
let cacheHits = 0;
let cacheMisses = 0;
let mutationsSuccess = 0;
let mutationsError = 0;

const metricsListeners = new Set<() => void>();

function notify(): void {
    for (const fn of metricsListeners) fn();
}

function computeMetrics(): QueryMetrics {
    const completed = completedEvents.slice();
    const errorCount = completed.filter((e) => e.phase === 'error').length;
    const totalRequests = completed.length;
    const errorRate = totalRequests > 0 ? errorCount / totalRequests : 0;
    const slowRequests = completed.filter(
        (e) => e.phase === 'success' && (e.durationMs ?? 0) >= SLOW_THRESHOLD_MS,
    );

    // Group by endpoint
    const endpointMap = new Map<string, number[]>();
    for (const e of completed) {
        if (e.durationMs === undefined) continue;
        const key = `${e.method} ${e.endpoint}`;
        const durations = endpointMap.get(key) ?? [];
        durations.push(e.durationMs);
        endpointMap.set(key, durations);
    }

    const topEndpoints: EndpointStat[] = Array.from(endpointMap.entries())
        .map(([key, durations]) => {
            const sorted = [...durations].sort((a, b) => a - b);
            const errCount = completed.filter(
                (e) => `${e.method} ${e.endpoint}` === key && e.phase === 'error',
            ).length;
            return {
                endpoint: key,
                count: durations.length,
                errorCount: errCount,
                p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
                p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

    const totalCache = cacheHits + cacheMisses;
    const cacheHitRatio = totalCache > 0 ? cacheHits / totalCache : 0;

    return {
        totalRequests,
        errorRate,
        slowRequests,
        topEndpoints,
        cacheHitRatio,
        mutationsSuccess,
        mutationsError,
    };
}

let cachedMetrics: QueryMetrics = computeMetrics();

apiEventBus.subscribe((event) => {
    if (event.phase === 'start') return;
    completedEvents.unshift(event);
    if (completedEvents.length > 200) completedEvents.pop();
    cachedMetrics = computeMetrics();
    notify();
});

export function initQueryMetrics(queryClient: QueryClient): () => void {
    const unsubQuery = queryClient.getQueryCache().subscribe((cacheEvent) => {
        if (cacheEvent.type === 'updated') {
            const { state } = cacheEvent.query;
            if (state.fetchStatus === 'fetching') {
                cacheMisses++;
            } else if (state.status === 'success' && state.fetchStatus === 'idle') {
                cacheHits++;
            }
            cachedMetrics = computeMetrics();
            notify();
        }
    });

    const unsubMutation = queryClient.getMutationCache().subscribe((cacheEvent) => {
        if (cacheEvent.type === 'updated') {
            const { state } = cacheEvent.mutation;
            if (state.status === 'success') {
                mutationsSuccess++;
                cachedMetrics = computeMetrics();
                notify();
            } else if (state.status === 'error') {
                mutationsError++;
                cachedMetrics = computeMetrics();
                notify();
            }
        }
    });

    return () => {
        unsubQuery();
        unsubMutation();
    };
}

export function useQueryMetrics(): QueryMetrics {
    return useSyncExternalStore(
        (cb) => {
            metricsListeners.add(cb);
            return () => metricsListeners.delete(cb);
        },
        () => cachedMetrics,
    );
}

export function resetQueryMetrics(): void {
    completedEvents.length = 0;
    cacheHits = 0;
    cacheMisses = 0;
    mutationsSuccess = 0;
    mutationsError = 0;
    cachedMetrics = computeMetrics();
    notify();
}
