import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { dashboardKeys, plannedKeys } from "@/lib/queryKeys";
import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { todayYmd } from "@/lib/timezone";
import { toYmd } from "@/lib/dateUtils";
import type { PlannedTransaction } from "@/types/api";

/**
 * Month-to-date spending pace for the Home hero (ADR-181): what was spent
 * from the 1st to today, per-day totals for the cumulative line, and the
 * six-month average the "typical month" guide is drawn from.
 *
 * The endpoint takes no exclusion parameters, so the settings-level
 * category/recipient exclusions do not apply here; the charts below the hero
 * still honour them.
 */
export function useMonthToDate(currency: string) {
    return useQuery({
        queryKey: dashboardKeys.monthToDate(currency),
        queryFn: () =>
            apiClient
                .getAggregationAverageVsCurrent({ currency })
                .then((r) => r.data),
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
    });
}

/** Last calendar day of the month `ymd` falls in, as YYYY-MM-DD. */
export function endOfMonthYmd(ymd: string): string {
    const [year, month] = ymd.split("-").map(Number);
    return toYmd(new Date(year, month, 0));
}

/**
 * Planned rows still due between today and the end of the calendar month,
 * split into money still expected in and still going out. Executed one-time
 * payments are dropped the same way the seven-day reminder drops them.
 */
export function useRestOfMonthPlanned() {
    const today = todayYmd();
    return useQuery({
        queryKey: plannedKeys.restOfMonth(today),
        queryFn: async () => {
            const response = await apiClient.getPlannedTransactions({
                active: true,
                start_date: today,
                end_date: endOfMonthYmd(today),
                limit: 200,
            });
            return response.items.filter(
                (pt) => !(pt.is_executed && !pt.is_recurring),
            );
        },
        staleTime: 5 * 60_000,
        select: (items: PlannedTransaction[]) => {
            const incoming = items.filter((pt) => pt.amount > 0);
            const outgoing = items.filter((pt) => pt.amount < 0);
            const sum = (rows: PlannedTransaction[]) =>
                rows.reduce((total, pt) => total + pt.amount, 0);
            return {
                incoming,
                outgoing,
                incomingTotal: sum(incoming),
                outgoingTotal: sum(outgoing),
            };
        },
    });
}
