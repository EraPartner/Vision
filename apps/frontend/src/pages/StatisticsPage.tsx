import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useStatistics } from "@/hooks/useStatistics";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BarChart3, Import } from "lucide-react";
import { ExportDialog } from "@/components/reports/ExportDialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility } from "@/hooks/useWidgetVisibility";
import { useLanguage } from "@/contexts/LanguageContext";
import { RecipientInsightsTab } from "@/components/statistics/RecipientInsightsTab";
import { ChartCard } from "@/components/statistics/ChartCard";
import { SummaryCards } from "@/components/statistics/SummaryCards";
import { MonthlyChart } from "@/components/statistics/MonthlyChart";
import { NetTrendChart } from "@/components/statistics/NetTrendChart";
import { YearlyComparisonChart } from "@/components/statistics/YearlyComparisonChart";
import { TopRecipientsChart } from "@/components/statistics/TopRecipientsChart";
import { CategoryPieChart } from "@/components/statistics/CategoryPieChart";
import { CategoryTrendChart } from "@/components/statistics/CategoryTrendChart";
import { CategoryPivotTable } from "@/components/statistics/CategoryPivotTable";
import { YearlySummaryTable } from "@/components/statistics/YearlySummaryTable";
import { SavedChartsSection } from "@/components/statistics/SavedChartsSection";
import { SankeyTab } from "@/components/statistics/SankeyTab";
import { STATISTICS_WIDGETS } from "@/components/statistics/statisticsUtils";

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

  if (isLoading) {
    return (
      <div className="space-y-6 animate-in">
        <PageHeader title={t("statsPage.title")} icon={BarChart3} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
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
        <Card>
          <CardContent className="pt-6">
            <p className="text-destructive">{t("statsPage.error", { msg: error?.message })}</p>
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
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <BarChart3 className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-2">{t("statsPage.noDataTitle")}</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">{t("statsPage.noDataDesc")}</p>
            <Button asChild size="sm">
              <Link to="/import">
                <Import className="h-4 w-4 mr-2" />
                {t("statsPage.importBtn")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const chartCardProps = { getGraphData, graphExclusions, toggleGraphExclusion, exclusionsApply };

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

      <SavedChartsSection
        data={data}
        getGraphData={getGraphData}
        graphExclusions={graphExclusions}
        toggleGraphExclusion={toggleGraphExclusion}
        exclusionsApply={exclusionsApply}
      />

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">{t("statsPage.tab.overview")}</TabsTrigger>
          <TabsTrigger value="categories">{t("statsPage.tab.categories")}</TabsTrigger>
          <TabsTrigger value="recipients">{t("statsPage.tab.recipients")}</TabsTrigger>
          <TabsTrigger value="yearly">{t("statsPage.tab.yearly")}</TabsTrigger>
          <TabsTrigger value="flow">{t("statsPage.tab.flow")}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
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
        </TabsContent>

        <TabsContent value="categories" className="space-y-6">
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
        </TabsContent>

        <TabsContent value="recipients" className="space-y-6">
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
        </TabsContent>

        <TabsContent value="yearly" className="space-y-6">
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
        </TabsContent>

        <TabsContent value="flow" className="space-y-6">
          <SankeyTab
            graphExclusions={graphExclusions}
            onToggleExclusion={toggleGraphExclusion}
            exclusionsApply={exclusionsApply}
            availableYears={data?.allYears}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
