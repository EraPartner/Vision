import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import type { RawApiTransaction } from "../types";

type SortDir = "asc" | "desc" | null;

export interface UseTransactionListDataOptions {
    showAll: boolean;
    search: string;
    pageSize: number;
    transactionIdFilter?: number;
    recipientIdFilter?: number;
    categoryIdFilter?: number;
}

export interface UseTransactionListDataResult {
    allItems: RawApiTransaction[];
    setAllItems: React.Dispatch<React.SetStateAction<RawApiTransaction[]>>;
    totalItems: number;
    isLoading: boolean;
    error: Error | null;
    isFetchingMore: boolean;
    hasMoreRef: React.MutableRefObject<boolean>;
    sortKey: string | null;
    sortDir: SortDir;
    handleSortChange: (key: string | null, dir: SortDir) => void;
    loadMore: () => Promise<void>;
    setEditing: (editing: boolean) => void;
    cancelTableEditingRef: React.MutableRefObject<(() => void) | null>;
}

export function useTransactionListData({
    showAll,
    search,
    pageSize,
    transactionIdFilter,
    recipientIdFilter,
    categoryIdFilter,
}: UseTransactionListDataOptions): UseTransactionListDataResult {
    const [sortKey, setSortKey] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<SortDir>(null);
    const [allItems, setAllItems] = useState<RawApiTransaction[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);

    const offsetRef = useRef(0);
    const hasMoreRef = useRef(true);
    const loadingRef = useRef(false);
    const isEditingRef = useRef(false);
    const cancelTableEditingRef = useRef<(() => void) | null>(null);

    const setEditing = useCallback((editing: boolean) => {
        isEditingRef.current = editing;
    }, []);

    const { data: initialData, isLoading, error } = useQuery({
        queryKey: [
            'transactions-virtual',
            {
                active: !showAll,
                search: search || undefined,
                transactionIdFilter,
                recipientIdFilter,
                categoryIdFilter,
                sortKey,
                sortDir,
                pageSize,
            },
        ],
        queryFn: () => apiClient.getTransactions({
            limit: pageSize,
            offset: 0,
            active: !showAll,
            search: search || undefined,
            transaction_id: transactionIdFilter,
            recipient_id: recipientIdFilter,
            category_id: categoryIdFilter,
            sort_by: sortKey || undefined,
            sort_dir: sortDir || undefined,
        }),
        staleTime: 30_000,
    });

    useEffect(() => {
        if (initialData && !isEditingRef.current) {
            setAllItems(initialData.items);
            setTotalItems(initialData.total ?? initialData.items.length);
            offsetRef.current = initialData.items.length;
            hasMoreRef.current = initialData.items.length < (initialData.total ?? initialData.items.length);
        }
    }, [initialData]);

    const loadMore = useCallback(async () => {
        if (loadingRef.current || !hasMoreRef.current) return;
        loadingRef.current = true;
        setIsFetchingMore(true);
        try {
            const result = await apiClient.getTransactions({
                limit: pageSize,
                offset: offsetRef.current,
                active: !showAll,
                search: search || undefined,
                transaction_id: transactionIdFilter,
                recipient_id: recipientIdFilter,
                category_id: categoryIdFilter,
                sort_by: sortKey || undefined,
                sort_dir: sortDir || undefined,
            });
            setAllItems(prev => {
                const existingIds = new Set(prev.map((t) => t.id));
                const newItems = (result.items as RawApiTransaction[]).filter((t) => !existingIds.has(t.id));
                return [...prev, ...newItems];
            });
            offsetRef.current += result.items.length;
            hasMoreRef.current = offsetRef.current < (result.total ?? result.items.length);
            setTotalItems(result.total ?? result.items.length);
        } catch (err) {
            logger.error('Failed to load more transactions:', err);
        } finally {
            setIsFetchingMore(false);
            loadingRef.current = false;
        }
    }, [showAll, search, transactionIdFilter, recipientIdFilter, categoryIdFilter, sortKey, sortDir, pageSize]);

    const handleSortChange = useCallback((key: string | null, dir: SortDir) => {
        setSortKey(key);
        setSortDir(dir);
        setAllItems([]);
        setTotalItems(0);
        offsetRef.current = 0;
        hasMoreRef.current = true;
    }, []);

    return {
        allItems,
        setAllItems,
        totalItems,
        isLoading,
        error: (error as Error | null) ?? null,
        isFetchingMore,
        hasMoreRef,
        sortKey,
        sortDir,
        handleSortChange,
        loadMore,
        setEditing,
        cancelTableEditingRef,
    };
}
