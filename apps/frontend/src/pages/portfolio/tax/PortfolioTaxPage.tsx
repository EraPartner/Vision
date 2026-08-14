import { Landmark, Calculator } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePortfolioTaxData } from "@/hooks/usePortfolioTaxData";
import { useTaxYearParam } from "@/hooks/useTaxYearParam";
import { type InvestmentSummary } from "@/types/portfolio";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TaxProfileDialog } from "@/features/tax/TaxProfileDialog";
import { TaxYearSwitcher } from "@/features/tax/TaxYearSwitcher";
import { HistoricalYearBannerSection } from "@/features/tax/HistoricalYearBannerSection";
import { YearActionsMenu } from "@/features/tax/YearActionsMenu";
import { TaxDisclaimerBanner } from "@/features/tax/TaxDisclaimerBanner";
import { PortfolioTaxSummaryCards } from "@/features/tax/PortfolioTaxSummaryCards";
import { TaxTypesBreakdownCard } from "@/features/tax/TaxTypesBreakdownCard";
import { PortfolioProfileInputsCard } from "@/features/tax/PortfolioProfileInputsCard";
import { YearlyCostTrendCard } from "@/features/tax/YearlyCostTrendCard";
import { RecordedVsManualCard } from "@/features/tax/RecordedVsManualCard";
import { PortfolioBudgetCard } from "@/features/tax/PortfolioBudgetCard";
import { BelgianPortfolioRulesCard } from "@/features/tax/BelgianPortfolioRulesCard";
import { PortfolioTaxAdjustmentsDialog } from "@/features/portfolio/PortfolioTaxAdjustmentsDialog";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { AssetClassTaxChart } from "./AssetClassTaxChart";
import { InvestmentTaxBreakdownTable } from "./InvestmentTaxBreakdownTable";

function getPortfolioTaxWidgets(t: (key: string, vars?: Record<string, string>) => string): WidgetDefinition[] {
  return [
    { id: "summaryCards", label: t("tax.widget.summaryCards"), defaultVisible: true },
    { id: "taxByAssetClass", label: t("tax.widget.taxByAssetClass"), defaultVisible: true },
    { id: "taxTypes", label: t("tax.widget.taxTypes"), defaultVisible: true },
    { id: "yearlyTaxFeeTrend", label: t("tax.widget.yearlyTaxFeeTrend"), defaultVisible: true },
    { id: "investmentBreakdown", label: t("tax.widget.investmentBreakdown"), defaultVisible: true },
    { id: "profileInputs", label: t("tax.widget.profileInputs"), defaultVisible: true },
    { id: "belgianRules", label: t("tax.widget.belgianRules"), defaultVisible: true },
  ];
}

