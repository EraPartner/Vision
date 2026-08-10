import { useLanguage } from "@/contexts/LanguageContext";
import { useTaxOverviewData } from "@/hooks/useTaxOverviewData";
import { useTaxYearParam } from "@/hooks/useTaxYearParam";
import { TaxYearSwitcher } from "@/components/tax/TaxYearSwitcher";
import { HistoricalYearBannerSection } from "@/components/tax/HistoricalYearBannerSection";
import { YearActionsMenu } from "@/components/tax/YearActionsMenu";
import { MultiYearTrendStrip } from "@/components/tax/MultiYearTrendStrip";
import { YearComparisonCard } from "@/components/tax/YearComparisonCard";
import { TaxDisclaimerBanner } from "@/components/tax/TaxDisclaimerBanner";
import { TaxOverviewSummaryCards } from "@/components/tax/TaxOverviewSummaryCards";
import { PitBreakdownCard } from "@/components/tax/PitBreakdownCard";
import { TaxRulesCard } from "@/components/tax/TaxRulesCard";
import { MonthlyIncomeTaxCard } from "@/components/tax/MonthlyIncomeTaxCard";
import { TaxCurrentInputsCard } from "@/components/tax/TaxCurrentInputsCard";
import { YearlyTaxChartCard } from "@/components/tax/YearlyTaxChartCard";
import { TaxAutomationCard } from "@/components/tax/TaxAutomationCard";
import { TaxNoProfileCard } from "@/components/tax/TaxNoProfileCard";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Landmark, SlidersHorizontal } from "lucide-react";
import { TaxProfileDialog } from "@/components/tax/TaxProfileDialog";
import SuggestedDeductionsCard from "@/components/tax/SuggestedDeductionsCard";
import DeductionCandidatesCard from "@/components/tax/DeductionCandidatesCard";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { ExportDialog } from "@/components/reports/ExportDialog";

function getBudgetTaxWidgets(t: (key: string) => string): WidgetDefinition[] {
  return [
    { id: "summaryCards", label: t("tax.widget.summaryCards"), defaultVisible: true },
    { id: "trendStrip", label: t("tax.widget.trendStrip"), defaultVisible: true },
    { id: "yearComparison", label: t("tax.widget.yearComparison"), defaultVisible: true },
    { id: "incomeBreakdown", label: t("tax.widget.incomeBreakdown"), defaultVisible: true },
    { id: "pitBreakdown", label: t("tax.widget.pitBreakdown"), defaultVisible: true },
    { id: "taxRules", label: t("tax.widget.belgianRulesTitle"), defaultVisible: true },
    { id: "yearlyOverview", label: t("tax.widget.yearlyOverview"), defaultVisible: true },
  ];
}

export default function TaxOverviewPage() {
  const { t } = useLanguage();
  // Keeps the viewed income year in `?year=` so reload/share preserves it.
  useTaxYearParam();
  // All tax math (taxable-income aggregation, portfolio-tax accumulation, chart
  // series) lives in the hook; the page only composes widgets from its output.
  const {
    stats,
    profile,
    calculation,
    isProfileLoading,
    viewedYear,
    hasIncomeSources,
    portfolioTaxesForYear,
    totalTaxIncludingPortfolio,
    totalTaxIncludingPropertyEstimate,
    yearlyIncome,
    monthlyIncomeTax,
    hasProfile,
    isEmpty,
  } = useTaxOverviewData();
  const WIDGETS = getBudgetTaxWidgets(t);
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } =
    useWidgetVisibility("budgetTax", WIDGETS);

  // Same full-page error pattern as StatisticsPage. This must replace the whole
  // stats-dependent tree, not render as an extra banner: the widget cards below
  // also subscribe to useStatistics, and mounting them on an errored query
  // triggers react-query's retryOnMount refetch, flipping isError back to false
  // — an infinite empty-state/content flap plus a refetch storm.
  if (stats.isError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t("tax.page.title")}
          subtitle={t("tax.page.subtitle")}
          icon={Landmark}
        />
        <Card className="glass-regular">
          <CardContent className="pt-6">
            <p className="text-destructive">
              {t("statsPage.error", { msg: stats.error?.message ?? "" })}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <PageHeader
          title={t("tax.page.title")}
          subtitle={t("tax.page.subtitle")}
          icon={Landmark}
          actions={(
            <>
              <ExportDialog defaultType="tax" />
              <TaxProfileDialog
                targetYear={viewedYear}
                trigger={
                  <Button variant="default" size="sm" className="gap-2">
                    <SlidersHorizontal className="h-4 w-4" />
                    {hasProfile ? t("tax.profile.edit") : t("tax.profile.setup")}
                  </Button>
                }
              />
              <WidgetVisibilityDialog
                widgets={widgetDefs}
                isVisible={isVisible}
                setWidgetVisible={setWidgetVisible}
                setAllVisible={setAllVisible}
                resetToDefaults={resetToDefaults}
              />
            </>
          )}
        />
        <div className="flex items-center gap-2 -mt-2 text-xs text-muted-foreground flex-wrap">
          <TaxYearSwitcher />
          <YearActionsMenu year={viewedYear} />
          <Badge variant="outline">Region: {profile.region}</Badge>
          <Badge variant="outline">Marginal rate: {calculation.marginalRate.toFixed(0)}%</Badge>
          <Badge variant="outline">Effective burden: {calculation.effectiveRate.toFixed(1)}%</Badge>
        </div>

        <HistoricalYearBannerSection />

        {isVisible("trendStrip") && <MultiYearTrendStrip />}

        <TaxDisclaimerBanner
          title={t('tax.belgianRulesDesc')}
          description={`${t('tax.disclaimerTitle')}: ${t('tax.disclaimerText')}`}
        />

        {isProfileLoading ? (
          <SectionLoader />
        ) : isEmpty ? (
          <TaxNoProfileCard />
        ) : (
          <>
            {isVisible("summaryCards") && (
              <TaxOverviewSummaryCards
                calculation={calculation}
                portfolioTaxesForYear={portfolioTaxesForYear}
                totalTaxIncludingPortfolio={totalTaxIncludingPortfolio}
                totalTaxIncludingPropertyEstimate={totalTaxIncludingPropertyEstimate}
                viewedYear={viewedYear}
              />
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {isVisible("pitBreakdown") && (
                <PitBreakdownCard
                  calculation={calculation}
                  portfolioTaxesForYear={portfolioTaxesForYear}
                  totalTaxIncludingPortfolio={totalTaxIncludingPortfolio}
                  totalTaxIncludingPropertyEstimate={totalTaxIncludingPropertyEstimate}
                  viewedYear={viewedYear}
                />
              )}

              {isVisible("taxRules") && <TaxRulesCard />}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {isVisible("incomeBreakdown") && (
                <MonthlyIncomeTaxCard
                  data={monthlyIncomeTax}
                  isLoading={stats.isLoading}
                  hasIncomeSources={hasIncomeSources}
                  viewedYear={viewedYear}
                />
              )}

              <TaxCurrentInputsCard profile={profile} calculation={calculation} />
              <div>
                <SuggestedDeductionsCard />
              </div>
              <DeductionCandidatesCard />
            </div>

            {isVisible("yearComparison") && <YearComparisonCard />}

            {isVisible("yearlyOverview") && (
              <YearlyTaxChartCard
                data={yearlyIncome}
                isLoading={stats.isLoading}
                hasIncomeSources={hasIncomeSources}
                viewedYear={viewedYear}
              />
            )}
            <TaxAutomationCard />
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
