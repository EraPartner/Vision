import { getChartColor } from "@/components/charts/palette";
import { parseLocalDateFromYmd } from "@/components/shared/dateUtils";
import type { LineSeries } from "@/components/charts/LineChart";
import type {
    CashflowForecastMethodsData,
    CashflowForecastRollingData,
    ForecastMethod,
} from "@/lib/api/aggregations";

export const ACTUAL_COLOR = "hsl(var(--primary))";

export const METHOD_COLORS: Record<string, string> = {
    simple_avg: getChartColor(0),
    weighted_avg: getChartColor(1),
    ewma: getChartColor(2),
    holt_winters: getChartColor(3),
    prophet_lite: getChartColor(4),
    monte_carlo_parametric: getChartColor(5),
    monte_carlo_block_bootstrap: getChartColor(6),
    ensemble_imse: getChartColor(7),
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

export interface MergedDayDate {
    date: string;
    t: Date;
    actual: number | null;
    [key: string]: number | null | string | Date;
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

function buildSeries<T extends MergedDay | MergedDayDate>(
    methods: ReadonlyArray<ForecastMethod>,
    visibleMethodIds: ReadonlySet<string>,
    actualLabel: string,
): LineSeries<T>[] {
    const series: LineSeries<T>[] = [
        {
            key: "actual",
            label: actualLabel,
            accessor: (d) => (d as MergedDay | MergedDayDate).actual as number | null,
            color: ACTUAL_COLOR,
            strokeWidth: 2.5,
            connectNulls: false,
        },
    ];

    for (const m of methods) {
        if (!visibleMethodIds.has(m.id)) continue;
        const color = METHOD_COLORS[m.id] ?? getChartColor(7);

        series.push({
            key: m.id,
            label: m.label,
            accessor: (d) => ((d as Record<string, unknown>)[m.id] as number | null) ?? null,
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
                accessor: (d) => ((d as Record<string, unknown>)[`${m.id}__pLo`] as number | null) ?? null,
                color,
                strokeWidth: 1,
                dashed: true,
                connectNulls: true,
            });
            series.push({
                key: `${m.id}__pHi`,
                label: `${m.label} ${hiLabel}`,
                accessor: (d) => ((d as Record<string, unknown>)[`${m.id}__pHi`] as number | null) ?? null,
                color,
                strokeWidth: 1,
                dashed: true,
                connectNulls: true,
            });
        }
    }

    return series;
}

function buildBandMaps(
    methods: ReadonlyArray<ForecastMethod>,
    visibleMethodIds: ReadonlySet<string>,
    view: "cumulative" | "daily",
    lastActualCum: number,
) {
    type BandPair = { pLo: Map<string, number>; pHi: Map<string, number> };
    const bandsCum = new Map<string, BandPair>();
    const bandsDaily = new Map<string, BandPair>();

    for (const m of methods) {
        if (!m.bands || !visibleMethodIds.has(m.id)) continue;
        const { loKey, hiKey } = bandBoundaryKeys(m.bands);
        const loSrc = m.bands[loKey] ?? [];
        const hiSrc = m.bands[hiKey] ?? [];

        if (view === "cumulative") {
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
            bandsCum.set(m.id, { pLo, pHi });
        } else {
            bandsDaily.set(m.id, {
                pLo: new Map(loSrc.map((p) => [p.date, p.value])),
                pHi: new Map(hiSrc.map((p) => [p.date, p.value])),
            });
        }
    }
    return { bandsCum, bandsDaily };
}

export function mergeForView(
    data: CashflowForecastMethodsData,
    view: "cumulative" | "daily",
    visibleMethodIds: ReadonlySet<string>,
    actualLabel: string,
): { rows: MergedDay[]; series: LineSeries<MergedDay>[] } {
    // Shares buildBandMaps / buildSeries with mergeForViewRolling — the only
    // genuine difference is the row shape (dayNum here vs a Date `t` there).
    const cumulativeByDate = new Map(
        data.actual.map((p) => [p.date, p.cumulative]),
    );
    const actualByDate = new Map(data.actual.map((p) => [p.date, p.net]));
    const allDates = data.actual.map((p) => p.date);

    const lastActualCum =
        data.actual.filter((p) => p.cumulative !== null).at(-1)?.cumulative ?? 0;

    const { bandsCum, bandsDaily } = buildBandMaps(
        data.methods,
        visibleMethodIds,
        view,
        lastActualCum,
    );

    const methodMaps = new Map<string, Map<string, number>>();
    for (const m of data.methods) {
        const src = view === "cumulative" ? m.cumulative : m.daily;
        methodMaps.set(m.id, new Map(src.map((p) => [p.date, p.value])));
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
            const bands = view === "cumulative" ? bandsCum.get(m.id) : bandsDaily.get(m.id);
            if (bands) {
                row[`${m.id}__pLo`] = bands.pLo.get(date) ?? null;
                row[`${m.id}__pHi`] = bands.pHi.get(date) ?? null;
            }
        }

        return row;
    });

    const series = buildSeries<MergedDay>(data.methods, visibleMethodIds, actualLabel);
    return { rows, series };
}

/**
 * `YYYY-MM-DD` validator. The forecast API is trusted, but a malformed
 * row would otherwise propagate as an `Invalid Date`, which silently
 * corrupts the chart x-axis.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function mergeForViewRolling(
    data: CashflowForecastRollingData,
    view: "cumulative" | "daily",
    visibleMethodIds: ReadonlySet<string>,
    actualLabel: string,
): { rows: MergedDayDate[]; series: LineSeries<MergedDayDate>[] } {
    const cumulativeByDate = new Map(data.actual.map((p) => [p.date, p.cumulative]));
    const actualByDate = new Map(data.actual.map((p) => [p.date, p.net]));
    const allDates = data.actual.map((p) => p.date).filter((d) => ISO_DATE_RE.test(d));

    const lastActualCum =
        data.actual.filter((p) => p.cumulative !== null).at(-1)?.cumulative ?? 0;

    const { bandsCum, bandsDaily } = buildBandMaps(
        data.methods,
        visibleMethodIds,
        view,
        lastActualCum,
    );

    const methodMaps = new Map<string, Map<string, number>>();
    for (const m of data.methods) {
        const src = view === "cumulative" ? m.cumulative : m.daily;
        methodMaps.set(m.id, new Map(src.map((p) => [p.date, p.value])));
    }

    const rows: MergedDayDate[] = allDates.map((date) => {
        const row: MergedDayDate = {
            date,
            t: parseLocalDateFromYmd(date),
            actual:
                view === "cumulative"
                    ? (cumulativeByDate.get(date) ?? null)
                    : (actualByDate.get(date) ?? null),
        };

        for (const m of data.methods) {
            if (!visibleMethodIds.has(m.id)) continue;
            row[m.id] = methodMaps.get(m.id)?.get(date) ?? null;
            const bands = view === "cumulative" ? bandsCum.get(m.id) : bandsDaily.get(m.id);
            if (bands) {
                row[`${m.id}__pLo`] = bands.pLo.get(date) ?? null;
                row[`${m.id}__pHi`] = bands.pHi.get(date) ?? null;
            }
        }

        return row;
    });

    const series = buildSeries<MergedDayDate>(data.methods, visibleMethodIds, actualLabel);
    return { rows, series };
}
