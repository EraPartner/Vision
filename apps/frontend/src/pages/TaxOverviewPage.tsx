import { useState } from "react";
import { FileDown, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useTaxOverviewData } from "@/hooks/useTaxOverviewData";
import { useTaxYearParam } from "@/hooks/useTaxYearParam";
import { TaxFilingMasthead } from "@/features/tax/TaxFilingMasthead";
import { MultiYearTrendStrip } from "@/features/tax/MultiYearTrendStrip";
import { YearComparisonCard } from "@/features/tax/YearComparisonCard";
import { TaxDisclaimerBanner } from "@/features/tax/TaxDisclaimerBanner";
import { TaxComputationFlow } from "@/features/tax/TaxComputationFlow";
import { PitBreakdownCard } from "@/features/tax/PitBreakdownCard";
import { TaxRulesCard } from "@/features/tax/TaxRulesCard";
import { MonthlyIncomeTaxCard } from "@/features/tax/MonthlyIncomeTaxCard";
import { TaxCurrentInputsCard } from "@/features/tax/TaxCurrentInputsCard";
import { YearlyTaxChartCard } from "@/features/tax/YearlyTaxChartCard";
import { TaxAutomationCard } from "@/features/tax/TaxAutomationCard";
import { TaxNoProfileCard } from "@/features/tax/TaxNoProfileCard";
import { TaxYearSwitcher } from "@/features/tax/TaxYearSwitcher";
import { YearActionsMenu } from "@/features/tax/YearActionsMenu";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaxProfileDialog } from "@/features/tax/TaxProfileDialog";
import SuggestedDeductionsCard from "@/features/tax/SuggestedDeductionsCard";
import DeductionCandidatesCard from "@/features/tax/DeductionCandidatesCard";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import {
    useWidgetVisibility,
    type WidgetDefinition,
} from "@/hooks/useWidgetVisibility";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { ExportDialog } from "@/features/reports/ExportDialog";
import { PageShell } from "@/components/shared/PageShell";

