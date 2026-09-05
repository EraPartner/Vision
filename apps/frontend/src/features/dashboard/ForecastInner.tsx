import { memo, useMemo } from "react";
import { LineChart } from "@/components/charts";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import type { CashflowForecastMethodsData } from "@/lib/api/aggregations";
import { mergeForView, type MergedDay } from "@/utils/forecastMerge";

export interface ForecastInnerProps {
    readonly data: CashflowForecastMethodsData;
    readonly view: "cumulative" | "daily";
    readonly visibleMethodIds: ReadonlySet<string>;
    readonly currency: string;
}

const REFERENCE_LINES = [
    {
        y: 0,
        color: "hsl(var(--muted-foreground))",
        dashed: true,
    },
];

function ForecastInnerImpl({
    data,
    view,
    visibleMethodIds,
    currency,
}: ForecastInnerProps) {
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const { t } = useLanguage();
    const actualLabel = t("cashflow.actualThisMonth");

    const { rows, series } = useMemo(
        () => mergeForView(data, view, visibleMethodIds, actualLabel),
        [data, view, visibleMethodIds, actualLabel],
    );

    const yTickFormat = useMemo(
        () => (v: number) =>
            formatCurrency(
                v,
                currency,
                locale,
                appSettings.showDecimalPlaces ?? 2,
            ),
        [currency, locale, appSettings.showDecimalPlaces],
    );
    const tooltipValueFormat = yTickFormat;

    return (
        <LineChart<MergedDay>
            syncId="dashboard-timeline"
            scrubbable
            data={rows}
            xAccessor={(d) => d.dayNum as number}
            xIsDate={false}
            series={series}
            height={320}
            referenceLines={REFERENCE_LINES}
            yTickFormat={yTickFormat}
            xTickFormat={(v) => String(v)}
            tooltipTitle={(d) => d.date}
            tooltipValueFormat={tooltipValueFormat}
        />
    );
}

export const ForecastInner = memo(ForecastInnerImpl);