export default function PortfolioTaxPage() {
  const { t } = useLanguage();
  // Keeps the viewed income year in `?year=` so reload/share preserves it.
  useTaxYearParam();
  // All tax math (cost enrichment, breakdowns, TOB/TACR/Reynders/CGT/WHT
  // estimates) lives in the hook; the page only composes widgets from its output.
  const {
    profile,
    calculation,
    summaries,
    convertToTarget,
    taxTable,
    dividendExemption,
    txYear,
    viewedYear,
    totalTaxes,
    totalFees,
    totalTaxesAndFees,
    totalRecordedTaxes,
    totalRecordedFees,
    totalManualTaxes,
    totalManualFees,
    totalRealizedGain,
    totalUnrealizedGain,
    effectiveTaxRate,
    portfolioTaxesPlusPIT,
    taxBreakdown,
    feeBreakdown,
    taxByAssetClass,
    investmentBreakdown,
    yearlyCostTrend,
    totalDividendIncome,
    grossDividendWht,
    dividendWhtReclaim,
    dividendWhtNetCost,
    tobRecorded,
    tobAutoEstimate,
    tacrEstimate,
    reyndersEstimate,
    cgtEstimate,
    isEmpty,
    hasProfile,
  } = usePortfolioTaxData();
  const fmt = useCurrencyFormatter();

  const WIDGETS = getPortfolioTaxWidgets(t);
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } = useWidgetVisibility("portfolioTax", WIDGETS);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("tax.portfolioTitle")}
        subtitle={t("tax.portfolioDesc")}
        icon={Landmark}
        actions={(
          <>
            <TaxProfileDialog
              targetYear={viewedYear}
              trigger={
                <Button variant="default" size="sm" className="gap-2">
                  <Calculator className="h-4 w-4" />
                  {hasProfile ? t("tax.profile.edit") : t("tax.profile.setup")}
                </Button>
              }
            />
            <PortfolioTaxAdjustmentsDialog investments={summaries as InvestmentSummary[]} />
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
        <Badge variant="outline">{t("tax.taxes")}: {fmt(totalTaxes)}</Badge>
        <Badge variant="outline">{t("tax.fees")}: {fmt(totalFees)}</Badge>
      </div>

      <HistoricalYearBannerSection />

      {!isEmpty && (
        <TaxDisclaimerBanner
          title={t("tax.portfolioDisclaimerTitle")}
          description={t("tax.portfolioDisclaimerText")}
        />
      )}

      {isEmpty ? (
        <EmptyState icon={Landmark} title={t("tax.noData")} description={t("tax.noDataDesc")} />
      ) : (
        <>
          {isVisible("summaryCards") && (
            <PortfolioTaxSummaryCards
              totalTaxes={totalTaxes}
              totalFees={totalFees}
              totalTaxesAndFees={totalTaxesAndFees}
              effectiveTaxRate={effectiveTaxRate}
              portfolioTaxesPlusPIT={portfolioTaxesPlusPIT}
              totalManualTaxes={totalManualTaxes}
              totalManualFees={totalManualFees}
              txYear={txYear}
            />
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {isVisible("taxByAssetClass") && taxByAssetClass.length > 0 && (
              <AssetClassTaxChart data={taxByAssetClass} fmt={fmt} t={t} />
            )}

            {isVisible("taxTypes") && (taxBreakdown.length > 0 || feeBreakdown.length > 0) && (
              <TaxTypesBreakdownCard
                taxBreakdown={taxBreakdown}
                feeBreakdown={feeBreakdown}
                totalRealizedGain={totalRealizedGain}
                totalUnrealizedGain={totalUnrealizedGain}
              />
            )}

            {isVisible("profileInputs") && (
              <PortfolioProfileInputsCard profile={profile} calculation={calculation} />
            )}
          </div>

          {isVisible("yearlyTaxFeeTrend") && yearlyCostTrend.length > 0 && (
            <YearlyCostTrendCard data={yearlyCostTrend} txYear={txYear} />
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <RecordedVsManualCard
              totalRecordedTaxes={totalRecordedTaxes}
              totalRecordedFees={totalRecordedFees}
              totalManualTaxes={totalManualTaxes}
              totalManualFees={totalManualFees}
              totalTaxesAndFees={totalTaxesAndFees}
            />

            <PortfolioBudgetCard
              totalPIT={calculation.totalPIT}
              totalTaxes={totalTaxes}
              portfolioTaxesPlusPIT={portfolioTaxesPlusPIT}
            />
          </div>

          {isVisible("investmentBreakdown") && investmentBreakdown.length > 0 && (
            <InvestmentTaxBreakdownTable
              investments={investmentBreakdown}
              fmt={fmt}
              convertToTarget={convertToTarget}
              t={t}
            />
          )}

          {isVisible("belgianRules") && (
            <BelgianPortfolioRulesCard
              totalDividendIncome={totalDividendIncome}
              grossDividendWht={grossDividendWht}
              dividendWhtReclaim={dividendWhtReclaim}
              dividendWhtNetCost={dividendWhtNetCost}
              dividendExemption={dividendExemption}
              tobRecorded={tobRecorded}
              tobAutoEstimate={tobAutoEstimate}
              tacrEstimate={tacrEstimate}
              cgtEstimate={cgtEstimate}
              reyndersEstimate={reyndersEstimate}
              taxTable={taxTable}
            />
          )}
        </>
      )}
    </div>
  );
}
