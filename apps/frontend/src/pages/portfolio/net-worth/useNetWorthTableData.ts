import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { netWorthKeys } from "@/lib/queryKeys";
import type { NetWorthSnapshot } from "@/lib/api";
import logger from "@/lib/logger";

export interface UseNetWorthTableDataOptions {
    currency: string;
    pageSize: number;
}

export interface UseNetWorthTableDataResult {
    allItems: NetWorthSnapshot[];
    totalItems: number;
    isLoading: boolean;
    error: Error | null;
    isFetchingMore: boolean;
    hasMoreRef: React.MutableRefObject<boolean>;
    hasMore: boolean;
    loadMore: () => Promise<void>;
}

/**
 * Snapshot table data loader — mirrors useTransactionListData.
 *
 * The server returns snapshots newest-first when pagination params are
 * supplied. The chart path (NetWorthPage main query) stays unpaginated to
 * preserve full-history rendering; this hook is scoped to the table only.
 */
export function useNetWorthTableData({
    currency,
    pageSize,
}: UseNetWorthTableDataOptions): UseNetWorthTableDataResult {
    const [allItems, setAllItems] = useState<NetWorthSnapshot[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);

    const offsetRef = useRef(0);
    const hasMoreRef = useRef(true);
    const loadingRef = useRef(false);

    const { data: initialData, isLoading, error } = useQuery({
        queryKey: netWorthKeys.table({ currency, pageSize }),
        queryFn: () => apiClient.getNetWorth({ currency, limit: pageSize, offset: 0 }),
        staleTime: 120_000,
    });

    useEffect(() => {
        if (!initialData) return;
        const items = initialData.snapshots ?? [];
        const total = initialData.snapshotsTotal ?? items.length;
        setAllItems(items);
        setTotalItems(total);
        offsetRef.current = items.length;
        hasMoreRef.current = items.length < total;
        setHasMore(items.length < total);
    }, [initialData]);

    const loadMore = useCallback(async () => {
        if (loadingRef.current || !hasMoreRef.current) return;
        loadingRef.current = true;
        setIsFetchingMore(true);
        try {
            const result = await apiClient.getNetWorth({
                currency,
                limit: pageSize,
                offset: offsetRef.current,
            });
            const newSnapshots = result.snapshots ?? [];
            const total = result.snapshotsTotal ?? (offsetRef.current + newSnapshots.length);
            setAllItems((prev) => {
                const existingDates = new Set(prev.map((s) => s.date));
                const deduped = newSnapshots.filter((s) => !existingDates.has(s.date));
                return [...prev, ...deduped];
            });
            offsetRef.current += newSnapshots.length;
            hasMoreRef.current = offsetRef.current < total;
            setTotalItems(total);
            setHasMore(offsetRef.current < total);
        } catch (err) {
            logger.error('Failed to load more net worth snapshots:', err);
        } finally {
            setIsFetchingMore(false);
            loadingRef.current = false;
        }
    }, [currency, pageSize]);

    return {
        allItems,
        totalItems,
        isLoading,
        error: (error as Error | null) ?? null,
        isFetchingMore,
        hasMoreRef,
        hasMore,
        loadMore,
    };
}
