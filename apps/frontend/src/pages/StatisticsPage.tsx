import { PAGE_ICONS } from "@/lib/pageIcons";
import { useCallback, useMemo, useState, lazy, Suspense } from "react";
import { Link, useSearchParams } from "react-router";
import { useStatistics, type StatisticsWindow } from "@/hooks/useStatistics";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { FileDown, Import, LayoutGrid, MoreHorizontal } from "lucide-react";
import { ExportDialog } from "@/features/reports/ExportDialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility } from "@/hooks/useWidgetVisibility";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
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

/** The date window picker: a two-segment control bound to `?window`. */
function InsightsWindowControl({
    value,
    onChange,
    label,
    rollingLabel,
    allTimeLabel,
}: {
    value: StatisticsWindow;
    onChange: (value: StatisticsWindow) => void;
    label: string;
    rollingLabel: string;
    allTimeLabel: string;
}) {
    return (
        <SegmentedControl
            value={value}
            onValueChange={(next) => onChange(next as StatisticsWindow)}
            aria-label={label}
            className="w-fit"
        >
            <SegmentedControlItem value="24m">{rollingLabel}</SegmentedControlItem>
            <SegmentedControlItem value="all">{allTimeLabel}</SegmentedControlItem>
        </SegmentedControl>
    );
}

export default function StatisticsPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const statisticsWindow: StatisticsWindow =
        searchParams.get("window") === "all" ? "all" : "24m";
    const {
        data,
        isLoading,
        isError,
        error,
        getGraphData,
        graphExclusions,
        toggleGraphExclusion,
        exclusionsApply,
    } = useStatistics(statisticsWindow);
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const [activeTab, setActiveTab] = useTabParam(STATISTICS_TABS, "overview");
    const [customizeOpen, setCustomizeOpen] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const setStatisticsWindow = useCallback(
        (value: StatisticsWindow) => {
            const next = new URLSearchParams(searchParams);
            if (value === "all") next.set("window", "all");
            else next.delete("window");
            setSearchParams(next, { replace: true });
        },
        [searchParams, setSearchParams],
    );
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

    const hasData = !!data && data.monthlyData.length > 0;

    // The same header in every state: the window picker and the ••• menu
    // (Export PDF… only once there is something to export, Customize… always).
    const headerActions = (
        <div className="flex flex-wrap items-center gap-2" data-print-actions>
            <InsightsWindowControl
                value={statisticsWindow}
                onChange={setStatisticsWindow}
                label={t("statsPage.window.label")}
                rollingLabel={t("statsPage.window.rolling24")}
                allTimeLabel={t("statsPage.window.allTime")}
            />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("statsPage.menu.label")}
                    >
                        <MoreHorizontal className="h-4 w-4" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {hasData && (
                        <DropdownMenuItem onSelect={() => setExportOpen(true)}>
                            <FileDown className="mr-2 h-4 w-4 text-label-secondary" />
                            {t("statsPage.menu.exportPdf")}
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setCustomizeOpen(true)}>
                        <LayoutGrid className="mr-2 h-4 w-4 text-label-secondary" />
                        {t("statsPage.menu.customize")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <WidgetVisibilityDialog
                open={customizeOpen}
                onOpenChange={setCustomizeOpen}
                widgets={widgets}
                isVisible={isVisible}
                setWidgetVisible={setWidgetVisible}
                setAllVisible={setAllVisible}
                resetToDefaults={resetToDefaults}
            />
            {hasData && (
                <ExportDialog
                    trigger={null}
                    open={exportOpen}
                    onOpenChange={setExportOpen}
                />
            )}
        </div>
    );

    const header = (
        <PageHeader
            title={t("statsPage.title")}
            subtitle={t("statsPage.subtitle")}
            icon={PAGE_ICONS["/statistics"]}
            actions={headerActions}
        />
    );

    if (isLoading) {
        return (
            <PageShell {...loadingSurfaceProps} className="">
                {header}
                {activeTab === "overview" && (
                    <Card>
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
                )}
                <Skeleton className="h-[400px] w-full" />
            </PageShell>
        );
    }

    if (isError) {
        return (
            <PageShell className="">
                {header}
                <Card>
                    <CardContent variant="state" className="text-center">
                        <p className="type-callout text-label-secondary">
                            {t("statsPage.error", {
                                msg: error?.message ?? "",
                            })}
                        </p>
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    if (!hasData) {
        return (
            <PageShell className="">
                {header}
                <Card>
                    <CardContent
                        variant="state"
                        className="flex flex-col items-center gap-3 text-center"
                    >
                        <h2 className="type-headline text-foreground">
                            {t("statsPage.noDataTitle")}
                        </h2>
                        <p className="max-w-sm type-callout text-label-secondary">
                            {t("statsPage.noDataDesc")}
                        </p>
                        <Button asChild>
                            <Link to="/import">
                                <Import
                                    aria-hidden="true"
                                    className="mr-2 h-4 w-4"
                                />
                                {t("statsPage.importBtn")}
                            </Link>
                        </Button>
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    return (
        <PageShell className="" data-print-page="statistics">
            {header}

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
                    {isVisible("summaryCards") && <MonthlyRhythm data={data} />}
                    <InsightsDigestPanel />

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
                                statisticsWindow={statisticsWindow}
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
