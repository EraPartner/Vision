import { useMemo } from "react";
import { CardSheen } from "@/components/shared/CardSheen";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DonutChart, ChartLegend } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { getCategoryChartColor } from "@/utils/categoryColors";

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

    // Color by category identity, not list position — matches the statistics
    // donut, the Sankey, and the transaction chips (utils/categoryColors).
    const coloredData = useMemo(
        () => data.map((d) => ({ ...d, color: getCategoryChartColor(d.name) })),
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
            <Card className="relative overflow-hidden glass-regular premium-frame">
                <CardSheen />
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
        <Card className="relative overflow-hidden glass-regular premium-frame">
            <CardSheen />
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
