import { useState } from "react";
import { Link } from "react-router";
import { LayoutGrid, SlidersHorizontal } from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { usePortfolioTaxData } from "@/hooks/usePortfolioTaxData";
import { useTaxYearParam } from "@/hooks/useTaxYearParam";
import { type InvestmentSummary } from "@/types/portfolio";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
import {
    useWidgetVisibility,
    type WidgetDefinition,
} from "@/hooks/useWidgetVisibility";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { AssetClassTaxChart } from "./AssetClassTaxChart";
import { InvestmentTaxBreakdownTable } from "./InvestmentTaxBreakdownTable";
import { PageShell } from "@/components/shared/PageShell";

function getPortfolioTaxWidgets(
    t: (key: string, vars?: Record<string, string>) => string,
): WidgetDefinition[] {
    return [
        {
            id: "summaryCards",
            label: t("tax.widget.summaryCards"),
            defaultVisible: true,
        },
        {
            id: "taxByAssetClass",
            label: t("tax.widget.taxByAssetClass"),
            defaultVisible: true,
        },
        {
            id: "taxTypes",
            label: t("tax.widget.taxTypes"),
            defaultVisible: true,
        },
        {
            id: "yearlyTaxFeeTrend",
            label: t("tax.widget.yearlyTaxFeeTrend"),
            defaultVisible: true,
        },
        {
            id: "investmentBreakdown",
            label: t("tax.widget.investmentBreakdown"),
            defaultVisible: true,
        },
        {
            id: "profileInputs",
            label: t("tax.widget.profileInputs"),
            defaultVisible: true,
        },
        {
            id: "belgianRules",
            label: t("tax.widget.belgianRules"),
            defaultVisible: true,
        },
    ];
}

interface SectionHeadingProps {
    title: string;
    description: string;
    action?: React.ReactNode;
}

/** Title and one-line help for a page section, with an optional action. */
function SectionHeading({ title, description, action }: SectionHeadingProps) {
    return (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
                <h2 className="type-title-2 text-foreground">{title}</h2>
                <p className="max-w-prose type-body text-label-secondary">
                    {description}
                </p>
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
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
        unknownDividendConventionCount,
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
    const {
        isVisible,
        setWidgetVisible,
        setAllVisible,
        resetToDefaults,
        widgets: widgetDefs,
    } = useWidgetVisibility("portfolioTax", WIDGETS);
    const [adjustmentsOpen, setAdjustmentsOpen] = useState(false);
    const [profileOpen, setProfileOpen] = useState(false);
    const [customizeOpen, setCustomizeOpen] = useState(false);

    const profileLabel = hasProfile
        ? t("tax.profile.edit")
        : t("tax.profile.setup");

    return (
        <PageShell className="">
            <PageHeader
                title={t("tax.portfolioTitle")}
                subtitle={t("tax.portfolioDesc")}
                icon={PAGE_ICONS["/portfolio/tax"]}
                actions={
                    <>
                        <TaxYearSwitcher />
                        <YearActionsMenu
                            year={viewedYear}
                            pageItems={
                                <>
                                    <DropdownMenuItem
                                        onSelect={() => setProfileOpen(true)}
                                    >
                                        <SlidersHorizontal className="mr-2 h-4 w-4 text-label-secondary" />
                                        {hasProfile
                                            ? t("tax.menu.editProfile")
                                            : t("tax.menu.setupProfile")}
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
                        <Button onClick={() => setAdjustmentsOpen(true)}>
                            <SlidersHorizontal aria-hidden="true" />
                            {t("tax.manualAdjustments")}
                        </Button>
                        <TaxProfileDialog
                            targetYear={viewedYear}
                            trigger={null}
                            open={profileOpen}
                            onOpenChange={setProfileOpen}
                        />
                        <PortfolioTaxAdjustmentsDialog
                            investments={summaries as InvestmentSummary[]}
                            open={adjustmentsOpen}
                            onOpenChange={setAdjustmentsOpen}
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
                    </>
                }
            />

            <HistoricalYearBannerSection />

            {!isEmpty && (
                <TaxDisclaimerBanner
                    title={t("tax.portfolioDisclaimerTitle")}
                    description={t("tax.portfolioDisclaimerText")}
                />
            )}

            {isEmpty ? (
                <EmptyState
                    icon={PAGE_ICONS["/portfolio/tax"]}
                    title={t("tax.noData")}
                    description={t("tax.noDataDesc")}
                    action={
                        <Button variant="outline" asChild>
                            <Link to="/portfolio">{t("tax.noDataCta")}</Link>
                        </Button>
                    }
                />
            ) : (
                <>
                    <SectionHeading
                        title={t("tax.costsSection")}
                        description={t("tax.costsHelp")}
                    />
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

                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:[&>*:only-child]:col-span-2">
                        {isVisible("taxByAssetClass") &&
                            taxByAssetClass.length > 0 && (
                                <AssetClassTaxChart
                                    data={taxByAssetClass}
                                    fmt={fmt}
                                    t={t}
                                />
                            )}

                        {isVisible("taxTypes") &&
                            (taxBreakdown.length > 0 ||
                                feeBreakdown.length > 0) && (
                                <TaxTypesBreakdownCard
                                    taxBreakdown={taxBreakdown}
                                    feeBreakdown={feeBreakdown}
                                    totalRealizedGain={totalRealizedGain}
                                    totalUnrealizedGain={totalUnrealizedGain}
                                />
                            )}

                        <RecordedVsManualCard
                            totalRecordedTaxes={totalRecordedTaxes}
                            totalRecordedFees={totalRecordedFees}
                            totalManualTaxes={totalManualTaxes}
                            totalManualFees={totalManualFees}
                            totalTaxesAndFees={totalTaxesAndFees}
                        />
                    </div>

                    {isVisible("yearlyTaxFeeTrend") &&
                        yearlyCostTrend.length > 0 && (
                            <YearlyCostTrendCard
                                data={yearlyCostTrend}
                                txYear={txYear}
                            />
                        )}

                    {isVisible("investmentBreakdown") &&
                        investmentBreakdown.length > 0 && (
                            <InvestmentTaxBreakdownTable
                                investments={investmentBreakdown}
                                convertToTarget={convertToTarget}
                                t={t}
                            />
                        )}

                    <div className="border-t border-border/50 pt-6">
                        <SectionHeading
                            title={t("tax.estimatesSection")}
                            description={t("tax.estimatesHelp")}
                            action={
                                <TaxProfileDialog
                                    targetYear={viewedYear}
                                    trigger={
                                        <Button variant="outline">
                                            <SlidersHorizontal aria-hidden="true" />
                                            {profileLabel}
                                        </Button>
                                    }
                                />
                            }
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:[&>*:only-child]:col-span-2">
                        <PortfolioBudgetCard
                            totalPIT={calculation.totalPIT}
                            totalTaxes={totalTaxes}
                            portfolioTaxesPlusPIT={portfolioTaxesPlusPIT}
                        />
                        {isVisible("profileInputs") && (
                            <PortfolioProfileInputsCard
                                profile={profile}
                                calculation={calculation}
                            />
                        )}
                    </div>
                    {isVisible("belgianRules") && (
                        <BelgianPortfolioRulesCard
                            totalDividendIncome={totalDividendIncome}
                            grossDividendWht={grossDividendWht}
                            dividendWhtReclaim={dividendWhtReclaim}
                            dividendWhtNetCost={dividendWhtNetCost}
                            unknownDividendConventionCount={
                                unknownDividendConventionCount
                            }
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
        </PageShell>
    );
}
