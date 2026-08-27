import { PAGE_ICONS } from "@/lib/pageIcons";
import { useMemo, lazy, Suspense } from "react";
import { Link } from "react-router";
import { useStatistics } from "@/hooks/useStatistics";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { Button } from "@/components/ui/button";
import { Import } from "lucide-react";
import { ExportDialog } from "@/features/reports/ExportDialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility } from "@/hooks/useWidgetVisibility";
import { useLanguage } from "@/contexts/LanguageContext";
import { ChartCard } from "@/features/statistics/ChartCard";
import { InsightsDigestPanel } from "@/features/statistics/InsightsDigestPanel";
import { MonthlyRhythm } from "@/features/statistics/MonthlyRhythm";
import { STATISTICS_WIDGETS } from "@/features/statistics/statisticsUtils";
import { useTabParam } from "@/hooks/useTabParam";
import { PageShell } from "@/components/shared/PageShell";

const STATISTICS_TABS = [
    "overview",
    "categories",
    "recipients",
    "yearly",
    "flow",
    "custom",
] as const;

const RecipientInsightsTab = lazy(() =>
    import("@/features/statistics/RecipientInsightsTab").then((m) => ({
        default: m.RecipientInsightsTab,
    })),
);
const MonthlyChart = lazy(() =>
    import("@/features/statistics/MonthlyChart").then((m) => ({
        default: m.MonthlyChart,
    })),
);
const NetTrendChart = lazy(() =>
    import("@/features/statistics/NetTrendChart").then((m) => ({
        default: m.NetTrendChart,
    })),
);
const YearlyComparisonChart = lazy(() =>
    import("@/features/statistics/YearlyComparisonChart").then((m) => ({
        default: m.YearlyComparisonChart,
    })),
);
const TopRecipientsChart = lazy(() =>
    import("@/features/statistics/TopRecipientsChart").then((m) => ({
        default: m.TopRecipientsChart,
    })),
);
const CategoryPieChart = lazy(() =>
    import("@/features/statistics/CategoryPieChart").then((m) => ({
        default: m.CategoryPieChart,
    })),
);
const CategoryTrendChart = lazy(() =>
    import("@/features/statistics/CategoryTrendChart").then((m) => ({
        default: m.CategoryTrendChart,
    })),
);
const CategoryPivotTable = lazy(() =>
    import("@/features/statistics/CategoryPivotTable").then((m) => ({
        default: m.CategoryPivotTable,
    })),
);
const YearlySummaryTable = lazy(() =>
    import("@/features/statistics/YearlySummaryTable").then((m) => ({
        default: m.YearlySummaryTable,
    })),
);
const SavedChartsSection = lazy(() =>
    import("@/features/statistics/SavedChartsSection").then((m) => ({
        default: m.SavedChartsSection,
    })),
);
const SankeyTab = lazy(() =>
    import("@/features/statistics/SankeyTab").then((m) => ({
        default: m.SankeyTab,
    })),
);

const ChartSkeleton = () => {
    const loadingSurfaceProps = useLoadingSurfaceProps();
    return <Skeleton {...loadingSurfaceProps} className="h-[400px] w-full" />;
};