function getBudgetTaxWidgets(t: (key: string) => string): WidgetDefinition[] {
    return [
        {
            id: "summaryCards",
            label: t("tax.widget.summaryCards"),
            defaultVisible: true,
        },
        {
            id: "trendStrip",
            label: t("tax.widget.trendStrip"),
            defaultVisible: true,
        },
        {
            id: "yearComparison",
            label: t("tax.widget.yearComparison"),
            defaultVisible: true,
        },
        {
            id: "incomeBreakdown",
            label: t("tax.widget.incomeBreakdown"),
            defaultVisible: true,
        },
        {
            id: "pitBreakdown",
            label: t("tax.widget.pitBreakdown"),
            defaultVisible: true,
        },
        {
            id: "taxRules",
            label: t("tax.widget.belgianRulesTitle"),
            defaultVisible: true,
        },
        {
            id: "yearlyOverview",
            label: t("tax.widget.yearlyOverview"),
            defaultVisible: true,
        },
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
    const {
        isVisible,
        setWidgetVisible,
        setAllVisible,
        resetToDefaults,
        widgets: widgetDefs,
    } = useWidgetVisibility("budgetTax", WIDGETS);
    const [exportOpen, setExportOpen] = useState(false);
    const [customizeOpen, setCustomizeOpen] = useState(false);

    const header = (
        <PageHeader
            title={t("tax.page.title")}
            subtitle={t("tax.page.subtitle", { year: viewedYear })}
            icon={PAGE_ICONS["/tax"]}
            actions={
                <div
                    className="flex flex-wrap items-center gap-2"
                    data-print-actions
                >
                    <TaxYearSwitcher />
                    <YearActionsMenu
                        year={viewedYear}
                        pageItems={
                            <>
                                <DropdownMenuItem
                                    onSelect={() => setExportOpen(true)}
                                >
                                    <FileDown className="mr-2 h-4 w-4 text-label-secondary" />
                                    {t("tax.menu.exportPdf")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={() => setCustomizeOpen(true)}
                                >
                                    <LayoutGrid className="mr-2 h-4 w-4 text-label-secondary" />
                                    {t("tax.menu.customize")}
                                </DropdownMenuItem>
                            </>
                        }
                    />
                    <TaxProfileDialog
                        targetYear={viewedYear}
                        trigger={
                            <Button>
                                <SlidersHorizontal />
                                {hasProfile
                                    ? t("tax.profile.edit")
                                    : t("tax.profile.setup")}
                            </Button>
                        }
                    />
                    <ExportDialog
                        defaultType="tax"
                        trigger={null}
                        open={exportOpen}
                        onOpenChange={setExportOpen}
                    />
                    <WidgetVisibilityDialog
                        open={customizeOpen}
                        onOpenChange={setCustomizeOpen}
                        widgets={widgetDefs}
                        isVisible={isVisible}
                        setWidgetVisible={setWidgetVisible}
                        setAllVisible={setAllVisible}
                        resetToDefaults={resetToDefaults}
                    />
                </div>
            }
        />
    );

    // Same full-page error pattern as StatisticsPage. This must replace the whole
    // stats-dependent tree, not render as an extra banner: the widget cards below
    // and the year switcher (via useAvailableTaxYears) also subscribe to
    // useStatistics, and mounting them on an errored query triggers react-query's
    // retryOnMount refetch, flipping isError back to false — an infinite
    // empty-state/content flap plus a refetch storm.
    if (stats.isError) {
        return (
            <PageShell className="" data-print-page="tax">
                <PageHeader
                    title={t("tax.page.title")}
                    subtitle={t("tax.page.subtitle", { year: viewedYear })}
                    icon={PAGE_ICONS["/tax"]}
                />
                <PageError
                    message={t("tax.page.loadError", {
                        msg: stats.error?.message ?? "",
                    })}
                />
            </PageShell>
        );
    }

    return (
        <TooltipProvider>
            <PageShell className="" data-print-page="tax">
                {header}
                {/* The year is a document, not a filter: its identity, state, region,
                    rates and historical-year notice read as one hero. */}
                <TaxFilingMasthead
                    profile={profile}
                    calculation={calculation}
                />

                {isVisible("trendStrip") && <MultiYearTrendStrip />}

                <TaxDisclaimerBanner
                    title={t("tax.belgianRulesDesc")}
                    description={`${t("tax.disclaimerTitle")}: ${t("tax.disclaimerText")}`}
                />

                {isProfileLoading ? (
                    <SectionLoader />
                ) : isEmpty ? (
                    <TaxNoProfileCard />
                ) : (
                    <>
                        {isVisible("summaryCards") && (
                            <TaxComputationFlow
                                calculation={calculation}
                                portfolioTaxesForYear={portfolioTaxesForYear}
                                totalTaxIncludingPortfolio={
                                    totalTaxIncludingPortfolio
                                }
                                totalTaxIncludingPropertyEstimate={
                                    totalTaxIncludingPropertyEstimate
                                }
                                viewedYear={viewedYear}
                            />
                        )}

                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:[&>*:only-child]:col-span-2">
                            {isVisible("pitBreakdown") && (
                                <PitBreakdownCard
                                    calculation={calculation}
                                    portfolioTaxesForYear={
                                        portfolioTaxesForYear
                                    }
                                    totalTaxIncludingPortfolio={
                                        totalTaxIncludingPortfolio
                                    }
                                    totalTaxIncludingPropertyEstimate={
                                        totalTaxIncludingPropertyEstimate
                                    }
                                    viewedYear={viewedYear}
                                />
                            )}

                            {isVisible("taxRules") && <TaxRulesCard />}
                        </div>

                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                            {isVisible("incomeBreakdown") && (
                                <MonthlyIncomeTaxCard
                                    data={monthlyIncomeTax}
                                    isLoading={stats.isLoading}
                                    hasIncomeSources={hasIncomeSources}
                                    viewedYear={viewedYear}
                                />
                            )}

                            <TaxCurrentInputsCard
                                profile={profile}
                                calculation={calculation}
                            />
                            <SuggestedDeductionsCard />
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
            </PageShell>
        </TooltipProvider>
    );
}
