import { describe, expect, test } from "vitest";
import { mergeForViewRolling } from "./forecastMerge";
import type { CashflowForecastRollingData } from "@/lib/api/aggregations";

function buildData(daysBack: number, daysForward: number): CashflowForecastRollingData {
    const today = new Date();
    const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const isoAt = (offset: number) =>
        new Date(todayMs + offset * 86_400_000).toISOString().slice(0, 10);

    const actual = [];
    for (let i = -daysBack; i <= daysForward; i++) {
        const date = isoAt(i);
        const isPast = i <= 0;
        actual.push({
            date,
            net: isPast ? 10 : null,
            cumulative: isPast ? (i + daysBack + 1) * 10 : null,
        });
    }

    const futureDates = [];
    for (let i = 1; i <= daysForward; i++) futureDates.push(isoAt(i));

    return {
        window_start: isoAt(-daysBack),
        window_end: isoAt(daysForward),
        today: isoAt(0),
        currency: "EUR",
        days_back: daysBack,
        days_forward: daysForward,
        actual,
        methods: [
            {
                id: "simple_avg",
                label: "Simple Average",
                daily: futureDates.map((d) => ({ date: d, value: 5 })),
                cumulative: actual.map((a, i) => ({ date: a.date, value: i * 5 })),
                bands: null,
                error: null,
            },
            {
                id: "monte_carlo_parametric",
                label: "MC Parametric",
                daily: futureDates.map((d) => ({ date: d, value: 4 })),
                cumulative: actual.map((a, i) => ({ date: a.date, value: i * 4 })),
                bands: {
                    p25: futureDates.map((d) => ({ date: d, value: 2 })),
                    p75: futureDates.map((d) => ({ date: d, value: 8 })),
                },
                error: null,
            },
        ],
        planned: [],
        diagnostics: null,
        history_months: 36,
        include_planned: false,
    };
}

describe("mergeForViewRolling", () => {
    test("rows length === daysBack + daysForward + 1", () => {
        const data = buildData(7, 7);
        const visible = new Set(["simple_avg", "monte_carlo_parametric"]);
        const { rows } = mergeForViewRolling(data, "cumulative", visible, "Actual");
        expect(rows).toHaveLength(15);
    });

    test("each row has a Date `t` field for X axis", () => {
        const data = buildData(3, 3);
        const visible = new Set(["simple_avg"]);
        const { rows } = mergeForViewRolling(data, "daily", visible, "Actual");
        expect(rows.every((r) => r.t instanceof Date)).toBe(true);
        expect(rows[0].t.toISOString().slice(0, 10)).toBe(rows[0].date);
    });

    test("daily view: actual is null for future entries", () => {
        const data = buildData(5, 5);
        const visible = new Set(["simple_avg"]);
        const { rows } = mergeForViewRolling(data, "daily", visible, "Actual");
        // First 6 entries (offset -5 .. 0) are past → actual=10. Last 5 are future → null.
        expect(rows.slice(0, 6).every((r) => r.actual === 10)).toBe(true);
        expect(rows.slice(6).every((r) => r.actual === null)).toBe(true);
    });

    test("cumulative view: bands carry forward last actual cumulative", () => {
        const data = buildData(3, 3);
        const visible = new Set(["monte_carlo_parametric"]);
        const { rows } = mergeForViewRolling(data, "cumulative", visible, "Actual");
        // Last actual cum = 4*10 = 40 (4th entry, index 3). Future band p25 starts at 40 + 2 = 42.
        const futureRow = rows[4];
        expect(futureRow.monte_carlo_parametric__pLo).toBe(42);
        expect(futureRow.monte_carlo_parametric__pHi).toBe(48);
    });

    test("hidden methods omitted from rows", () => {
        const data = buildData(3, 3);
        const visible = new Set<string>(); // none visible
        const { rows, series } = mergeForViewRolling(data, "daily", visible, "Actual");
        expect(rows[0].simple_avg).toBeUndefined();
        // Only the actual series remains.
        expect(series).toHaveLength(1);
        expect(series[0].key).toBe("actual");
    });
});
