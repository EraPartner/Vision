import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Landmark, TrendingUp, TrendingDown, Receipt, PiggyBank, Home, Briefcase, Info } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { useStatistics } from "@/hooks/useStatistics";
import { cn } from "@/lib/utils";
import { useMemo } from "react";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { Tooltip as UITooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function getBudgetTaxWidgets(t: (key: string) => string): WidgetDefinition[] {
  return [
    { id: "summaryCards",    label: t('tax.widget.summaryCards'),    defaultVisible: true },
    { id: "incomeBreakdown", label: t('tax.widget.incomeBreakdown'), defaultVisible: true },
    { id: "taxCategories",   label: t('tax.widget.taxCategories'),   defaultVisible: true },
    { id: "yearlyOverview",  label: t('tax.widget.yearlyOverview'),  defaultVisible: true },
  ];
}
const COLORS = [
  "hsl(217, 91%, 60%)", "hsl(142, 76%, 36%)", "hsl(45, 93%, 47%)",
  "hsl(280, 87%, 65%)", "hsl(340, 82%, 52%)", "hsl(200, 80%, 50%)",
];
export default function TaxOverviewPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const stats = useStatistics();
  const WIDGETS = getBudgetTaxWidgets(t);
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } = useWidgetVisibility('budgetTax', WIDGETS);
  function fmt(val: number) {
    return new Intl.NumberFormat(locale, { style: "currency", currency: appSettings.defaultCurrency || 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val);
  }
  const totalIncome = stats?.totalIncome ?? 0;
  const totalSpending = stats?.totalSpending ?? 0;
  const monthlyData = stats?.monthlyData ?? [];
  const yearlyData = stats?.yearlyComparison ?? [];
  // Tax-relevant category data
  const taxRelevantCategories = useMemo(() => {
    const categories = [
      { key: t('tax.incomeTax'), desc: t('tax.incomeTaxDesc'), type: 'estimated' as const, amount: totalIncome * 0.3, basis: totalIncome, icon: Landmark },
      { key: t('tax.socialSecurity'), desc: t('tax.socialSecurityDesc'), type: 'estimated' as const, amount: totalIncome * 0.13, basis: totalIncome, icon: PiggyBank },
      { key: t('tax.vat'), desc: t('tax.vatDesc'), type: 'estimated' as const, amount: totalSpending * 0.21 * 0.6, basis: totalSpending, icon: Receipt },
      { key: t('tax.propertyTax'), desc: t('tax.propertyTaxDesc'), type: 'info' as const, amount: 0, basis: 0, icon: Home },
      { key: t('tax.municipalTax'), desc: t('tax.municipalTaxDesc'), type: 'info' as const, amount: 0, basis: 0, icon: Briefcase },
    ];
    return categories;
  }, [totalIncome, totalSpending, t]);
  // Yearly income for chart
  const yearlyIncome = useMemo(() =>
    yearlyData.map(y => ({
      year: y.year.toString(),
      income: y.totalIncome,
      estimatedTax: y.totalIncome * 0.3,
      netAfterTax: y.totalIncome * 0.7,
    })).filter(y => y.income > 0),
    [yearlyData]
  );
  // Monthly income vs estimated tax
  const monthlyIncomeTax = useMemo(() =>
    monthlyData
      .filter(m => m.income > 0)
      .slice(-12)
      .map(m => ({
        period: m.period,
        income: m.income,
        estimatedTax: m.income * 0.3,
      })),
    [monthlyData]
  );
  const estimatedAnnualTax = totalIncome * 0.3;
  const estimatedMonthlySavings = estimatedAnnualTax / 12;
  const netIncome = totalIncome - estimatedAnnualTax;
  const cards = [
    {
      title: t('tax.totalIncome'),
      value: fmt(totalIncome),
      icon: TrendingUp,
      desc: t('tax.allTimeIncome'),
      cls: "text-accent"
    },
    {
      title: t('tax.estimatedIncomeTax'),
      value: fmt(estimatedAnnualTax),
      icon: Landmark,
      desc: t('tax.approx30Percent'),
      cls: "text-destructive"
    },
    {
      title: t('tax.netAfterTax'),
      value: fmt(netIncome),
      icon: TrendingDown,
      desc: t('tax.afterEstimatedTax'),
      cls: netIncome >= 0 ? "text-accent" : "text-destructive"
    },
    {
      title: t('tax.monthlySavingsNeeded'),
      value: fmt(estimatedMonthlySavings),
      icon: PiggyBank,
      desc: t('tax.setAsideMonthly'),
      cls: "text-primary"
    },
  ];
  const isEmpty = totalIncome === 0 && totalSpending === 0;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">{t('tax.budgetTitle')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('tax.budgetDesc')}</p>
        </div>
        <WidgetVisibilityDialog
          widgets={widgetDefs}
          isVisible={isVisible}
          setWidgetVisible={setWidgetVisible}
          setAllVisible={setAllVisible}
          resetToDefaults={resetToDefaults}
        />
      </div>
      {/* Disclaimer */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">{t('tax.disclaimerTitle')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('tax.disclaimerText')}</p>
          </div>
        </CardContent>
      </Card>
      {isEmpty ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Landmark className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-1">{t('tax.noData')}</h3>
            <p className="text-muted-foreground text-sm max-w-sm">{t('tax.noDataBudgetDesc')}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary Cards */}
          {isVisible('summaryCards') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {cards.map((c) => (
                <Card key={c.title}>
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
            {/* Income vs Estimated Tax chart */}
            {isVisible('incomeBreakdown') && monthlyIncomeTax.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('tax.widget.incomeBreakdown')}</CardTitle>
                  <CardDescription>{t('tax.incomeBreakdownDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={monthlyIncomeTax}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="period" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                      <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "var(--radius)", color: "hsl(var(--card-foreground))" }}
                        formatter={(v: number) => fmt(v)}
                      />
                      <Bar dataKey="income" name={t('tax.income')} fill="hsl(142, 76%, 36%)" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="estimatedTax" name={t('tax.estimatedTax')} fill="hsl(340, 82%, 52%)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
            {/* Tax Categories */}
            {isVisible('taxCategories') && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('tax.widget.taxCategories')}</CardTitle>
                  <CardDescription>{t('tax.taxCategoriesDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {taxRelevantCategories.map(({ key, desc, type, amount, icon: Icon }) => (
                      <div key={key} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                        <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{key}</span>
                            {type === 'estimated' && (
                              <Badge variant="secondary" className="text-[10px]">{t('tax.estimated')}</Badge>
                            )}
                            {type === 'info' && (
                              <Badge variant="outline" className="text-[10px]">{t('tax.informational')}</Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                        </div>
                        <div className="text-right shrink-0">
                          {type === 'estimated' && amount > 0 ? (
                            <p className="font-bold text-sm tabular-nums text-destructive">{fmt(amount)}</p>
                          ) : (
                            <p className="text-sm text-muted-foreground">—</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
          {/* Yearly Overview */}
          {isVisible('yearlyOverview') && yearlyIncome.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t('tax.widget.yearlyOverview')}</CardTitle>
                <CardDescription>{t('tax.yearlyOverviewDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={yearlyIncome}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="year" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                    <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "var(--radius)", color: "hsl(var(--card-foreground))" }}
                      formatter={(v: number) => fmt(v)}
                    />
                    <Bar dataKey="netAfterTax" name={t('tax.netAfterTax')} stackId="a" fill="hsl(142, 76%, 36%)" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="estimatedTax" name={t('tax.estimatedTax')} stackId="a" fill="hsl(340, 82%, 52%)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
