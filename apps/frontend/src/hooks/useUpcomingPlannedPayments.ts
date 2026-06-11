import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { toYmd } from "@/lib/timezone";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";

/**
 * Shared source for "planned payments due in the next 7 days" plus the
 * dismissed-ID set. Used by both the global UpcomingPaymentsNotification
 * banner and the dashboard SuggestionCard; the dismissed set lives in a
 * module-level store (persisted to localStorage) so dismissing in one
 * surface immediately hides the payment in the other.
 */

let dismissedCache: Set<number> | undefined;
const listeners = new Set<() => void>();

function loadDismissed(): Set<number> {
    try {
        const raw = window.localStorage.getItem(LOCAL_STORAGE_KEYS.DISMISSED_UPCOMING_PAYMENTS);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return new Set(
                    parsed.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0),
                );
            }
        }
    } catch {
        // Ignore invalid localStorage payloads.
    }
    return new Set();
}

function getDismissedSnapshot(): Set<number> {
    if (!dismissedCache) dismissedCache = loadDismissed();
    return dismissedCache;
}

function subscribeDismissed(cb: () => void) {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

function dismissIds(ids: number[]) {
    const next = new Set(getDismissedSnapshot());
    ids.forEach((id) => next.add(id));
    dismissedCache = next;
    try {
        window.localStorage.setItem(
            LOCAL_STORAGE_KEYS.DISMISSED_UPCOMING_PAYMENTS,
            JSON.stringify([...next]),
        );
    } catch {
        // Ignore storage write failures.
    }
    listeners.forEach((fn) => fn());
}

export function useUpcomingPlannedPayments() {
    const dismissedIds = useSyncExternalStore(subscribeDismissed, getDismissedSnapshot);

    const queryDate = toYmd(new Date());

    const { data: upcoming } = useQuery({
        queryKey: ["upcomingPlannedPayments", queryDate],
        queryFn: async () => {
            // Derive the range from queryDate (the key) so the fetched window can't
            // disagree with the cache key across a midnight boundary.
            const nextWeek = new Date(`${queryDate}T00:00:00`);
            nextWeek.setDate(nextWeek.getDate() + 7);

            const response = await apiClient.getPlannedTransactions({
                active: true,
                start_date: queryDate,
                end_date: toYmd(nextWeek),
                limit: 100,
            });

            // Filter out already-executed one-time payments
            return response.items.filter((pt) => !(pt.is_executed && !pt.is_recurring));
        },
        staleTime: 5 * 60_000,
    });

    const visibleUpcoming = (upcoming ?? []).filter((pt) => !dismissedIds.has(pt.id));

    const dismiss = useCallback((ids: number | number[]) => {
        dismissIds(Array.isArray(ids) ? ids : [ids]);
    }, []);

    return { upcoming, visibleUpcoming, dismiss };
}
