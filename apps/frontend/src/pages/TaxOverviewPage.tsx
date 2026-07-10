import { useMemo, useCallback } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { computeBelgianPIT } from "@/lib/belgianTax";
import { recordedTaxesForYear, type PortfolioTaxInvestment } from "@/lib/belgianTax/portfolioTax";
import { TaxYearSwitcher } from "@/components/tax/TaxYearSwitcher";
import { HistoricalYearBanner } from "@/components/tax/HistoricalYearBanner";
import { YearActionsMenu } from "@/components/tax/YearActionsMenu";
import { MultiYearTrendStrip } from "@/components/tax/MultiYearTrendStrip";
import { YearComparisonCard } from "@/components/tax/YearComparisonCard";
import { resolveHistoricalBannerMode } from "@/components/tax/historicalBannerMode";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { numberFormatToLocale } from "@/utils/currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Landmark,
  TrendingUp,
  TrendingDown,
  PiggyBank,
  Info,
  SlidersHorizontal,
  Calculator,
  CircleHelp,
  BadgePercent,
  ListChecks,
} from "lucide-react";
import { BarChart, type BarSeries } from "@/components/charts";
import { useStatistics } from "@/hooks/useStatistics";
import { isApproximatedTaxYear } from "@/lib/belgianTax";
import { usePortfolio } from "@/hooks/usePortfolio";
import { TaxProfileDialog } from "@/components/tax/TaxProfileDialog";
import SuggestedDeductionsCard from "@/components/tax/SuggestedDeductionsCard";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { cn } from "@/lib/utils";
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
  const { appSettings } = useAppSettings();
  const {
    profile: liveProfile,
    isLoading: isProfileLoading,
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
  // `profile`/`calculation` reflect the year currently being viewed (live or snapshot/estimate).
  // We keep `liveProfile` separately for the empty-state check and the editable dialog target.
  const profile = profileForYear(viewedYear);
  // Use the display calc — falls back to the frozen "as-filed" value when present so
  // engine drift doesn't retroactively change filed numbers (ADR-059).
  const calculation = displayCalculationForYear(viewedYear);
  const stats = useStatistics();
  const { summaries } = usePortfolio();
  const { convertToTarget } = useCurrencyConverter(appSettings.defaultCurrency || "EUR");
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const WIDGETS = getBudgetTaxWidgets(t);
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } =
    useWidgetVisibility("budgetTax", WIDGETS);

  function fmt(val: number) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: appSettings.defaultCurrency || "EUR",
      minimumFractionDigits: appSettings.showDecimalPlaces,
      maximumFractionDigits: appSettings.showDecimalPlaces,
    }).format(val);
  }

  const totalIncome = stats.data?.totalIncome ?? 0;
  const monthlyData = stats.data?.monthlyData;
  const yearlyData = stats.data?.yearlyComparison;
  const categoryPivot = stats.data?.categoryPivot;

  // Categories the user has flagged as taxable income (the "salary-like" filter).
  // Without this, the graphs would treat every positive transaction as PIT-able income.
  const taxIncomeCategoryIds = useMemo(
    () => new Set(profile.taxIncomeCategoryIds ?? []),
    [profile.taxIncomeCategoryIds],
  );
  const hasIncomeSources = taxIncomeCategoryIds.size > 0;

  /**
   * Per-period taxable income map ("YYYY-MM" → EUR), summed only over categories the user
   * marked as taxable income. Same source of truth as the green bars and the orange reserve.
   */
  const taxableIncomeByMonth = useMemo(() => {
    const result = new Map<string, number>();
    if (!hasIncomeSources || !categoryPivot) return result;
    for (const cat of categoryPivot) {
      if (cat.categoryId == null || !taxIncomeCategoryIds.has(cat.categoryId)) continue;
      for (const [period, amount] of Object.entries(cat.incomeMonths)) {
        result.set(period, (result.get(period) ?? 0) + amount);
      }
    }
    return result;
  }, [categoryPivot, hasIncomeSources, taxIncomeCategoryIds]);

  /** Per-year taxable income, summed from the monthly map. */
  const taxableIncomeByYear = useMemo(() => {
    const result = new Map<number, number>();
    for (const [period, amount] of taxableIncomeByMonth) {
      const year = Number.parseInt(period.slice(0, 4), 10);
      if (Number.isNaN(year)) continue;
      result.set(year, (result.get(year) ?? 0) + amount);
    }
    return result;
  }, [taxableIncomeByMonth]);

  // Shared with PortfolioTaxPage via the pure recordedTaxesForYear helper so both
  // pages accumulate recorded portfolio taxes identically (see lib/belgianTax/portfolioTax.ts).
  const portfolioTaxesForYear = useMemo(
    () =>
      summaries.reduce(
        (sum, inv) => sum + recordedTaxesForYear(inv as PortfolioTaxInvestment, viewedYear, convertToTarget),
        0,
      ),
    [summaries, viewedYear, convertToTarget],
  );

  const totalTaxIncludingPortfolio = calculation.totalPIT + portfolioTaxesForYear;
  // include estimated property tax in an alternate total (informational)
  const totalTaxIncludingPropertyEstimate = totalTaxIncludingPortfolio + calculation.propertyTaxEstimate;

  /**
   * Run PIT for a given gross + tax year. Picks each year's snapshot profile when one exists
   * (so the historical bars reflect the inputs the user actually had at the time); otherwise
   * falls back to the live profile applied to that year's tax tables. Each year's own bracket
   * table is used via the year-aware `getTaxTable` fallback inside `computeBelgianPIT`.
   */
  const pitForGross = useCallback((gross: number, year: number): number => {
    if (gross <= 0) return 0;
    // For years whose calculation is frozen, scale the frozen PIT proportionally to the
    // bar's gross relative to the frozen gross — this keeps historical filed numbers in the
    // chart aligned with the "as-filed" calc instead of falling back to a live recompute.
    const frozen = getFrozenCalculation(year);
    if (frozen && frozen.grossIncome > 0) {
      const ratio = gross / frozen.grossIncome;
      return frozen.totalPIT * ratio;
    }
    const baseProfile = profileForYear(year);
    return computeBelgianPIT({ ...baseProfile, grossAnnualIncome: gross, taxYear: year }).totalPIT;
  }, [profileForYear, getFrozenCalculation]);

  /**
   * Yearly chart series. Uses transaction-derived taxable income (filtered by the user's
   * selected categories) when available; falls back to total income otherwise (rare,
   * triggers the empty-state CTA on the chart below).
   */
  const yearlyIncome = useMemo(
    () =>
      (yearlyData ?? [])
        .map((y) => {
          const incomeForYear = hasIncomeSources
            ? (taxableIncomeByYear.get(y.year) ?? 0)
            : y.totalIncome;
          const estimatedPIT = pitForGross(incomeForYear, y.year);
          return {
            year: y.year.toString(),
            income: incomeForYear,
            estimatedTax: estimatedPIT,
            netAfterTax: Math.max(incomeForYear - estimatedPIT, 0),
            isApproximated: isApproximatedTaxYear(y.year),
          };
        })
        .filter((y) => y.income > 0),
    [yearlyData, pitForGross, hasIncomeSources, taxableIncomeByYear]
  );

  /**
   * Format a "YYYY-MM" period as a compact month tick. Year is shown only when it changes
   * (every January) and on the first tick so the starting year is unambiguous.
   */
  const formatMonthTick = useCallback((period: string, firstPeriod: string): string => {
    const [yearStr, monthStr] = period.split('-');
    const year = Number.parseInt(yearStr, 10);
    const month = Number.parseInt(monthStr, 10);
    if (Number.isNaN(year) || Number.isNaN(month)) return period;
    const monthName = new Intl.DateTimeFormat(locale, { month: 'short' }).format(
      new Date(year, month - 1, 1),
    );
    const showYear = month === 1 || period === firstPeriod;
    return showYear ? `${monthName} ’${String(year).slice(-2)}` : monthName;
  }, [locale]);

  /**
   * Monthly reserve series.
   *  - Live mode: trailing 12 months of taxable income; annual PIT computed once on that total
   *    and prorated per month by income share. Sum of monthly reserves equals annual PIT.
   *  - Historical mode: only months *within* the viewed year. Same proration approach against
   *    that year's total. Keeps the chart semantically aligned with the rest of the historical
   *    surface.
   */
  const monthlyIncomeTax = useMemo(() => {
    if (!monthlyData?.length) return [];

    const filtered = monthlyData
      .filter((m) => (hasIncomeSources ? taxableIncomeByMonth.has(m.period) : m.income > 0))
      .filter((m) => {
        if (!isViewingHistorical) return true;
        const monthYear = Number.parseInt(m.period.slice(0, 4), 10);
        return monthYear === viewedYear;
      });

    const windowed = isViewingHistorical ? filtered : filtered.slice(-12);
    const series = windowed
      .map((m) => ({
        period: m.period,
        income: hasIncomeSources ? (taxableIncomeByMonth.get(m.period) ?? 0) : m.income,
      }))
      .filter((m) => m.income > 0);

    const yearlyTaxable = series.reduce((sum, m) => sum + m.income, 0);
    if (yearlyTaxable <= 0) return [];

    const referenceYear = isViewingHistorical
      ? viewedYear
      : Number.parseInt(series[series.length - 1].period.slice(0, 4), 10);
    const annualPIT = pitForGross(yearlyTaxable, referenceYear);

    return series.map((m) => ({
      period: m.period,
      income: m.income,
      estimatedTax: annualPIT * (m.income / yearlyTaxable),
    }));
  }, [monthlyData, pitForGross, hasIncomeSources, taxableIncomeByMonth, isViewingHistorical, viewedYear]);

  const cards = [
    {
      title: t("tax.card.profileGrossIncome"),
      value: fmt(calculation.grossIncome),
      icon: TrendingUp,
      desc: t("tax.card.profileGrossIncome.desc"),
      cls: "text-gain",
    },
    {
      title: t("tax.card.totalPIT"),
      value: fmt(calculation.totalPIT),
      icon: Landmark,
      desc: t("tax.card.totalPIT.desc",),
      cls: "text-loss",
    },
    {
      title: t("tax.card.netTakeHome"),
      value: fmt(calculation.netTakeHome),
      icon: TrendingDown,
      desc: t("tax.card.netTakeHome.desc"),
      cls: calculation.netTakeHome >= 0 ? "amount-gain" : "amount-loss",
    },
    {
      title: t("tax.card.monthlyTaxReserve"),
      value: fmt(calculation.monthlyTaxReserve),
      icon: PiggyBank,
      desc: t("tax.card.monthlyTaxReserve.desc"),
      cls: "text-primary",
    },
    {
      title: t("tax.card.portfolioTaxesYear", { year: String(viewedYear) }),
      value: fmt(portfolioTaxesForYear),
      icon: Landmark,
      desc: t("tax.card.portfolioTaxesYear.desc"),
      cls: "text-loss",
    },
    {
      title: t("tax.card.totalWithPortfolio"),
      value: fmt(totalTaxIncludingPortfolio),
      icon: Landmark,
      desc: t("tax.card.totalWithPortfolio.desc"),
      cls: "text-primary",
    },
    {
      title: t("tax.card.totalWithPropertyEstimate", { year: String(viewedYear) }),
      value: fmt(totalTaxIncludingPropertyEstimate),
      icon: Landmark,
      desc: t("tax.card.totalWithPropertyEstimate.desc"),
      cls: "text-primary",
    },
  ];

  const pitBreakdownRows = [
    { label: t("tax.pit.row.taxableIncome"), value: calculation.taxableIncome, type: "base" as const },
    { label: t("tax.pit.row.bracket1"), value: calculation.federalPITBracket1, type: "tax" as const, bracket: t("tax.pit.bracketRange1") },
    { label: t("tax.pit.row.bracket2"), value: calculation.federalPITBracket2, type: "tax" as const, bracket: t("tax.pit.bracketRange2") },
    { label: t("tax.pit.row.bracket3"), value: calculation.federalPITBracket3, type: "tax" as const, bracket: t("tax.pit.bracketRange3") },
    { label: t("tax.pit.row.bracket4"), value: calculation.federalPITBracket4, type: "tax" as const, bracket: t("tax.pit.bracketRange4") },
    { label: t("tax.pit.row.federalBefore"), value: calculation.federalPITTotal, type: "total" as const },
    { label: t("tax.pit.row.personalExemptionBenefit"), value: calculation.personalExemptionBenefit, type: "reduction" as const },
    { label: t("tax.pit.row.federalTaxCredits"), value: calculation.federalTaxCredits, type: "reduction" as const },
    { label: t("tax.pit.row.federalAfter"), value: calculation.federalPITAfterReductions, type: "total" as const },
    { label: t("tax.pit.row.communalSurcharge",), value: calculation.communalSurcharge, type: "tax" as const },
    { label: t("tax.pit.row.specialSS"), value: calculation.specialSocialSecurityContribution, type: "tax" as const },
    { label: t("tax.pit.row.totalPIT"), value: calculation.totalPIT, type: "grand" as const },
    { label: t("tax.pit.row.portfolioTaxesYear", { year: String(viewedYear) }), value: portfolioTaxesForYear, type: "tax" as const },
    { label: t("tax.pit.row.totalTaxInclPortfolio"), value: totalTaxIncludingPortfolio, type: "grand" as const },
    // Property tax estimate is informational and shown separately
    { label: t('tax.pit.row.propertyTaxEstimate'), value: calculation.propertyTaxEstimate, type: 'tax' as const },
    { label: t("tax.pit.row.totalWithPropertyEstimate"), value: totalTaxIncludingPropertyEstimate, type: "grand" as const },
  ];

  const taxRuleCards = [
    {
      title: t("tax.rules.federalBracketsTitle"),
      items: [t("tax.rules.federalBrackets.1"), t("tax.rules.federalBrackets.2"), t("tax.rules.federalBrackets.3"), t("tax.rules.federalBrackets.4")],
    },
    {
      title: t("tax.rules.socialSecurityTitle"),
      items: [t("tax.rules.ss.employee"), t("tax.rules.ss.special"), t("tax.rules.ss.employer"), t("tax.rules.ss.selfEmployed")],
    },
    {
      title: t("tax.rules.investmentTitle"),
      items: [t("tax.rules.investment.savings"), t("tax.rules.investment.dividends"), t("tax.rules.investment.foreign")],
    },
    {
      title: t("tax.rules.otherTaxesTitle"),
      items: [t("tax.rules.other.vat"), t("tax.rules.other.tob"), t("tax.rules.other.property")],
    },
  ];

  const hasProfile =
    liveProfile.profileConfigured ||
    liveProfile.grossAnnualIncome > 0 ||
    liveProfile.otherTaxableIncome > 0 ||
    liveProfile.cadastralIncome > 0 ||
    liveProfile.dependentChildren > 0 ||
    liveProfile.dependentOtherPersons > 0;
  const hasStatsData = totalIncome > 0 || (monthlyData ?? []).some((m) => m.income > 0);
  // Only treat "no data" as the setup-prompt empty state when the stats fetch
  // actually succeeded. On a stats error, a user who simply hasn't filled in the
  // profile yet (but has real transaction-derived income) would otherwise see
  // "set up your tax profile" instead of the real error.
  const isEmpty = !isProfileLoading && !stats.isError && !hasProfile && !hasStatsData;

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

        {isVisible("trendStrip") && <MultiYearTrendStrip />}

        <Card className="!border-primary/50 bg-primary/5">
                    <CardContent className="flex items-start gap-3 py-4">
                      <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                      <div>
                <p className="text-sm font-medium text-foreground">{t('tax.belgianRulesDesc')}</p>
               <p className="text-xs text-muted-foreground mt-1">{t('tax.disclaimerTitle')}: {t('tax.disclaimerText')}</p>
                </div>
              </CardContent>
            </Card>

        {isProfileLoading ? (
          <SectionLoader />
        ) : isEmpty ? (
          <Card className="glass-regular">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Landmark className="h-12 w-12 text-muted-foreground/40 mb-4" />
                <h3 className="text-lg font-semibold text-foreground mb-1">{t('tax.noProfile.title')}</h3>
               <p className="text-muted-foreground text-sm max-w-sm mb-4">{t('tax.noProfile.desc')}</p>
               <TaxProfileDialog
                 trigger={
                   <Button size="sm" className="gap-2">
                     <Calculator className="h-4 w-4" />
                     {t('tax.profile.setup')}
                   </Button>
                 }
               />
            </CardContent>
          </Card>
        ) : (
          <>
            {isVisible("summaryCards") && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {cards.map((c) => (
                  <Card key={c.title} className="glass-regular premium-frame">
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
                      <c.icon className={`h-4 w-4 ${c.cls}`} />
                    </CardHeader>
                    <CardContent>
                      <p className={`text-2xl font-bold ${c.cls}`}>{c.value}</p>
                      <p className="text-xs text-muted-foreground mt-1">{c.desc}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {isVisible("pitBreakdown") && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      {t('tax.pit.title')}
                      <UITooltip>
                        <TooltipTrigger asChild>
                          <CircleHelp className="h-4 w-4 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-xs">
                          {t('tax.pit.tooltip')}
                        </TooltipContent>
                      </UITooltip>
                    </CardTitle>
                    <CardDescription>{t('tax.pit.description')}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('tax.pit.table.component')}</TableHead>
                            <TableHead className="text-right">{t('tax.pit.table.amount')}</TableHead>
                          </TableRow>
                        </TableHeader>
                      <TableBody>
                        {pitBreakdownRows.map((row) => (
                          <TableRow key={row.label}>
                            <TableCell>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm">{row.label}</span>
                                {row.bracket && (
                                  <Badge variant="outline" className="text-[10px]">
                                    {row.bracket}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right font-medium tabular-nums",
                                row.type === "tax" && "text-loss",
                                row.type === "reduction" && "text-gain",
                                row.type === "grand" && "text-primary font-bold"
                              )}
                            >
                              {row.type === "reduction" ? "+" : ""}
                              {fmt(row.value)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              {isVisible("taxRules") && (
                <Card className="glass-regular">
                  <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                       {t('tax.rules.title')}
                       <BadgePercent className="h-4 w-4 text-muted-foreground" />
                     </CardTitle>
                    <CardDescription>{t('tax.rules.description')}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {taxRuleCards.map((rule) => (
                      <div key={rule.title} className="p-3 rounded-lg border border-border bg-card/50">
                        <p className="text-sm font-semibold text-foreground mb-2">{rule.title}</p>
                        <ul className="space-y-1">
                          {rule.items.map((item) => (
                            <li key={item} className="text-xs text-muted-foreground leading-relaxed">
                              - {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {isVisible("incomeBreakdown") && (
                <Card className="glass-regular">
                    <CardHeader>
                    <CardTitle>{t('tax.incomeBreakdown.title')}</CardTitle>
                    <CardDescription>{t('tax.incomeBreakdown.description')}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {!hasIncomeSources ? (
                      <div className="flex flex-col items-center justify-center text-center py-10 px-4">
                        <ListChecks className="h-10 w-10 text-muted-foreground/40 mb-3" />
                        <h4 className="text-sm font-semibold text-foreground mb-1">
                          {t('tax.incomeBreakdown.emptyTitle')}
                        </h4>
                        <p className="text-xs text-muted-foreground max-w-xs mb-4">
                          {t('tax.incomeBreakdown.emptyDesc')}
                        </p>
                        <TaxProfileDialog
                          initialStep="incomeSources"
                          targetYear={viewedYear}
                          trigger={
                            <Button size="sm" variant="outline" className="gap-2">
                              <ListChecks className="h-4 w-4" />
                              {t('tax.incomeBreakdown.emptyCta')}
                            </Button>
                          }
                        />
                      </div>
                    ) : monthlyIncomeTax.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-10">
                        {t('tax.incomeBreakdown.noData')}
                      </p>
                    ) : (
                      <BarChart
                        data={monthlyIncomeTax}
                        categoryAccessor={(d) => d.period}
                        categoryTickFormat={(label) => formatMonthTick(label, monthlyIncomeTax[0]?.period ?? label)}
                        height={280}
                        valueTickFormat={(v) => fmt(v)}
                        tooltipValueFormat={(v) => fmt(v)}
                        series={[
                          { key: "income", label: t('tax.chart.income'), accessor: (d) => d.income, color: "hsl(var(--primary))" },
                          { key: "estimatedTax", label: t('tax.chart.pitReserve'), accessor: (d) => d.estimatedTax, color: "hsl(var(--chart-5))" },
                        ] as BarSeries<typeof monthlyIncomeTax[number]>[]}
                      />
                    )}
                  </CardContent>
                </Card>
              )}

              <Card className="glass-regular">
                <CardHeader>
                      <CardTitle>{t('tax.profile.currentInputs')}</CardTitle>
                   <CardDescription>{t('tax.profile.currentInputs.desc')}</CardDescription>
                   </CardHeader>
                  <CardContent className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.profile.field.employmentType')}</span>
                    <Badge variant="secondary">{profile.employmentType.replaceAll("_", " ")}</Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.profile.field.grossAnnualIncome')}</span>
                    <span className="font-semibold tabular-nums">{fmt(profile.grossAnnualIncome)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.profile.field.otherTaxableIncome')}</span>
                    <span className="font-semibold tabular-nums">{fmt(profile.otherTaxableIncome)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.profile.field.professionalExpenses')}</span>
                    <span className="font-semibold tabular-nums">
                      {profile.professionalExpenseMethod === "lump_sum"
                        ? t('tax.profile.field.professionalExpenses.lump')
                        : fmt(profile.actualProfessionalExpenses)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.profile.field.dependents')}</span>
                    <span className="font-semibold">
                      {profile.dependentChildren} {t('tax.profile.field.children')} / {profile.dependentOtherPersons} {t('tax.profile.field.others')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.profile.field.personalExemption')}</span>
                    <span className="font-semibold tabular-nums">{fmt(calculation.personalExemptionAmount)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.profile.field.disabilityExemptions')}</span>
                    <span className="font-semibold">
                      {profile.isDisabled || profile.isSpouseDisabled ? t('common.applied') : t('common.none')}
                    </span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.pit.row.federalAfter')}</span>
                    <span className="font-semibold tabular-nums text-loss">
                      {fmt(calculation.federalPITAfterReductions)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.pit.row.communalSurcharge')}</span>
                    <span className="font-semibold tabular-nums text-loss">{fmt(calculation.communalSurcharge)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.pit.row.employeeSS')}</span>
                    <span className="font-semibold tabular-nums text-loss">
                      {fmt(calculation.employeeSocialSecurity)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.pit.row.specialSS')}</span>
                    <span className="font-semibold tabular-nums text-loss">
                      {fmt(calculation.specialSocialSecurityContribution)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.pit.row.totalBurden')}</span>
                    <span className="font-bold tabular-nums text-primary">{fmt(calculation.totalTaxBurden)}</span>
                  </div>
                  </CardContent>
               </Card>
              <div>
                <SuggestedDeductionsCard />
              </div>
            </div>

            {isVisible("yearComparison") && <YearComparisonCard />}

            {isVisible("yearlyOverview") && (
              <Card className="glass-regular">
                <CardHeader>
                   <CardTitle>{t('tax.yearly.title')}</CardTitle>
                   <CardDescription>{t('tax.yearly.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                  {!hasIncomeSources ? (
                    <div className="flex flex-col items-center justify-center text-center py-10 px-4">
                      <ListChecks className="h-10 w-10 text-muted-foreground/40 mb-3" />
                      <h4 className="text-sm font-semibold text-foreground mb-1">
                        {t('tax.incomeBreakdown.emptyTitle')}
                      </h4>
                      <p className="text-xs text-muted-foreground max-w-xs mb-4">
                        {t('tax.incomeBreakdown.emptyDesc')}
                      </p>
                      <TaxProfileDialog
                        initialStep="incomeSources"
                        targetYear={viewedYear}
                        trigger={
                          <Button size="sm" variant="outline" className="gap-2">
                            <ListChecks className="h-4 w-4" />
                            {t('tax.incomeBreakdown.emptyCta')}
                          </Button>
                        }
                      />
                    </div>
                  ) : yearlyIncome.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-10">
                      {t('tax.incomeBreakdown.noData')}
                    </p>
                  ) : (
                    <>
                      <BarChart
                        data={yearlyIncome}
                        categoryAccessor={(d) => d.year}
                        height={300}
                        valueTickFormat={(v) => fmt(v)}
                        tooltipValueFormat={(v) => fmt(v)}
                        series={[
                          { key: "netAfterTax", label: t('tax.chart.netAfterTax'), accessor: (d) => d.netAfterTax, color: "hsl(var(--primary))" },
                          { key: "estimatedTax", label: t('tax.chart.pit'), accessor: (d) => d.estimatedTax, color: "hsl(var(--chart-5))" },
                        ] as BarSeries<typeof yearlyIncome[number]>[]}
                      />
                      {yearlyIncome.some((y) => y.isApproximated) && (
                        <p className="text-[11px] text-muted-foreground mt-2 flex items-start gap-1.5">
                          <Info className="h-3 w-3 mt-0.5 shrink-0" />
                          {t('tax.yearly.approximatedNote')}
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            )}
            <Card className="glass-regular border-border/70">
                <CardHeader>
                <CardTitle className="text-base">{t('tax.automation.title')}</CardTitle>
                </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground">
                  <span className="font-semibold text-foreground">{t('tax.automation.automatic')}:</span> {t('tax.automation.automaticDesc')}
                </p>
                <p className="text-muted-foreground">
                  <span className="font-semibold text-foreground">{t('tax.automation.manualLabel')}:</span> {t('tax.automation.manualDesc')}
                </p>
                <p className="text-muted-foreground">
                  <span className="font-semibold text-foreground">{t('tax.automation.investmentLabel')}:</span> {t('tax.automation.investmentDesc')}
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
