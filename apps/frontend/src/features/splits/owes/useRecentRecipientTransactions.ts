import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { transactionKeys } from "@/lib/queryKeys";
import type { Transaction } from "@/types/api";
import type { RecipientId } from "@vision/types/brands";

const RECIPIENT_TRANSACTION_PAGE_SIZE = 10;

/**
 * A page can arrive without `total`; the page length then stands in for it.
 * The parameter is typed optional on purpose: the wire type promises `total`,
 * the runtime does not always deliver it.
 */
function pageTotal(page: {
    total?: number | undefined;
    items: readonly unknown[];
}): number {
    return page.total ?? page.items.length;
}

export function useRecentRecipientTransactions(recipientId: RecipientId) {
    const { t } = useLanguage();
    const [items, setItems] = useState<Transaction[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);
    const offsetRef = useRef(0);
    const hasMoreRef = useRef(true);
    const loadingRef = useRef(false);

    const { data, isLoading } = useQuery({
        queryKey: transactionKeys.owesRecipientGroup(recipientId),
        queryFn: () =>
            apiClient.getTransactions({
                recipient_group_id: recipientId,
                limit: RECIPIENT_TRANSACTION_PAGE_SIZE,
                offset: 0,
                sort_by: "transaction_date",
                sort_dir: "desc",
            }),
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
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
        setTotalItems(pageTotal(data));
        offsetRef.current = data.items.length;
        hasMoreRef.current =
            data.items.length < pageTotal(data);
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
                const existingIds = new Set(
                    currentItems.map((item) => item.id),
                );
                return [
                    ...currentItems,
                    ...result.items.filter((item) => !existingIds.has(item.id)),
                ];
            });
            offsetRef.current += result.items.length;
            hasMoreRef.current =
                offsetRef.current < pageTotal(result);
            setTotalItems(pageTotal(result));
        } catch (err) {
            // `hasMoreRef` is untouched, so scrolling again retries the page.
            logger.error("Failed to load more recipient transactions:", err);
            toast.error(t("txPage.loadMoreFailed"), {
                description: t("txPage.loadMoreFailedDesc"),
            });
        } finally {
            setIsFetchingMore(false);
            loadingRef.current = false;
        }
    }, [recipientId, t]);

    return {
        items,
        totalItems,
        isLoading,
        isFetchingMore,
        hasMore: hasMoreRef.current,
        loadMore,
    };
}
