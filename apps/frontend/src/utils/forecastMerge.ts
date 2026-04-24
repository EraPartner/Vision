import { getChartColor } from "@/components/charts/palette";
import type { LineSeries } from "@/components/charts/LineChart";
import type { CashflowForecastMethodsData } from "@/lib/api/aggregations";

export const ACTUAL_COLOR = "hsl(var(--primary))";

export const METHOD_COLORS: Record<string, string> = {
    simple_avg: getChartColor(0),
    weighted_avg: getChartColor(1),
    ewma: getChartColor(2),
    holt_winters: getChartColor(3),
    prophet_lite: getChartColor(4),
    monte_carlo_parametric: getChartColor(5),
    monte_carlo_block_bootstrap: getChartColor(6),
};

export const MC_METHOD_IDS: ReadonlySet<string> = new Set([
    "monte_carlo_parametric",
    "monte_carlo_block_bootstrap",
]);

export interface MergedDay {
    date: string;
    dayNum: number;
    actual: number | null;
    [key: string]: number | null | string;
}

/** Return { loKey, hiKey, loLabel, hiLabel } for a method's bands object. */
function bandBoundaryKeys(bands: Record<string, unknown>): {
    loKey: string;
    hiKey: string;
    loLabel: string;
    hiLabel: string;
} {
    const keys = Object.keys(bands).sort(
        (a, b) => Number(a.replace("p", "")) - Number(b.replace("p", "")),
    );
    const loKey = keys[0] ?? "p25";
    const hiKey = keys[keys.length - 1] ?? "p75";
    const loLabel = `P${loKey.replace("p", "")}`;
    const hiLabel = `P${hiKey.replace("p", "")}`;
    return { loKey, hiKey, loLabel, hiLabel };
}

export function mergeForView(
    data: CashflowForecastMethodsData,
    view: "cumulative" | "daily",
    visibleMethodIds: ReadonlySet<string>,
    actualLabel: string,
): { rows: MergedDay[]; series: LineSeries<MergedDay>[] } {
    const cumulativeByDate = new Map(
        data.actual.map((p) => [p.date, p.cumulative]),
    );
    const actualByDate = new Map(data.actual.map((p) => [p.date, p.net]));

    const allDates = data.actual.map((p) => p.date);

    type BandPair = { pLo: Map<string, number>; pHi: Map<string, number> };

    const bandsCumByMethod = new Map<string, BandPair>();

    if (view === "cumulative") {
        const lastActualCum =
            data.actual.filter((p) => p.cumulative !== null).at(-1)
                ?.cumulative ?? 0;

        for (const m of data.methods) {
            if (!m.bands || !visibleMethodIds.has(m.id)) continue;
            const { loKey, hiKey } = bandBoundaryKeys(m.bands);
            const loSrc = m.bands[loKey] ?? [];
            const hiSrc = m.bands[hiKey] ?? [];

            let cumLo = lastActualCum;
            let cumHi = lastActualCum;
            const pLo = new Map<string, number>();
            const pHi = new Map<string, number>();
            for (const pt of loSrc) {
                cumLo += pt.value;
                pLo.set(pt.date, cumLo);
            }
            for (const pt of hiSrc) {
                cumHi += pt.value;
                pHi.set(pt.date, cumHi);
            }
            bandsCumByMethod.set(m.id, { pLo, pHi });
        }
    }

    const methodMaps = new Map<string, Map<string, number>>();
    for (const m of data.methods) {
        const src = view === "cumulative" ? m.cumulative : m.daily;
        methodMaps.set(m.id, new Map(src.map((p) => [p.date, p.value])));
    }

    const bandsDailyByMethod = new Map<string, BandPair>();
    if (view === "daily") {
        for (const m of data.methods) {
            if (!m.bands || !visibleMethodIds.has(m.id)) continue;
            const { loKey, hiKey } = bandBoundaryKeys(m.bands);
            bandsDailyByMethod.set(m.id, {
                pLo: new Map((m.bands[loKey] ?? []).map((p) => [p.date, p.value])),
                pHi: new Map((m.bands[hiKey] ?? []).map((p) => [p.date, p.value])),
            });
        }
    }

    const rows: MergedDay[] = allDates.map((date, i) => {
        const row: MergedDay = {
            date,
            dayNum: i + 1,
            actual:
                view === "cumulative"
                    ? (cumulativeByDate.get(date) ?? null)
                    : (actualByDate.get(date) ?? null),
        };

        for (const m of data.methods) {
            if (!visibleMethodIds.has(m.id)) continue;
            row[m.id] = methodMaps.get(m.id)?.get(date) ?? null;

            if (view === "cumulative") {
                const bands = bandsCumByMethod.get(m.id);
                if (bands) {
                    row[`${m.id}__pLo`] = bands.pLo.get(date) ?? null;
                    row[`${m.id}__pHi`] = bands.pHi.get(date) ?? null;
                }
            } else {
                const bands = bandsDailyByMethod.get(m.id);
                if (bands) {
                    row[`${m.id}__pLo`] = bands.pLo.get(date) ?? null;
                    row[`${m.id}__pHi`] = bands.pHi.get(date) ?? null;
                }
            }
        }

        return row;
    });

    const series: LineSeries<MergedDay>[] = [
        {
            key: "actual",
            label: actualLabel,
            accessor: (d) => d.actual as number | null,
            color: ACTUAL_COLOR,
            strokeWidth: 2.5,
            connectNulls: false,
        },
    ];

    for (const m of data.methods) {
        if (!visibleMethodIds.has(m.id)) continue;
        const color = METHOD_COLORS[m.id] ?? getChartColor(7);

        series.push({
            key: m.id,
            label: m.label,
            accessor: (d) => (d[m.id] as number | null) ?? null,
            color,
            strokeWidth: 1.5,
            dashed: false,
            connectNulls: true,
        });

        if (m.bands) {
            const { loLabel, hiLabel } = bandBoundaryKeys(m.bands);
            series.push({
                key: `${m.id}__pLo`,
                label: `${m.label} ${loLabel}`,
                accessor: (d) => (d[`${m.id}__pLo`] as number | null) ?? null,
                color,
                strokeWidth: 1,
                dashed: true,
                connectNulls: true,
            });
            series.push({
                key: `${m.id}__pHi`,
                label: `${m.label} ${hiLabel}`,
                accessor: (d) => (d[`${m.id}__pHi`] as number | null) ?? null,
                color,
                strokeWidth: 1,
                dashed: true,
                connectNulls: true,
            });
        }
    }

    return { rows, series };
}
