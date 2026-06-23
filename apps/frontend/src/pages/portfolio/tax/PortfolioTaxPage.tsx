import { useMemo } from "react";
import { Landmark, Receipt, TrendingDown, AlertTriangle, Info, SlidersHorizontal, Calculator } from "lucide-react";
import { BarChart, type BarSeries } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { getTaxTable } from "@/lib/belgianTax";
import {
  yearOf,
  enrichInvestmentCosts,
  computeTobRecorded,
  computeTobAutoEstimate,
  computeTacrEstimate,
  computeRealizedGainSplit,
  computeReyndersEstimate,
  computeCgtEstimate,
  computeDividendWht,
  type PortfolioTaxInvestment,
} from "@/lib/belgianTax/portfolioTax";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioTaxAdjustments } from "@/hooks/usePortfolioTaxAdjustments";
import { usePortfolioTaxClassifications } from "@/hooks/usePortfolioTaxClassifications";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { getAssetClassLabel, type InvestmentSummary } from "@/types/portfolio";
import { numberFormatToLocale } from "@/utils/currency";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TaxProfileDialog } from "@/components/tax/TaxProfileDialog";
import { TaxYearSwitcher } from "@/components/tax/TaxYearSwitcher";
import { HistoricalYearBanner } from "@/components/tax/HistoricalYearBanner";
import { YearActionsMenu } from "@/components/tax/YearActionsMenu";
import { resolveHistoricalBannerMode } from "@/components/tax/historicalBannerMode";
import { PortfolioTaxAdjustmentsDialog } from "@/components/portfolio/PortfolioTaxAdjustmentsDialog";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { TaxSummaryCard } from "./TaxSummaryCard";
import { AssetClassTaxChart } from "./AssetClassTaxChart";
import { InvestmentTaxBreakdownTable } from "./InvestmentTaxBreakdownTable";

