import { memo, useMemo } from "react";
import { LineChart } from "@/components/charts";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { formatDate } from "@/components/shared/dateUtils";

import type { CashflowForecastRollingData } from "@/lib/api/aggregations";
import { mergeForViewRolling, type MergedDayDate } from "@/utils/forecastMerge";

export interface ForecastInnerRollingProps {
    readonly data: CashflowForecastRollingData;
    readonly view: "cumulative" | "daily";
    readonly visibleMethodIds: ReadonlySet<string>;
    readonly currency: string;
}

const Y_REFERENCE_LINES = [
    {
        y: 0,
        color: "hsl(var(--muted-foreground))",
        dashed: true,
    },
];

function ForecastInnerRollingImpl({
    data,
    view,
    visibleMethodIds,
    currency,
}: ForecastInnerRollingProps) {
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const { t, language } = useLanguage();
    // Month abbreviations follow the app language, not the number-format locale
    // (numberFormatToLocale maps 'eu' -> 'de-DE', which would yield German months).
    const monthLabelLocale = language === "nl" ? "nl-NL" : "en-US";
    const actualLabel = t("cashflow.actualToDate") ?? t("cashflow.actualThisMonth");

    const { rows, series } = useMemo(
        () => mergeForViewRolling(data, view, visibleMethodIds, actualLabel),
        [data, view, visibleMethodIds, actualLabel],
    );

    const yTickFormat = useMemo(
        () => (v: number) => formatCurrency(v, currency, locale),
        [currency, locale],
    );

    const xTickFormat = useMemo(
        () => (v: Date | number) => {
            const d = v instanceof Date ? v : new Date(v);
            return formatDate(d, "MMM d", monthLabelLocale);
        },
        [monthLabelLocale],
    );

    const referenceLines = useMemo(
        () => [
            ...Y_REFERENCE_LINES,
            {
                x: new Date(`${data.today}T00:00:00`),
                color: "hsl(var(--muted-foreground))",
                dashed: true,
                label: t("cashflow.today") ?? "Today",
            },
        ],
        [data.today, t],
    );

    return (
        <LineChart<MergedDayDate>
            syncId="dashboard-timeline"
            scrubbable
            data={rows}
            xAccessor={(d) => d.t}
            xIsDate
            series={series}
            height={320}
            referenceLines={referenceLines}
            yTickFormat={yTickFormat}
            xTickFormat={xTickFormat}
            tooltipTitle={(d) => d.date}
            tooltipValueFormat={yTickFormat}
        />
    );
}

export const ForecastInnerRolling = memo(ForecastInnerRollingImpl);
