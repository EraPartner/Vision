import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import { transactionKeys } from "@/lib/queryKeys";
import { useLanguage } from "@/contexts/LanguageContext";
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
    categoryIdsFilter?: number[];
    startDateFilter?: string;
    endDateFilter?: string;
    transactionTypeFilter?: 'income' | 'expense';
    amountMinFilter?: number;
    amountMaxFilter?: number;
    amountSignedFilter?: boolean;
    tagsFilter?: string[];
    /** Preferred account filter (exact FK match, ADR-088). */
    accountIdFilter?: number;
    bankAccountFilter?: string;
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
    categoryIdsFilter,
    startDateFilter,
    endDateFilter,
    transactionTypeFilter,
    amountMinFilter,
    amountMaxFilter,
    amountSignedFilter,
    tagsFilter,
    accountIdFilter,
    bankAccountFilter,
}: UseTransactionListDataOptions): UseTransactionListDataResult {
    const { t } = useLanguage();
    // Sort is URL-first like every filter on this page, so a reloaded or shared
    // link reproduces the sender's ordering instead of silently reverting to
    // the default. Key and direction are only honoured together — a half-set
    // pair (hand-edited URL) reads as unsorted.
    const [searchParams, setSearchParams] = useSearchParams();
    const sortDirParam = searchParams.get("sort_dir");
    const sortKeyParam = searchParams.get("sort_key");
    const validDir: SortDir = sortDirParam === "asc" || sortDirParam === "desc" ? sortDirParam : null;
    const sortKey = validDir && sortKeyParam ? sortKeyParam : null;
    const sortDir: SortDir = sortKey ? validDir : null;

    const [allItems, setAllItems] = useState<RawApiTransaction[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);

    const offsetRef = useRef(0);
    const hasMoreRef = useRef(true);
    const loadingRef = useRef(false);
    const isEditingRef = useRef(false);
    const cancelTableEditingRef = useRef<(() => void) | null>(null);
    // Monotonic id stamped on each loadMore. Sort/filter changes bump this so
    // in-flight responses from a prior query are discarded on resolve.
    const requestIdRef = useRef(0);
    // Lets the failure toast's retry action re-invoke the latest loadMore
    // without loadMore having to close over itself.
    const loadMoreRef = useRef<(() => Promise<void>) | null>(null);

    const setEditing = useCallback((editing: boolean) => {
        isEditingRef.current = editing;
    }, []);

    const { data: initialData, isLoading, error } = useQuery({
        queryKey: transactionKeys.virtualList({
            active: !showAll,
            search: search || undefined,
            transactionIdFilter,
            recipientIdFilter,
            categoryIdFilter,
            categoryIdsFilter,
            startDateFilter,
            endDateFilter,
            transactionTypeFilter,
            amountMinFilter,
            amountMaxFilter,
            amountSignedFilter,
            tagsFilter,
            accountIdFilter,
            bankAccountFilter,
            sortKey,
            sortDir,
            pageSize,
        }),
        // Forward React Query's abort `signal` so a superseded keystroke's
        // request is actually aborted client-side (React Query drops the stale
        // query, but without this the expensive backend search kept running).
        queryFn: ({ signal }) => apiClient.getTransactions({
            limit: pageSize,
            offset: 0,
            active: !showAll,
            search: search || undefined,
            transaction_id: transactionIdFilter,
            recipient_id: recipientIdFilter,
            category_id: categoryIdFilter,
            category_ids: categoryIdsFilter,
            start_date: startDateFilter,
            end_date: endDateFilter,
            transaction_type: transactionTypeFilter,
            amount_min: amountMinFilter,
            amount_max: amountMaxFilter,
            amount_signed: amountSignedFilter || undefined,
            tags: tagsFilter?.length ? tagsFilter.join(',') : undefined,
            account_id: accountIdFilter,
            bank_account: bankAccountFilter,
            sort_by: sortKey || undefined,
            sort_dir: sortDir || undefined,
        }, signal),
        placeholderData: (prev) => prev, // keep previous page while a new filter/search/sort round-trips
        staleTime: 30_000,
    });

    useEffect(() => {
        if (initialData && !isEditingRef.current) {
            setAllItems(initialData.items as unknown as RawApiTransaction[]);
            setTotalItems(initialData.total ?? initialData.items.length);
            offsetRef.current = initialData.items.length;
            hasMoreRef.current = initialData.items.length < (initialData.total ?? initialData.items.length);
        }
    }, [initialData]);

    // Any change to the query inputs starts a new logical query. Bump the
    // request id so an in-flight loadMore from the *previous* inputs fails its
    // `myRequestId !== requestIdRef.current` check and can't append stale rows
    // (e.g. rows from a now-cleared category filter) into the reset list.
    // Previously only handleSortChange bumped it, so filter/search changes raced.
    useEffect(() => {
        requestIdRef.current += 1;
    }, [showAll, search, transactionIdFilter, recipientIdFilter, categoryIdFilter, categoryIdsFilter, startDateFilter, endDateFilter, transactionTypeFilter, amountMinFilter, amountMaxFilter, amountSignedFilter, tagsFilter, accountIdFilter, bankAccountFilter, sortKey, sortDir, pageSize]);

    const loadMore = useCallback(async () => {
        if (loadingRef.current || !hasMoreRef.current) return;
        loadingRef.current = true;
        const myRequestId = ++requestIdRef.current;
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
                category_ids: categoryIdsFilter,
                start_date: startDateFilter,
                end_date: endDateFilter,
                transaction_type: transactionTypeFilter,
                amount_min: amountMinFilter,
                amount_max: amountMaxFilter,
                amount_signed: amountSignedFilter || undefined,
                tags: tagsFilter?.length ? tagsFilter.join(',') : undefined,
                account_id: accountIdFilter,
                bank_account: bankAccountFilter,
                sort_by: sortKey || undefined,
                sort_dir: sortDir || undefined,
            });
            // Sort/filter change bumped requestIdRef while we awaited — drop
            // this stale page so it cannot append rows from a prior query.
            if (myRequestId !== requestIdRef.current) return;
            setAllItems(prev => {
                const existingIds = new Set(prev.map((t) => t.id));
                const newItems = (result.items as unknown as RawApiTransaction[]).filter((t) => !existingIds.has(t.id));
                return [...prev, ...newItems];
            });
            offsetRef.current += result.items.length;
            hasMoreRef.current = offsetRef.current < (result.total ?? result.items.length);
            setTotalItems(result.total ?? result.items.length);
        } catch (err) {
            if (myRequestId !== requestIdRef.current) return;
            logger.error('Failed to load more transactions:', err);
            // A silently-truncated finance list reads as "end of data", which
            // is worse than an error. Say so, and offer an explicit retry —
            // `hasMoreRef` is untouched, so the next page is still fetchable.
            toast.error(t('txPage.loadMoreFailed'), {
                description: t('txPage.loadMoreFailedDesc'),
                action: {
                    label: t('common.retry'),
                    onClick: () => { void loadMoreRef.current?.(); },
                },
            });
        } finally {
            if (myRequestId === requestIdRef.current) {
                setIsFetchingMore(false);
            }
            loadingRef.current = false;
        }
    }, [showAll, search, transactionIdFilter, recipientIdFilter, categoryIdFilter, categoryIdsFilter, startDateFilter, endDateFilter, transactionTypeFilter, amountMinFilter, amountMaxFilter, amountSignedFilter, tagsFilter, accountIdFilter, bankAccountFilter, sortKey, sortDir, pageSize, t]);

    // Assigned in an effect, not during render: a render can be discarded under
    // concurrent rendering, and the retry action only fires post-commit anyway.
    useEffect(() => {
        loadMoreRef.current = loadMore;
    }, [loadMore]);

    const handleSortChange = useCallback((key: string | null, dir: SortDir) => {
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                if (key && dir) {
                    next.set("sort_key", key);
                    next.set("sort_dir", dir);
                } else {
                    next.delete("sort_key");
                    next.delete("sort_dir");
                }
                return next;
            },
            // Replace so cycling a column through asc/desc/none does not push
            // three history entries the user has to Back through.
            { replace: true },
        );
        // Keep the current rows on screen while the re-sorted page round-trips
        // (React Query's placeholderData does the same for filter/search): the
        // initialData effect swaps in the new ordering when it arrives, so the
        // list re-sorts in place instead of blanking to a skeleton.
        offsetRef.current = 0;
        hasMoreRef.current = true;
        // Invalidate any in-flight loadMore so its response cannot append
        // rows from the previous sort/filter into the list.
        requestIdRef.current += 1;
    }, [setSearchParams]);

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
