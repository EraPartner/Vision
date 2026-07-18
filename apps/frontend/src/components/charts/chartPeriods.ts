/**
 * Shared time-range periods for charts that scope their data to a window.
 * One definition so the Performance and Net Worth selectors (and any future
 * windowed chart) stay in lockstep. Labels come from the `performance.period.*`
 * i18n keys, which are generic ("1M", "3M", …) and reused across charts.
 */
import { subDays } from "date-fns";
import { parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";

export const CHART_PERIODS = ["1m", "3m", "6m", "1y", "3y", "all"] as const;
export type ChartPeriod = (typeof CHART_PERIODS)[number];

export const CHART_PERIOD_OFFSET_DAYS: Record<Exclude<ChartPeriod, "all">, number> = {
    "1m": 30,
    "3m": 90,
    "6m": 180,
    "1y": 365,
    "3y": 1095,
};

/**
 * Client-side period filter for already-fetched, date-ascending series. Anchors
 * the window to the latest data point (not wall-clock "today") so a series that
 * ends before today still shows its final `period` of data.
 */
export function filterByPeriod<T>(
    items: ReadonlyArray<T>,
    getYmd: (item: T) => string,
    period: ChartPeriod,
): T[] {
    if (period === "all" || items.length === 0) return items.slice();
    const days = CHART_PERIOD_OFFSET_DAYS[period];
    const lastYmd = getYmd(items[items.length - 1]);
    const anchor = parseLocalDateFromYmd(lastYmd);
    if (Number.isNaN(anchor.getTime())) return items.slice();
    // subDays is local-calendar day arithmetic on the midnight anchor —
    // identical to the previous `anchor.setDate(anchor.getDate() - days)`.
    const cutoff = toYmd(subDays(anchor, days));
    return items.filter((item) => getYmd(item) >= cutoff);
}
