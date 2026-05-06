import { useMemo, useCallback } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { computeBelgianPIT } from "@/lib/belgianTax";
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
  Loader2,
} from "lucide-react";
import { BarChart, type BarSeries } from "@/components/charts";
import { useStatistics } from "@/hooks/useStatistics";
import { CustomCategoryChart } from "@/components/statistics/CustomCategoryChart";
import { usePortfolio } from "@/hooks/usePortfolio";
import { TaxProfileDialog } from "@/components/tax/TaxProfileDialog";
import SuggestedDeductionsCard from "@/components/tax/SuggestedDeductionsCard";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { ExportDialog } from "@/components/reports/ExportDialog";

function getBudgetTaxWidgets(t: (key: string) => string): WidgetDefinition[] {
  return [
    { id: "summaryCards", label: t("tax.widget.summaryCards"), defaultVisible: true },
    { id: "incomeBreakdown", label: t("tax.widget.incomeBreakdown"), defaultVisible: true },
    { id: "pitBreakdown", label: t("tax.widget.pitBreakdown"), defaultVisible: true },
    { id: "taxRules", label: t("tax.widget.belgianRulesTitle"), defaultVisible: true },
    { id: "yearlyOverview", label: t("tax.widget.yearlyOverview"), defaultVisible: true },
    { id: "yearlyTaxPayments", label: t("tax.widget.yearlyTaxPayments"), defaultVisible: true },
  ];
}

