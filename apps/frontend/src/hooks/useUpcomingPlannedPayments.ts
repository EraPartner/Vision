import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { plannedKeys } from "@/lib/queryKeys";
import { toYmd, todayYmd } from "@/lib/timezone";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import type { PlannedTransaction } from "@/types/api";

/**
 * Shared source for "planned payments due in the next 7 days" plus the
 * dismissed-occurrence set. Backs the global UpcomingPaymentsNotification
 * banner (shown above every page); the dismissed set lives in a module-level
 * store (persisted to localStorage) so a dismissal sticks across navigations.
 *
 * Dismissals are keyed per OCCURRENCE (`id:planned_date`), not per row id:
 * recurring payments keep their id while planned_date advances each cycle,
 * so an id-only key would silence every future occurrence after a single
 * dismissal. Past-dated keys are pruned on load, which also bounds growth.
 * Legacy id-only numeric entries are intentionally dropped by the format
 * filter (one-time reappearance of previously dismissed reminders).
 */

type DismissTarget = Pick<PlannedTransaction, "id" | "planned_date">;

const DISMISS_KEY_RE = /^\d+:\d{4}-\d{2}-\d{2}$/;

/** `planned_date` is sliced defensively: today's API serializes pg DATE
 *  columns as full ISO timestamps on some paths; the pending global
 *  type-parser fix will turn them into plain YYYY-MM-DD strings. */
export function dismissKeyFor(pt: DismissTarget): string {
    return `${pt.id}:${String(pt.planned_date).slice(0, 10)}`;
}

let dismissedCache: Set<string> | undefined;
const listeners = new Set<() => void>();

function loadDismissed(): Set<string> {
    try {
        const raw = window.localStorage.getItem(LOCAL_STORAGE_KEYS.DISMISSED_UPCOMING_PAYMENTS);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const today = todayYmd();
                return new Set(
                    parsed
                        .filter((v): v is string => typeof v === "string" && DISMISS_KEY_RE.test(v))
                        // Keep only occurrences that can still appear in the
                        // upcoming window; anything past-dated is stale.
                        .filter((key) => key.slice(key.indexOf(":") + 1) >= today),
                );
            }
        }
    } catch {
        // Ignore invalid localStorage payloads.
    }
    return new Set();
}

function getDismissedSnapshot(): Set<string> {
    if (!dismissedCache) dismissedCache = loadDismissed();
    return dismissedCache;
}

function subscribeDismissed(cb: () => void) {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

function dismissOccurrences(keys: string[]) {
    const next = new Set(getDismissedSnapshot());
    keys.forEach((key) => next.add(key));
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

/** Test-only: reset the module-level cache so each test re-reads localStorage. */
export function __resetDismissedCacheForTests() {
    dismissedCache = undefined;
}

export function useUpcomingPlannedPayments() {
    const dismissedKeys = useSyncExternalStore(subscribeDismissed, getDismissedSnapshot);

    const queryDate = toYmd(new Date());

    const { data: upcoming } = useQuery({
        queryKey: plannedKeys.upcoming(queryDate),
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

    const visibleUpcoming = (upcoming ?? []).filter((pt) => !dismissedKeys.has(dismissKeyFor(pt)));

    const dismiss = useCallback((targets: DismissTarget | DismissTarget[]) => {
        const list = Array.isArray(targets) ? targets : [targets];
        dismissOccurrences(list.map(dismissKeyFor));
    }, []);

    return { upcoming, visibleUpcoming, dismiss };
}