export default function StatisticsPage() {
    const {
        data,
        isLoading,
        isError,
        error,
        getGraphData,
        graphExclusions,
        toggleGraphExclusion,
        exclusionsApply,
    } = useStatistics();
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const [activeTab, setActiveTab] = useTabParam(STATISTICS_TABS, "overview");
    const {
        isVisible,
        setWidgetVisible,
        setAllVisible,
        resetToDefaults,
        widgets: widgetDefs,
    } = useWidgetVisibility("statistics", STATISTICS_WIDGETS);

    const widgets = useMemo(
        () =>
            widgetDefs.map((w) => ({
                ...w,
                label: (w as typeof w & { labelKey?: string }).labelKey
                    ? t((w as typeof w & { labelKey?: string }).labelKey!)
                    : (w.label ?? w.id),
            })),
        [widgetDefs, t],
    );

    const chartCardProps = useMemo(
        () => ({
            getGraphData,
            graphExclusions,
            toggleGraphExclusion,
            exclusionsApply,
        }),
        [getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply],
    );

    if (isLoading) {
        return (
            <PageShell {...loadingSurfaceProps} className="">
                <PageHeader title={t("statsPage.title")} icon={PAGE_ICONS["/statistics"]} />
                {/* Mirrors MonthlyRhythm's anatomy (headline column + bar strip, then a
            three-fact footer) so the page never settles into a shape it never
            promised while loading. */}
                <Card className="glass-elevated">
                    <CardContent variant="headerless" className="space-y-6">
                        <div className="grid gap-6 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] lg:gap-10">
                            <div className="space-y-3">
                                <Skeleton className="h-3 w-28" />
                                <Skeleton className="h-11 w-44" />
                                <Skeleton className="h-4 w-36" />
                            </div>
                            <Skeleton className="h-32 w-full" />
                        </div>
                        <div className="grid gap-4 sm:grid-cols-3">
                            {[...Array(3)].map((_, i) => (
                                <Skeleton key={i} className="h-14 w-full" />
                            ))}
                        </div>
                    </CardContent>
                </Card>
                <Skeleton className="h-[400px] w-full" />
            </PageShell>
        );
    }

    if (isError) {
        return (
            <PageShell className="">
                <PageHeader title={t("statsPage.title")} icon={PAGE_ICONS["/statistics"]} />
                <Card>
                    <CardContent variant="headerless">
                        <p className="text-destructive">
                            {t("statsPage.error", {
                                msg: error?.message ?? "",
                            })}
                        </p>
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    if (!data || data.monthlyData.length === 0) {
        return (
            <PageShell className="">
                <div className="flex items-center justify-between">
                    <PageHeader
                        title={t("statsPage.title")}
                        subtitle={t("statsPage.subtitle")}
                        icon={PAGE_ICONS["/statistics"]}
                    />
                    <WidgetVisibilityDialog
                        widgets={widgets}
                        isVisible={isVisible}
                        setWidgetVisible={setWidgetVisible}
                        setAllVisible={setAllVisible}
                        resetToDefaults={resetToDefaults}
                    />
                </div>
                <EmptyState
                    icon={PAGE_ICONS["/statistics"]}
                    title={t("statsPage.noDataTitle")}
                    description={t("statsPage.noDataDesc")}
                    action={
                        <Button asChild size="sm">
                            <Link to="/import">
                                <Import className="h-4 w-4 mr-2" />
                                {t("statsPage.importBtn")}
                            </Link>
                        </Button>
                    }
                />
            </PageShell>
        );
    }

    return (
        <PageShell className="" data-print-page="statistics">
            <div className="flex items-center justify-between">
                <PageHeader
                    title={t("statsPage.title")}
                    subtitle={t("statsPage.subtitle")}
                    icon={PAGE_ICONS["/statistics"]}
                />
                <div className="flex items-center gap-2" data-print-actions>
                    <ExportDialog />
                    <WidgetVisibilityDialog
                        widgets={widgets}
                        isVisible={isVisible}
                        setWidgetVisible={setWidgetVisible}
                        setAllVisible={setAllVisible}
                        resetToDefaults={resetToDefaults}
                    />
                </div>
            </div>

            {/* The monthly-trends lede opens the page — it is what the page is about.
          The insights digest follows it rather than preceding it, so the first
          thing under the H1 is this page's own story. */}
            {isVisible("summaryCards") && <MonthlyRhythm data={data} />}

            <InsightsDigestPanel />

            <Tabs
                value={activeTab}
                onValueChange={setActiveTab}
                className="space-y-4"
            >
                <TabsList>
                    <TabsTrigger value="overview">
                        {t("statsPage.tab.overview")}
                    </TabsTrigger>
                    <TabsTrigger value="categories">
                        {t("statsPage.tab.categories")}
                    </TabsTrigger>
                    <TabsTrigger value="recipients">
                        {t("statsPage.tab.recipients")}
                    </TabsTrigger>
                    <TabsTrigger value="yearly">
                        {t("statsPage.tab.yearly")}
                    </TabsTrigger>
                    <TabsTrigger value="flow">
                        {t("statsPage.tab.flow")}
                    </TabsTrigger>
                    <TabsTrigger value="custom">
                        {t("customChart.tab")}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-6">
                    <Suspense fallback={<ChartSkeleton />}>
                        {isVisible("monthly") && (
                            <ChartCard
                                title={t("statsPage.chart.monthlyTitle")}
                                description={t("statsPage.chart.monthlyDesc")}
                                graphKey="monthly"
                                {...chartCardProps}
                            >
                                {(d) => <MonthlyChart data={d} />}
                            </ChartCard>
                        )}
                        {isVisible("netTrend") && (
                            // Stacked below the monthly chart, so start off-screen on typical
                            // viewports — let the browser skip its layout+paint until scrolled
                            // near (visually free once on screen).
                            <div className="cv-auto">
                                <ChartCard
                                    title={t("statsPage.chart.netTitle")}
                                    description={t("statsPage.chart.netDesc")}
                                    graphKey="netTrend"
                                    {...chartCardProps}
                                >
                                    {(d) => <NetTrendChart data={d} />}
                                </ChartCard>
                            </div>
                        )}
                    </Suspense>
                </TabsContent>

                <TabsContent value="categories" className="space-y-6">
                    <Suspense fallback={<ChartSkeleton />}>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:[&>*:only-child]:col-span-2">
                            {isVisible("categoryPie") && (
                                <ChartCard
                                    title={t(
                                        "statsPage.chart.categoryPieTitle",
                                    )}
                                    description={t(
                                        "statsPage.chart.categoryPieDesc",
                                    )}
                                    graphKey="categoryPie"
                                    {...chartCardProps}
                                >
                                    {(d) => <CategoryPieChart data={d} />}
                                </ChartCard>
                            )}
                            {isVisible("categoryTrend") && (
                                <ChartCard
                                    title={t(
                                        "statsPage.chart.categoryTrendTitle",
                                    )}
                                    description={t(
                                        "statsPage.chart.categoryTrendDesc",
                                    )}
                                    graphKey="categoryTrend"
                                    {...chartCardProps}
                                >
                                    {(d) => <CategoryTrendChart data={d} />}
                                </ChartCard>
                            )}
                        </div>
                        {isVisible("pivotTable") && (
                            // Below the chart grid; the pivot's own sticky column lives inside
                            // its internal scroll container, so skipping the whole table's
                            // layout until scrolled near is safe (visually free).
                            <div className="cv-auto">
                                <CategoryPivotTable
                                    data={getGraphData("pivotTable") || data}
                                    graphKey="pivotTable"
                                    isFiltered={
                                        graphExclusions["pivotTable"] ?? true
                                    }
                                    onToggle={toggleGraphExclusion}
                                    exclusionsApply={exclusionsApply}
                                />
                            </div>
                        )}
                    </Suspense>
                </TabsContent>

                <TabsContent value="recipients" className="space-y-6">
                    <Suspense fallback={<ChartSkeleton />}>
                        {isVisible("topRecipients") && (
                            <RecipientInsightsTab
                                statisticsTopRecipientsChart={
                                    <ChartCard
                                        title={t(
                                            "statsPage.chart.topRecipientsTitle",
                                        )}
                                        description={t(
                                            "statsPage.chart.topRecipientsDesc",
                                        )}
                                        graphKey="topRecipients"
                                        {...chartCardProps}
                                    >
                                        {(d) => <TopRecipientsChart data={d} />}
                                    </ChartCard>
                                }
                            />
                        )}
                    </Suspense>
                </TabsContent>

                <TabsContent value="yearly" className="space-y-6">
                    <Suspense fallback={<ChartSkeleton />}>
                        {isVisible("yearlyComparison") && (
                            <ChartCard
                                title={t("statsPage.chart.yearlyTitle")}
                                description={t("statsPage.chart.yearlyDesc")}
                                graphKey="yearlyComparison"
                                {...chartCardProps}
                            >
                                {(d) => <YearlyComparisonChart data={d} />}
                            </ChartCard>
                        )}
                        {isVisible("yearlySummary") && (
                            <YearlySummaryTable data={data} />
                        )}
                    </Suspense>
                </TabsContent>

                <TabsContent value="flow" className="space-y-6">
                    <Suspense fallback={<ChartSkeleton />}>
                        <SankeyTab
                            graphExclusions={graphExclusions}
                            onToggleExclusion={toggleGraphExclusion}
                            exclusionsApply={exclusionsApply}
                            availableYears={data?.allYears}
                        />
                    </Suspense>
                </TabsContent>

                <TabsContent value="custom" className="space-y-6">
                    <Suspense fallback={<ChartSkeleton />}>
                        <SavedChartsSection data={data} />
                    </Suspense>
                </TabsContent>
            </Tabs>
        </PageShell>
    );
}
