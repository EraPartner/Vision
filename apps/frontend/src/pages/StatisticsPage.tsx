import { useMemo, lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import { useStatistics } from "@/hooks/useStatistics";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BarChart3, Import } from "lucide-react";
import { ExportDialog } from "@/components/reports/ExportDialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility } from "@/hooks/useWidgetVisibility";
import { useLanguage } from "@/contexts/LanguageContext";
import { ChartCard } from "@/components/statistics/ChartCard";
import { SummaryCards } from "@/components/statistics/SummaryCards";
import { STATISTICS_WIDGETS } from "@/components/statistics/statisticsUtils";

const RecipientInsightsTab = lazy(() =>
  import("@/components/statistics/RecipientInsightsTab").then((m) => ({ default: m.RecipientInsightsTab }))
);
const MonthlyChart = lazy(() =>
  import("@/components/statistics/MonthlyChart").then((m) => ({ default: m.MonthlyChart }))
);
const NetTrendChart = lazy(() =>
  import("@/components/statistics/NetTrendChart").then((m) => ({ default: m.NetTrendChart }))
);
const YearlyComparisonChart = lazy(() =>
  import("@/components/statistics/YearlyComparisonChart").then((m) => ({ default: m.YearlyComparisonChart }))
);
const TopRecipientsChart = lazy(() =>
  import("@/components/statistics/TopRecipientsChart").then((m) => ({ default: m.TopRecipientsChart }))
);
const CategoryPieChart = lazy(() =>
  import("@/components/statistics/CategoryPieChart").then((m) => ({ default: m.CategoryPieChart }))
);
const CategoryTrendChart = lazy(() =>
  import("@/components/statistics/CategoryTrendChart").then((m) => ({ default: m.CategoryTrendChart }))
);
const CategoryPivotTable = lazy(() =>
  import("@/components/statistics/CategoryPivotTable").then((m) => ({ default: m.CategoryPivotTable }))
);
const YearlySummaryTable = lazy(() =>
  import("@/components/statistics/YearlySummaryTable").then((m) => ({ default: m.YearlySummaryTable }))
);
const SavedChartsSection = lazy(() =>
  import("@/components/statistics/SavedChartsSection").then((m) => ({ default: m.SavedChartsSection }))
);
const SankeyTab = lazy(() =>
  import("@/components/statistics/SankeyTab").then((m) => ({ default: m.SankeyTab }))
);

const ChartSkeleton = () => <Skeleton className="h-[400px] w-full" />;

export default function StatisticsPage() {
  const {
    data, isLoading, isError, error,
    getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply,
  } = useStatistics();
  const { t } = useLanguage();
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } =
    useWidgetVisibility("statistics", STATISTICS_WIDGETS);

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
    () => ({ getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply }),
    [getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply],
  );

  if (isLoading) {
    return (
      <div className="space-y-6 animate-in">
        <PageHeader title={t("statsPage.title")} icon={BarChart3} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="glass-regular">
              <CardContent className="pt-6">
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6 animate-in">
        <PageHeader title={t("statsPage.title")} icon={BarChart3} />
        <Card className="glass-regular">
          <CardContent className="pt-6">
            <p className="text-destructive">{t("statsPage.error", { msg: error?.message ?? '' })}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data || data.monthlyData.length === 0) {
    return (
      <div className="space-y-6 animate-in">
        <div className="flex items-center justify-between">
          <PageHeader title={t("statsPage.title")} subtitle={t("statsPage.subtitle")} icon={BarChart3} />
          <WidgetVisibilityDialog
            widgets={widgets}
            isVisible={isVisible}
            setWidgetVisible={setWidgetVisible}
            setAllVisible={setAllVisible}
            resetToDefaults={resetToDefaults}
          />
        </div>
        <EmptyState
          icon={BarChart3}
          title={t("statsPage.noDataTitle")}
          description={t("statsPage.noDataDesc")}
          action={(
            <Button asChild size="sm">
              <Link to="/import">
                <Import className="h-4 w-4 mr-2" />
                {t("statsPage.importBtn")}
              </Link>
            </Button>
          )}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in">
      <div className="flex items-center justify-between">
        <PageHeader title={t("statsPage.title")} subtitle={t("statsPage.subtitle")} icon={BarChart3} />
        <div className="flex items-center gap-2">
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

      {isVisible("summaryCards") && <SummaryCards data={data} />}

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">{t("statsPage.tab.overview")}</TabsTrigger>
          <TabsTrigger value="categories">{t("statsPage.tab.categories")}</TabsTrigger>
          <TabsTrigger value="recipients">{t("statsPage.tab.recipients")}</TabsTrigger>
          <TabsTrigger value="yearly">{t("statsPage.tab.yearly")}</TabsTrigger>
          <TabsTrigger value="flow">{t("statsPage.tab.flow")}</TabsTrigger>
          <TabsTrigger value="custom">{t("customChart.tab")}</TabsTrigger>
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
              <ChartCard
                title={t("statsPage.chart.netTitle")}
                description={t("statsPage.chart.netDesc")}
                graphKey="netTrend"
                {...chartCardProps}
              >
                {(d) => <NetTrendChart data={d} />}
              </ChartCard>
            )}
          </Suspense>
        </TabsContent>

        <TabsContent value="categories" className="space-y-6">
          <Suspense fallback={<ChartSkeleton />}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {isVisible("categoryPie") && (
                <ChartCard
                  title={t("statsPage.chart.categoryPieTitle")}
                  description={t("statsPage.chart.categoryPieDesc")}
                  graphKey="categoryPie"
                  {...chartCardProps}
                >
                  {(d) => <CategoryPieChart data={d} />}
                </ChartCard>
              )}
              {isVisible("categoryTrend") && (
                <ChartCard
                  title={t("statsPage.chart.categoryTrendTitle")}
                  description={t("statsPage.chart.categoryTrendDesc")}
                  graphKey="categoryTrend"
                  {...chartCardProps}
                >
                  {(d) => <CategoryTrendChart data={d} />}
                </ChartCard>
              )}
            </div>
            {isVisible("pivotTable") && (
              <CategoryPivotTable
                data={getGraphData("pivotTable") || data}
                graphKey="pivotTable"
                isFiltered={graphExclusions["pivotTable"] ?? true}
                onToggle={toggleGraphExclusion}
                exclusionsApply={exclusionsApply}
              />
            )}
          </Suspense>
        </TabsContent>

        <TabsContent value="recipients" className="space-y-6">
          <Suspense fallback={<ChartSkeleton />}>
            {isVisible("topRecipients") && (
              <RecipientInsightsTab
                statisticsTopRecipientsChart={
                  <ChartCard
                    title={t("statsPage.chart.topRecipientsTitle")}
                    description={t("statsPage.chart.topRecipientsDesc")}
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
            {isVisible("yearlySummary") && <YearlySummaryTable data={data} />}
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
    </div>
  );
}