export default function TaxOverviewPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const { profile, calculation, isLoading: isProfileLoading } = useBelgianTaxProfile();
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

  const portfolioTaxesForYear = useMemo(() => {
    const year = profile.taxYear;
    return summaries.reduce((sum, inv) => {
      const yearlyInvestmentTaxes = inv.transactions.reduce((txnSum: number, txn: { date?: string; type?: string; amount?: number; taxes?: number; currency?: string }) => {
        const date = txn.date;
        if (!date) return txnSum;

        const txnYear = Number.parseInt(date.slice(0, 4), 10);
        if (Number.isNaN(txnYear) || txnYear !== year) return txnSum;

        const explicitTaxTxn = txn.type === "tax" ? convertToTarget(Number(txn.amount) || 0, txn.currency) : 0;
        const taxField = convertToTarget(Number(txn.taxes) || 0, txn.currency);
        return txnSum + explicitTaxTxn + taxField;
      }, 0);

      return sum + yearlyInvestmentTaxes;
    }, 0);
  }, [summaries, profile.taxYear, convertToTarget]);

  const totalTaxIncludingPortfolio = calculation.totalPIT + portfolioTaxesForYear;
  // include estimated property tax in an alternate total (informational)
  const totalTaxIncludingPropertyEstimate = totalTaxIncludingPortfolio + calculation.propertyTaxEstimate;

  // Re-run the bracket calculation per year/month with the observed income to respect progressive
  // brackets — linear scaling of `totalPIT` is wrong because each bracket has a different rate.
  const pitForGross = useCallback((gross: number): number => {
    if (gross <= 0) return 0;
    return computeBelgianPIT({ ...profile, grossAnnualIncome: gross }).totalPIT;
  }, [profile]);

  const yearlyIncome = useMemo(
    () =>
      (yearlyData ?? [])
        .map((y) => {
          const estimatedPIT = pitForGross(y.totalIncome);
          return {
            year: y.year.toString(),
            income: y.totalIncome,
            estimatedTax: estimatedPIT,
            netAfterTax: y.totalIncome - estimatedPIT,
          };
        })
        .filter((y) => y.income > 0),
    [yearlyData, pitForGross]
  );

  const monthlyIncomeTax = useMemo(
    () =>
      (monthlyData ?? [])
        .filter((m) => m.income > 0)
        .slice(-12)
        .map((m) => {
          const annualizedIncome = m.income * 12;
          const monthlyPIT = pitForGross(annualizedIncome) / 12;
          return {
            period: m.period,
            income: m.income,
            estimatedTax: monthlyPIT,
          };
        }),
    [monthlyData, pitForGross]
  );

  const cards = [
    {
      title: t("tax.card.profileGrossIncome"),
      value: fmt(calculation.grossIncome),
      icon: TrendingUp,
      desc: t("tax.card.profileGrossIncome.desc"),
      cls: "text-accent",
    },
    {
      title: t("tax.card.totalPIT"),
      value: fmt(calculation.totalPIT),
      icon: Landmark,
      desc: t("tax.card.totalPIT.desc",),
      cls: "text-destructive",
    },
    {
      title: t("tax.card.netTakeHome"),
      value: fmt(calculation.netTakeHome),
      icon: TrendingDown,
      desc: t("tax.card.netTakeHome.desc"),
      cls: calculation.netTakeHome >= 0 ? "text-accent" : "text-destructive",
    },
    {
      title: t("tax.card.monthlyTaxReserve"),
      value: fmt(calculation.monthlyTaxReserve),
      icon: PiggyBank,
      desc: t("tax.card.monthlyTaxReserve.desc"),
      cls: "text-primary",
    },
    {
      title: t("tax.card.portfolioTaxesYear", { year: String(profile.taxYear) }),
      value: fmt(portfolioTaxesForYear),
      icon: Landmark,
      desc: t("tax.card.portfolioTaxesYear.desc"),
      cls: "text-destructive",
    },
    {
      title: t("tax.card.totalWithPortfolio"),
      value: fmt(totalTaxIncludingPortfolio),
      icon: Landmark,
      desc: t("tax.card.totalWithPortfolio.desc"),
      cls: "text-primary",
    },
    {
      title: t("tax.card.totalWithPropertyEstimate", { year: String(profile.taxYear) }),
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
    { label: t("tax.pit.row.portfolioTaxesYear", { year: String(profile.taxYear) }), value: portfolioTaxesForYear, type: "tax" as const },
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
    profile.profileConfigured ||
    profile.grossAnnualIncome > 0 ||
    profile.otherTaxableIncome > 0 ||
    profile.cadastralIncome > 0 ||
    profile.dependentChildren > 0 ||
    profile.dependentOtherPersons > 0;
  const hasStatsData = totalIncome > 0 || (monthlyData ?? []).some((m) => m.income > 0);
  const isEmpty = !isProfileLoading && !hasProfile && !hasStatsData;

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
          <Badge variant="secondary">Tax year {profile.taxYear}</Badge>
          <Badge variant="outline">Region: {profile.region}</Badge>
          <Badge variant="outline">Marginal rate: {calculation.marginalRate.toFixed(0)}%</Badge>
          <Badge variant="outline">Effective burden: {calculation.effectiveRate.toFixed(1)}%</Badge>
        </div>

        <Card className="border-primary/20 bg-primary/5">
                    <CardContent className="flex items-start gap-3 py-4">
                      <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                      <div>
                <p className="text-sm font-medium text-foreground">{t('tax.belgianRulesDesc')}</p>
               <p className="text-xs text-muted-foreground mt-1">{t('tax.disclaimerTitle')}: {t('tax.disclaimerText')}</p>
                </div>
              </CardContent>
            </Card>

        {isProfileLoading ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Loader2 className="h-8 w-8 text-muted-foreground/60 animate-spin mb-3" />
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            </CardContent>
          </Card>
        ) : isEmpty ? (
          <Card>
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
                  <Card key={c.title} className="surface-elevated premium-frame">
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
                                row.type === "tax" && "text-destructive",
                                row.type === "reduction" && "text-accent",
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
                <Card>
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
              {isVisible("incomeBreakdown") && monthlyIncomeTax.length > 0 && (
                <Card>
                    <CardHeader>
                    <CardTitle>{t('tax.incomeBreakdown.title')}</CardTitle>
                    <CardDescription>{t('tax.incomeBreakdown.description')}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <BarChart
                      data={monthlyIncomeTax}
                      categoryAccessor={(d) => d.period}
                      height={280}
                      valueTickFormat={(v) => fmt(v)}
                      tooltipValueFormat={(v) => fmt(v)}
                      series={[
                        { key: "income", label: t('tax.chart.income'), accessor: (d) => d.income, color: "hsl(var(--primary))" },
                        { key: "estimatedTax", label: t('tax.chart.pitReserve'), accessor: (d) => d.estimatedTax, color: "hsl(var(--chart-5))" },
                      ] as BarSeries<typeof monthlyIncomeTax[number]>[]}
                    />
                  </CardContent>
                </Card>
              )}

              <Card>
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
                    <span className="font-semibold tabular-nums text-destructive">
                      {fmt(calculation.federalPITAfterReductions)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.pit.row.communalSurcharge')}</span>
                    <span className="font-semibold tabular-nums text-destructive">{fmt(calculation.communalSurcharge)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.pit.row.employeeSS')}</span>
                    <span className="font-semibold tabular-nums text-destructive">
                      {fmt(calculation.employeeSocialSecurity)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('tax.pit.row.specialSS')}</span>
                    <span className="font-semibold tabular-nums text-destructive">
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

            {isVisible("yearlyOverview") && yearlyIncome.length > 0 && (
              <Card>
                <CardHeader>
                   <CardTitle>{t('tax.yearly.title')}</CardTitle>
                   <CardDescription>{t('tax.yearly.description')}</CardDescription>
                </CardHeader>
                <CardContent>
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
                </CardContent>
              </Card>
            )}
            {/* Tax payments selector chart - let users pick categories/recipients that correspond to taxes */}
            {isVisible("yearlyTaxPayments") && stats.data && (
              <div className="lg:col-span-2">
                <CustomCategoryChart
                  data={stats.getGraphData("yearlyTaxPayments") ?? stats.data}
                  graphKey="yearlyTaxPayments"
                  isFiltered={stats.graphExclusions["yearlyTaxPayments"] ?? true}
                  onToggle={stats.toggleGraphExclusion}
                  exclusionsApply={stats.exclusionsApply}
                  hideSaveControls={true}
                  persistSelection={true}
                  headerTooltip={t('tax.widget.yearlyTaxPayments')}
                />
              </div>
            )}

            <Card className="border-border/70">
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
