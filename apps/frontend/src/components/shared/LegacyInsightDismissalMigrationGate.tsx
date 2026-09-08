import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { dismissInsight, type InsightDismissalRequest } from "@/lib/api/info";
import { ApiClientError } from "@/lib/api/client";
import {
    loadDismissState,
    replaceDismissState,
    type InsightsDismissState,
} from "@/lib/insightsDismiss";
import { insightsKeys } from "@/lib/queryKeys";

interface MigrationEntry {
    request: InsightDismissalRequest;
    retain: (state: InsightsDismissState) => void;
}

const RETRY_DELAY_MS = 60_000;

function isTerminal(error: unknown): boolean {
    return (
        error instanceof ApiClientError &&
        (error.status === 400 || error.status === 404)
    );
}

function entriesFor(state: InsightsDismissState): MigrationEntry[] {
    return [
        ...state.subscriptions.map((record) => ({
            request: {
                kind:
                    record.findingType === "new"
                        ? ("subscription_new" as const)
                        : ("subscription_price_change" as const),
                recipient_id: record.recipientId,
            },
            retain: (next: InsightsDismissState) => {
                next.subscriptions.push(record);
            },
        })),
        ...state.outliers.map((record) => ({
            request: {
                kind: "category_outlier" as const,
                category_id: record.categoryId,
                month_key: record.monthKey,
            },
            retain: (next: InsightsDismissState) => {
                next.outliers.push(record);
            },
        })),
    ];
}

export function LegacyInsightDismissalMigrationGate({
    children,
}: {
    children: ReactNode;
}) {
    const queryClient = useQueryClient();
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const migrate = async (state: InsightsDismissState) => {
            const entries = entriesFor(state);
            if (entries.length === 0) {
                if (!cancelled) setReady(true);
                return;
            }
            const results = await Promise.allSettled(
                entries.map((entry) => dismissInsight(entry.request)),
            );
            if (cancelled) return;

            const remaining: InsightsDismissState = {
                subscriptions: [],
                outliers: [],
            };
            results.forEach((result, index) => {
                if (
                    result.status === "rejected" &&
                    !isTerminal(result.reason)
                ) {
                    entries[index].retain(remaining);
                }
            });
            replaceDismissState(remaining);
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: insightsKeys.digest,
                }),
                queryClient.invalidateQueries({ queryKey: insightsKeys.count }),
            ]);
            if (remaining.subscriptions.length || remaining.outliers.length) {
                retryTimer = setTimeout(
                    () => void migrate(remaining),
                    RETRY_DELAY_MS,
                );
                return;
            }
            setReady(true);
        };

        void migrate(loadDismissState());
        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
        };
    }, [queryClient]);

    return ready ? children : null;
}
