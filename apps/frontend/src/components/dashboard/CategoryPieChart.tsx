import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DonutChart, ChartLegend, getChartColor } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";

interface CategoryPieChartProps {
    readonly data: Array<{ name: string; value: number }>;
    readonly embedded?: boolean;
    readonly formatValue?: (v: number) => string;
}

export function CategoryPieChart({ data, embedded = false, formatValue }: CategoryPieChartProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";

    const coloredData = useMemo(
        () => data.map((d, i) => ({ ...d, color: getChartColor(i) })),
        [data],
    );
    const tooltipFmt = useMemo(
        () => formatValue ?? ((v: number) => formatCurrency(v, defaultCurrency, locale)),
        [formatValue, defaultCurrency, locale],
    );

    const chartContent = (
        <div className="flex h-72 flex-col gap-2">
            <DonutChart
                data={coloredData}
                height={232}
                innerRadiusRatio={0.6}
                padAngle={0.025}
                tooltipValueFormat={tooltipFmt}
            />
            <ChartLegend
                items={coloredData.map((d) => ({ label: d.name, color: d.color }))}
                align="center"
            />
        </div>
    );

    if (!data || data.length === 0) {
        const emptyContent = (
            <div className="flex h-72 items-center justify-center text-muted-foreground">
                {t("categoryPie.noData")}
            </div>
        );

        if (embedded) {
            return emptyContent;
        }

        return (
            <Card className="relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16"></div>
                <CardHeader>
                    <CardTitle className="text-lg font-semibold">
                        {t("categoryPie.title")}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                        {t("categoryPie.desc")}
                    </p>
                </CardHeader>
                <CardContent>{emptyContent}</CardContent>
            </Card>
        );
    }

    if (embedded) {
        return chartContent;
    }

    return (
        <Card className="relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16"></div>
            <CardHeader>
                <CardTitle className="text-lg font-semibold">
                    {t("categoryPie.title")}
                </CardTitle>
                <p className="text-sm text-muted-foreground">{t("categoryPie.desc")}</p>
            </CardHeader>
            <CardContent>{chartContent}</CardContent>
        </Card>
    );
}
