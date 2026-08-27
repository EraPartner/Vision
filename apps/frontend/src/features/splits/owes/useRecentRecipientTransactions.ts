import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import { transactionKeys } from "@/lib/queryKeys";
import type { Transaction } from "@/types/api";

const RECIPIENT_TRANSACTION_PAGE_SIZE = 10;

export function useRecentRecipientTransactions(recipientId: number) {
    const [items, setItems] = useState<Transaction[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);
    const offsetRef = useRef(0);
    const hasMoreRef = useRef(true);
    const loadingRef = useRef(false);

    const { data, isLoading } = useQuery({
        queryKey: transactionKeys.owesRecipientGroup(recipientId),
        queryFn: () => apiClient.getTransactions({
            recipient_group_id: recipientId,
            limit: RECIPIENT_TRANSACTION_PAGE_SIZE,
            offset: 0,
            sort_by: "transaction_date",
            sort_dir: "desc",
        }),
        staleTime: 30_000,
    });

    useEffect(() => {
        setItems([]);
        setTotalItems(0);
        offsetRef.current = 0;
        hasMoreRef.current = true;
        loadingRef.current = false;
        setIsFetchingMore(false);
    }, [recipientId]);

    useEffect(() => {
        if (!data) return;
        setItems(data.items);
        setTotalItems(data.total ?? data.items.length);
        offsetRef.current = data.items.length;
        hasMoreRef.current = data.items.length < (data.total ?? data.items.length);
    }, [data]);

    const loadMore = useCallback(async () => {
        if (loadingRef.current || !hasMoreRef.current) return;
        loadingRef.current = true;
        setIsFetchingMore(true);
        try {
            const result = await apiClient.getTransactions({
                recipient_group_id: recipientId,
                limit: RECIPIENT_TRANSACTION_PAGE_SIZE,
                offset: offsetRef.current,
                sort_by: "transaction_date",
                sort_dir: "desc",
            });

            setItems((currentItems) => {
                const existingIds = new Set(currentItems.map((item) => item.id));
                return [
                    ...currentItems,
                    ...result.items.filter((item) => !existingIds.has(item.id)),
                ];
            });
            offsetRef.current += result.items.length;
            hasMoreRef.current = offsetRef.current < (result.total ?? result.items.length);
            setTotalItems(result.total ?? result.items.length);
        } finally {
            setIsFetchingMore(false);
            loadingRef.current = false;
        }
    }, [recipientId]);

    return {
        items,
        totalItems,
        isLoading,
        isFetchingMore,
        hasMore: hasMoreRef.current,
        loadMore,
    };
}
