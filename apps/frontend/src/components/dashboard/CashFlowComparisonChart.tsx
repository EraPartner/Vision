import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity } from "lucide-react";
import { LineChart, ChartLegend } from "@/components/charts";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatMonthYearWithAppSettings } from "@/components/shared/dateUtils";

interface DayData {
    readonly day: number;
    readonly average: number;
    readonly current: number | null;
}

interface CashFlowComparisonProps {
    readonly withoutPlanned: DayData[];
    readonly withPlanned: DayData[];
    readonly currentDay: number;
    readonly month: number;
    readonly year: number;
    readonly embedded?: boolean;
}

function CashFlowLineChart({ data, currentDay }: { data: DayData[]; currentDay: number }) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";

    const lastActual = data.slice(0, currentDay).at(-1);
    const avgAtCurrentDay = lastActual ? data[currentDay - 1]?.average : null;
    const diff =
        lastActual?.current !== null && lastActual?.current !== undefined && avgAtCurrentDay !== null
            ? lastActual.current - (avgAtCurrentDay ?? 0)
            : null;
    const isBetterThanAverage = diff !== null ? diff > 0 : null;

    const averageColor = "hsl(var(--muted-foreground))";
    const currentColor = "hsl(var(--primary))";

    return (
        <div>
            <ChartLegend
                items={[
                    { label: t("cashflow.24monthAvg"), color: averageColor, dashed: true },
                    { label: t("cashflow.thisMonth"), color: currentColor },
                ]}
                align="start"
                className="mb-2"
            />
            <LineChart<DayData>
                syncId="dashboard-timeline"
                scrubbable
                data={data}
                xAccessor={(d) => d.day}
                xIsDate={false}
                series={[
                    {
                        key: "average",
                        label: t("cashflow.24monthAvg"),
                        accessor: (d) => d.average,
                        color: averageColor,
                        dashed: true,
                        strokeWidth: 2,
                    },
                    {
                        key: "current",
                        label: t("cashflow.thisMonth"),
                        accessor: (d) => d.current,
                        color: currentColor,
                        strokeWidth: 2.5,
                        connectNulls: false,
                    },
                ]}
                height={300}
                referenceLines={[{ y: 0, color: "hsl(var(--muted-foreground))", dashed: true }]}
                yTickFormat={(v) => formatCurrency(v, defaultCurrency, locale)}
                xTickFormat={(v) => String(v)}
                tooltipTitle={(d) => t("cashflow.day", { n: String(d.day) })}
                tooltipValueFormat={(v) => formatCurrency(v, defaultCurrency, locale)}
            />

            {isBetterThanAverage !== null && diff !== null && lastActual && (
                <div
                    className={`mt-4 flex items-center gap-2 p-3 rounded-lg border ${
                        isBetterThanAverage
                            ? "bg-accent/10 border-accent/30"
                            : "bg-destructive/10 border-destructive/30"
                    }`}
                >
                    <div
                        className={`w-2.5 h-2.5 rounded-full ${
                            isBetterThanAverage ? "bg-accent" : "bg-destructive"
                        }`}
                    />
                    <p className="text-sm font-medium text-foreground">
                        {isBetterThanAverage
                            ? `${t("cashflow.savingMore")} `
                            : `${t("cashflow.spendingMore")} `}
                        <span className="font-bold">
                            {formatCurrency(Math.abs(diff), defaultCurrency, locale)}
                        </span>
                        {isBetterThanAverage
                            ? ` ${t("cashflow.better")}`
                            : ` ${t("cashflow.worse")}`}{" "}
                        {t("cashflow.comparedTo")} {currentDay}
                    </p>
                </div>
            )}
        </div>
    );
}

export function CashFlowComparisonChart({
    withoutPlanned,
    withPlanned,
    currentDay,
    month,
    year,
    embedded = false,
}: CashFlowComparisonProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const monthName = formatMonthYearWithAppSettings(
        new Date(year, month - 1, 1),
        appSettings.dateFormat,
        locale,
    );

    const chartContent = (
        <Tabs defaultValue="without" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-4">
                <TabsTrigger value="without">{t("cashflow.withoutPlanned")}</TabsTrigger>
                <TabsTrigger value="with">{t("cashflow.withPlanned")}</TabsTrigger>
            </TabsList>
            <TabsContent value="without">
                <CashFlowLineChart data={withoutPlanned} currentDay={currentDay} />
            </TabsContent>
            <TabsContent value="with">
                <CashFlowLineChart data={withPlanned} currentDay={currentDay} />
            </TabsContent>
        </Tabs>
    );

    if (embedded) {
        return chartContent;
    }

    return (
        <Card className="relative overflow-hidden glass-regular premium-frame micro-lift lg:col-span-2">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/10 to-transparent rounded-full -mr-16 -mt-16" />
            <CardHeader className="space-y-3">
                <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-sm text-primary">
                        <Activity className="h-6 w-6" />
                    </div>
                    <div className="flex-1">
                        <CardTitle className="text-xl">{t("cashflow.title")}</CardTitle>
                        <CardDescription className="text-base">
                            {t("cashflow.chartDesc", { monthName })}
                        </CardDescription>
                    </div>
                </div>
            </CardHeader>
            <CardContent>{chartContent}</CardContent>
        </Card>
    );
}