type TxnLite = {
  type: string;
  date?: string;
  amount?: number;
  taxes?: number;
  fees?: number;
  currency?: string;
};

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
  const { appSettings } = useAppSettings();
  const {
    profile: liveProfile,
    viewedYear,
    setViewedYear,
    isViewingHistorical,
    snapshotExistsForYear,
    profileForYear,
    displayCalculationForYear,
    createSnapshotFromLive,
    isYearFiled,
    getFrozenCalculation,
    metaForYear,
  } = useBelgianTaxProfile();
  const profile = profileForYear(viewedYear);
  const calculation = displayCalculationForYear(viewedYear);
  const { summaries: rawSummaries } = usePortfolio();
  const { getAdjustment } = usePortfolioTaxAdjustments();
  const { getClassification } = usePortfolioTaxClassifications();
  // Overlay user-provided tax classifications onto each summary so downstream
  // TOB / Reynders / CGT logic sees per-investment overrides.
  const summaries = useMemo(
    () => rawSummaries.map((inv) => {
      const cls = getClassification(inv.id);
      return { ...inv, ...cls };
    }),
    [rawSummaries, getClassification],
  );
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const targetCurrency = appSettings.defaultCurrency || "EUR";
  const txYear = viewedYear;

  const { convertToTarget } = useCurrencyConverter(targetCurrency);

  const taxTable = getTaxTable(txYear);
  const dividendExemption = taxTable.dividendExemption;

  const WIDGETS = getPortfolioTaxWidgets(t);
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } = useWidgetVisibility("portfolioTax", WIDGETS);

  function fmt(val: number, currency = targetCurrency) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: appSettings.showDecimalPlaces,
      maximumFractionDigits: appSettings.showDecimalPlaces,
    }).format(val);
  }

  const enrichedInvestments = useMemo(
    () =>
      summaries.map((inv) => ({
        ...inv,
        assetClassLabel: getAssetClassLabel(t, inv.assetClass),
        ...enrichInvestmentCosts(
          inv as PortfolioTaxInvestment,
          txYear,
          convertToTarget,
          getAdjustment(txYear, inv.id),
        ),
      })),
    [summaries, txYear, getAdjustment, t, convertToTarget],
  );

  const totalTaxes = enrichedInvestments.reduce((s, i) => s + i.taxes, 0);
  const totalFees = enrichedInvestments.reduce((s, i) => s + i.fees, 0);
  const totalTaxesAndFees = totalTaxes + totalFees;
  const totalRecordedTaxes = enrichedInvestments.reduce((s, i) => s + i.recordedTaxes, 0);
  const totalRecordedFees = enrichedInvestments.reduce((s, i) => s + i.recordedFees, 0);
  const totalManualTaxes = enrichedInvestments.reduce((s, i) => s + i.manualTaxes, 0);
  const totalManualFees = enrichedInvestments.reduce((s, i) => s + i.manualFees, 0);

  const totalRealizedGain = summaries.reduce((s, i) => s + convertToTarget(i.realizedGain || 0, i.currency), 0);
  const totalUnrealizedGain = summaries.reduce((s, i) => s + convertToTarget(i.unrealizedGain || 0, i.currency), 0);
  const effectiveTaxRate = totalRealizedGain > 0 ? (totalTaxes / totalRealizedGain) * 100 : 0;
  const portfolioTaxesPlusPIT = calculation.totalPIT + totalTaxes;

  const taxBreakdown = useMemo(() => {
    const breakdown: Record<string, number> = {
      [t("tax.capitalGainsTax")]: 0,
      [t("tax.dividendWithholding")]: 0,
      [t("tax.transactionTax")]: 0,
      [t("tax.otherTaxes")]: 0,
      [t("tax.manualTaxAdjustments")]: totalManualTaxes,
    };
    summaries.forEach((inv) => {
      inv.transactions.forEach((txn: TxnLite) => {
        if (yearOf(txn.date) !== txYear) return;
        const txnTaxes = Number(txn.taxes) || 0;
        const convertedTaxes = convertToTarget(txnTaxes, txn.currency);
        if (txn.type === "sell" && convertedTaxes > 0) {
          breakdown[t("tax.capitalGainsTax")] += convertedTaxes;
        } else if (txn.type === "dividend" && convertedTaxes > 0) {
          breakdown[t("tax.dividendWithholding")] += convertedTaxes;
        } else if (txn.type === "buy" && convertedTaxes > 0) {
          breakdown[t("tax.transactionTax")] += convertedTaxes;
        } else if (txn.type === "tax") {
          breakdown[t("tax.otherTaxes")] += convertToTarget(Number(txn.amount) || 0, txn.currency);
        } else if (convertedTaxes > 0) {
          breakdown[t("tax.otherTaxes")] += convertedTaxes;
        }
      });
    });
    return Object.entries(breakdown)
      .map(([name, value]) => ({ name, value }))
      .filter((d) => d.value > 0);
  }, [summaries, t, totalManualTaxes, txYear, convertToTarget]);

  const feeBreakdown = useMemo(() => {
    const breakdown: Record<string, number> = {
      [t("tax.brokerFees")]: 0,
      [t("tax.managementFees")]: 0,
      [t("tax.otherFees")]: 0,
      [t("tax.manualFeeAdjustments")]: totalManualFees,
    };
    summaries.forEach((inv) => {
      inv.transactions.forEach((txn: TxnLite) => {
        if (yearOf(txn.date) !== txYear) return;
        const txnFees = Number(txn.fees) || 0;
        const convertedFees = convertToTarget(txnFees, txn.currency);
        if (["buy", "sell"].includes(txn.type) && convertedFees > 0) {
          breakdown[t("tax.brokerFees")] += convertedFees;
        } else if (txn.type === "fee") {
          breakdown[t("tax.managementFees")] += convertToTarget(Number(txn.amount) || 0, txn.currency);
        } else if (convertedFees > 0) {
          breakdown[t("tax.otherFees")] += convertedFees;
        }
      });
    });
    return Object.entries(breakdown)
      .map(([name, value]) => ({ name, value }))
      .filter((d) => d.value > 0);
  }, [summaries, t, totalManualFees, txYear, convertToTarget]);

  const taxByAssetClass = useMemo(() => {
    const map: Record<string, { taxes: number; fees: number }> = {};
    enrichedInvestments.forEach((inv) => {
      const label = inv.assetClassLabel || inv.assetClass;
      if (!map[label]) map[label] = { taxes: 0, fees: 0 };
      map[label].taxes += inv.taxes;
      map[label].fees += inv.fees;
    });
    return Object.entries(map)
      .map(([name, { taxes, fees }]) => ({ name, taxes, fees, total: taxes + fees }))
      .filter((d) => d.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [enrichedInvestments]);

  const investmentBreakdown = useMemo(
    () =>
      enrichedInvestments
        .map((inv) => ({
          id: inv.id,
          name: inv.name,
          symbol: inv.symbol,
          assetClass: inv.assetClassLabel,
          recordedTaxes: inv.recordedTaxes,
          recordedFees: inv.recordedFees,
          manualTaxes: inv.manualTaxes,
          manualFees: inv.manualFees,
          taxes: inv.taxes,
          fees: inv.fees,
          total: inv.total,
          realizedGain: inv.realizedGain,
          currency: inv.currency,
        }))
        .filter((i) => i.total > 0)
        .sort((a, b) => b.total - a.total),
    [enrichedInvestments],
  );

  const yearlyCostTrend = useMemo(() => {
    const map: Record<string, { period: string; taxes: number; fees: number }> = {};
    summaries.forEach((inv) => {
      inv.transactions.forEach((txn: TxnLite) => {
        if (yearOf(txn.date) !== txYear || !txn.date) return;
        const month = txn.date.slice(0, 7);
        if (!map[month]) map[month] = { period: month, taxes: 0, fees: 0 };
        if (txn.type === "tax") map[month].taxes += convertToTarget(Number(txn.amount) || 0, txn.currency);
        map[month].taxes += convertToTarget(Number(txn.taxes) || 0, txn.currency);
        if (txn.type === "fee") map[month].fees += convertToTarget(Number(txn.amount) || 0, txn.currency);
        map[month].fees += convertToTarget(Number(txn.fees) || 0, txn.currency);
      });
    });
    return Object.values(map).sort((a, b) => a.period.localeCompare(b.period));
  }, [summaries, txYear, convertToTarget]);

  const {
    totalDividendIncome,
    grossDividendWht,
    dividendWhtReclaim,
    dividendWhtNetCost,
  } = useMemo(
    () => computeDividendWht(summaries as PortfolioTaxInvestment[], txYear, taxTable, convertToTarget, profile.filingStatus),
    [summaries, txYear, taxTable, convertToTarget, profile.filingStatus],
  );

  const tobRecorded = useMemo(
    () => computeTobRecorded(summaries as PortfolioTaxInvestment[], txYear, convertToTarget),
    [summaries, txYear, convertToTarget],
  );

  // Auto-TOB: estimated stock-exchange tax on `buy` transactions, capped per leg. ETFs
  // default to the accumulating-fund rate because retail BE ETFs are predominantly
  // accumulating; users can override per-investment via `etfStructure`. See portfolioTax.ts.
  const tobAutoEstimate = useMemo(
    () => computeTobAutoEstimate(summaries as PortfolioTaxInvestment[], txYear, taxTable, convertToTarget),
    [summaries, txYear, taxTable, convertToTarget],
  );

  // Securities account tax (TACR) — flat rate on accounts averaging ≥ threshold. We don't
  // track per-account averages, so the aggregate current value is a conservative proxy.
  const tacrEstimate = useMemo(
    () => computeTacrEstimate(summaries as PortfolioTaxInvestment[], taxTable, convertToTarget),
    [summaries, taxTable, convertToTarget],
  );

  // Realized gains routed across three pools:
  //  - `reyndersInterest`: bond-fund interest portion → 30% Reynders.
  //  - `cgtGains`: equity / mixed-equity gains + Reynders non-interest remainder (from IY 2026)
  //    + direct bonds (from IY 2026 onwards) → 10% CGT.
  //  - Pre-2026 direct bonds (assetClass='bond' AND subjectToReynders=false) stay exempt under
  //    normal-management private estate.
  // Reynders resolution order:
  //   1. Explicit `subjectToReynders` override on the investment, when set.
  //   2. Fallback heuristic: `assetClass === 'bond'` → Reynders (treats the bond asset
  //      class as a bond-fund proxy, since retail "bond" holdings are typically funds).
  // Reynders interest portion: per-investment `reyndersInterestPortion` in [0, 1], default 1.0.
  // Realized gains routed across the Reynders-interest pool (30%) and the CGT pool (10%,
  // from IY 2026). Full resolution rules (overrides, interest portion, pre/post-2026 bond
  // treatment) live in portfolioTax.ts and are covered by golden tests.
  const cgtActive = taxTable.capitalGainsTaxRate > 0;
  const realizedGainSplit = useMemo(
    () => computeRealizedGainSplit(summaries as PortfolioTaxInvestment[], convertToTarget, cgtActive),
    [summaries, convertToTarget, cgtActive],
  );

  const reyndersEstimate = useMemo(
    () => computeReyndersEstimate(realizedGainSplit, taxTable),
    [realizedGainSplit, taxTable],
  );

  const cgtEstimate = useMemo(
    () => computeCgtEstimate(realizedGainSplit, taxTable, profile.filingStatus, cgtActive),
    [realizedGainSplit, taxTable, profile.filingStatus, cgtActive],
  );

  const isEmpty = summaries.length === 0;
  const hasProfile = liveProfile.profileConfigured || liveProfile.grossAnnualIncome > 0;

  const cards = [
    {
      title: t("tax.totalTaxesPaid"),
      value: fmt(totalTaxes),
      icon: Landmark,
      desc: t("tax.acrossAllInvestmentsYear", { year: String(txYear) }),
      cls: "text-destructive",
    },
    {
      title: t("tax.totalFeesPaid"),
      value: fmt(totalFees),
      icon: Receipt,
      desc: t("tax.brokerAndMgmtFeesYear", { year: String(txYear) }),
      cls: "text-destructive",
    },
    {
      title: t("tax.totalCosts"),
      value: fmt(totalTaxesAndFees),
      icon: TrendingDown,
      desc: t("tax.combinedTaxesAndFeesYear", { year: String(txYear) }),
      cls: "text-destructive",
    },
    {
      title: t("tax.effectiveTaxRate"),
      value: `${effectiveTaxRate.toFixed(1)}%`,
      icon: AlertTriangle,
      desc: t("tax.onRealizedGains"),
      cls: effectiveTaxRate > 25 ? "text-destructive" : "text-muted-foreground",
    },
    {
      title: t("tax.totalWithPIT"),
      value: fmt(portfolioTaxesPlusPIT),
      icon: Landmark,
      desc: t("tax.totalWithPITDesc"),
      cls: "text-primary",
    },
    {
      title: t("tax.manualAdjustments"),
      value: fmt(totalManualTaxes + totalManualFees),
      icon: SlidersHorizontal,
      desc: t("tax.manualAdjustmentsDescShort"),
      cls: "text-muted-foreground",
    },
  ];

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

      {isViewingHistorical && (() => {
        const banner = resolveHistoricalBannerMode({
          isFiled: isYearFiled(viewedYear),
          hasFrozenCalculation: getFrozenCalculation(viewedYear) != null,
          hasSnapshot: snapshotExistsForYear(viewedYear),
          filingReference: metaForYear(viewedYear)?.filing?.reference,
        });
        return (
          <HistoricalYearBanner
            mode={banner.mode}
            viewedYear={viewedYear}
            currentYear={liveProfile.taxYear}
            onReturnToCurrent={() => setViewedYear(liveProfile.taxYear)}
            onCreateSnapshot={
              banner.mode === 'estimate'
                ? () => createSnapshotFromLive(viewedYear)
                : undefined
            }
            filingReference={banner.filingReference}
          />
        );
      })()}

      {!isEmpty && (
        <Card className="!border-primary/50 bg-primary/5">
          <CardContent className="flex items-start gap-3 py-4">
            <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-foreground">{t("tax.portfolioDisclaimerTitle")}</p>
              <p className="text-xs text-muted-foreground mt-1">{t("tax.portfolioDisclaimerText")}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {isEmpty ? (
        <EmptyState icon={Landmark} title={t("tax.noData")} description={t("tax.noDataDesc")} />
      ) : (
        <>
          {isVisible("summaryCards") && <TaxSummaryCard cards={cards} />}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {isVisible("taxByAssetClass") && taxByAssetClass.length > 0 && (
              <AssetClassTaxChart data={taxByAssetClass} fmt={fmt} t={t} />
            )}

            {isVisible("taxTypes") && (taxBreakdown.length > 0 || feeBreakdown.length > 0) && (
              <Card className="glass-regular">
                <CardHeader>
                  <CardTitle>{t("tax.widget.taxTypes")}</CardTitle>
                  <CardDescription>{t("tax.taxTypesDesc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {taxBreakdown.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold text-foreground mb-2">{t("tax.taxes")}</h4>
                      <div className="space-y-2">
                        {taxBreakdown.map(({ name, value }) => (
                          <div key={name} className="flex justify-between items-center py-1.5 border-b border-border/50 last:border-0">
                            <span className="text-sm text-muted-foreground">{name}</span>
                            <span className="text-sm font-semibold tabular-nums text-destructive">{fmt(value)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {feeBreakdown.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold text-foreground mb-2">{t("tax.fees")}</h4>
                      <div className="space-y-2">
                        {feeBreakdown.map(({ name, value }) => (
                          <div key={name} className="flex justify-between items-center py-1.5 border-b border-border/50 last:border-0">
                            <span className="text-sm text-muted-foreground">{name}</span>
                            <span className="text-sm font-semibold tabular-nums text-destructive">{fmt(value)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="pt-2 border-t border-border">
                    <h4 className="text-sm font-semibold text-foreground mb-2">{t("tax.gainsContext")}</h4>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center py-1.5">
                        <span className="text-sm text-muted-foreground">{t("portfolio.realizedGains")}</span>
                        <span className={cn("text-sm font-semibold tabular-nums", totalRealizedGain >= 0 ? "text-accent" : "text-destructive")}>
                          {totalRealizedGain >= 0 ? "+" : ""}{fmt(totalRealizedGain)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center py-1.5">
                        <span className="text-sm text-muted-foreground">{t("portfolio.unrealizedGains")}</span>
                        <span className={cn("text-sm font-semibold tabular-nums", totalUnrealizedGain >= 0 ? "text-accent" : "text-destructive")}>
                          {totalUnrealizedGain >= 0 ? "+" : ""}{fmt(totalUnrealizedGain)}
                        </span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {isVisible("profileInputs") && (
              <Card className="glass-regular">
                <CardHeader>
                  <CardTitle>{t("tax.profile.currentInputs")}</CardTitle>
                  <CardDescription>{t("tax.portfolioProfileInputsDesc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("tax.profile.field.employmentType")}</span>
                    <Badge variant="secondary">{profile.employmentType.replaceAll("_", " ")}</Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("tax.profile.field.grossAnnualIncome")}</span>
                    <span className="font-semibold tabular-nums">{fmt(profile.grossAnnualIncome)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("tax.profile.field.otherTaxableIncome")}</span>
                    <span className="font-semibold tabular-nums">{fmt(profile.otherTaxableIncome)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("tax.profile.field.personalExemption")}</span>
                    <span className="font-semibold tabular-nums">{fmt(calculation.personalExemptionAmount)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("tax.profile.field.dependents")}</span>
                    <span className="font-semibold">
                      {profile.dependentChildren} {t("tax.profile.field.children")} / {profile.dependentOtherPersons} {t("tax.profile.field.others")}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t("tax.profile.field.disabilityExemptions")}</span>
                    <span className="font-semibold">{profile.isDisabled || profile.isSpouseDisabled ? t("common.applied") : t("common.none")}</span>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {isVisible("yearlyTaxFeeTrend") && yearlyCostTrend.length > 0 && (
            <Card className="glass-regular">
              <CardHeader>
                <CardTitle>{t("tax.yearlyTaxFeeTrendTitle", { year: String(txYear) })}</CardTitle>
                <CardDescription>{t("tax.yearlyTaxFeeTrendDesc")}</CardDescription>
              </CardHeader>
              <CardContent>
                <BarChart
                  data={yearlyCostTrend}
                  categoryAccessor={(d) => d.period}
                  series={[
                    { key: "taxes", label: t("tax.taxes"), accessor: (d) => d.taxes, color: "hsl(var(--chart-5))" },
                    { key: "fees", label: t("tax.fees"), accessor: (d) => d.fees, color: "hsl(var(--chart-4))" },
                  ] as BarSeries<{ period: string; taxes: number; fees: number }>[]}
                  height={280}
                  valueTickFormat={(v) => fmt(v)}
                  tooltipValueFormat={(v) => fmt(v)}
                />
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="glass-regular">
              <CardHeader>
                <CardTitle>{t("tax.recordedVsManual")}</CardTitle>
                <CardDescription>{t("tax.recordedVsManualDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t("tax.recordedTaxes")}</span>
                  <span className="font-semibold tabular-nums text-destructive">{fmt(totalRecordedTaxes)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t("tax.recordedFees")}</span>
                  <span className="font-semibold tabular-nums text-destructive">{fmt(totalRecordedFees)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t("tax.manualTaxAdjustments")}</span>
                  <span className="font-semibold tabular-nums text-muted-foreground">{fmt(totalManualTaxes)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t("tax.manualFeeAdjustments")}</span>
                  <span className="font-semibold tabular-nums text-muted-foreground">{fmt(totalManualFees)}</span>
                </div>
                <div className="flex justify-between text-sm pt-2 border-t border-border">
                  <span className="text-muted-foreground">{t("tax.totalCosts")}</span>
                  <span className="font-bold tabular-nums text-primary">{fmt(totalTaxesAndFees)}</span>
                </div>
              </CardContent>
            </Card>

            <Card className="glass-regular">
              <CardHeader>
                <CardTitle>{t("tax.budgetTitle")}</CardTitle>
                <CardDescription>{t("tax.portfolioBudgetLikeDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t("tax.card.totalPIT")}</span>
                  <span className="font-semibold tabular-nums text-destructive">{fmt(calculation.totalPIT)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t("tax.totalTaxesPaid")}</span>
                  <span className="font-semibold tabular-nums text-destructive">{fmt(totalTaxes)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t("tax.totalWithPIT")}</span>
                  <span className="font-bold tabular-nums text-primary">{fmt(portfolioTaxesPlusPIT)}</span>
                </div>
              </CardContent>
            </Card>
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
            <Card className="glass-regular">
              <CardHeader>
                <CardTitle>{t("tax.widget.belgianRules")}</CardTitle>
                <CardDescription>{t("tax.belgianRulesDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground mb-1">{t("tax.dividendIncomeTracked")}</p>
                    <p className="text-lg font-bold tabular-nums">{fmt(totalDividendIncome)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t("tax.fromDividendTransactions")}</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground mb-1">{t("tax.dividendWhtPaid")}</p>
                    <p className="text-lg font-bold tabular-nums text-destructive">{fmt(grossDividendWht)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t("tax.witheldAtSource")}</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground mb-1">{t("tax.dividendWhtReclaim")}</p>
                    <p className="text-lg font-bold tabular-nums text-accent">{fmt(dividendWhtReclaim)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t("tax.firstExemptBelgianDividends")} ({fmt(dividendExemption)})</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground mb-1">{t("tax.dividendWhtNetCost")}</p>
                    <p className="text-lg font-bold tabular-nums text-destructive">{fmt(dividendWhtNetCost)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t("tax.afterReclaim")}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground">{t("tax.tobRecorded")}</p>
                      <Badge variant="outline">{t("tax.transactionTax")}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{t("tax.tobTrackedFromBuyTaxes")}</p>
                    <p className="text-base font-bold tabular-nums mt-2 text-destructive">{fmt(tobRecorded)}</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground">{t("tax.tobAutoEstimate")}</p>
                      <Badge variant="outline">{t("tax.estimated")}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{t("tax.tobAutoEstimateDesc")}</p>
                    <p className="text-base font-bold tabular-nums mt-2 text-destructive">{fmt(tobAutoEstimate)}</p>
                  </div>
                </div>

                {tacrEstimate > 0 && (
                  <div className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground">{t("tax.tacrEstimate")}</p>
                      <Badge variant="outline">{`${(taxTable.securitiesAccountTaxRate * 100).toFixed(2)}%`}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{t("tax.tacrEstimateDesc")}</p>
                    <p className="text-base font-bold tabular-nums mt-2 text-destructive">{fmt(tacrEstimate)}</p>
                  </div>
                )}

                {cgtEstimate > 0 && (
                  <div className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground">{t("tax.cgtEstimate")}</p>
                      <Badge variant="outline">{`${(taxTable.capitalGainsTaxRate * 100).toFixed(0)}%`}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{t("tax.cgtEstimateDesc")}</p>
                    <p className="text-base font-bold tabular-nums mt-2 text-destructive">{fmt(cgtEstimate)}</p>
                  </div>
                )}

                {reyndersEstimate > 0 && (
                  <div className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground">{t("tax.reyndersEstimate")}</p>
                      <Badge variant="outline">{`${(taxTable.reyndersTaxRate * 100).toFixed(0)}%`}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{t("tax.reyndersEstimateDesc")}</p>
                    <p className="text-base font-bold tabular-nums mt-2 text-destructive">{fmt(reyndersEstimate)}</p>
                  </div>
                )}

                <div className="space-y-2 text-xs text-muted-foreground">
                  <p>
                    <span className="font-semibold text-foreground">{t("tax.currentlyAutomaticLabel")}</span>{" "}
                    {t("tax.currentlyAutomaticPortfolio")}
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">{t("tax.manualAdjustmentsLabel")}</span>{" "}
                    {t("tax.manualAdjustmentsDesc")}
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">{t("tax.notAutomaticLabel")}</span>{" "}
                    {t("tax.notAutomaticPortfolio")}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
