import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Receipt, TrendingDown, Landmark, PieChart as PieChartIcon, AlertTriangle, DollarSign } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { usePortfolio } from "@/hooks/usePortfolio";
import { ASSET_CLASS_LABELS } from "@/types/portfolio";
import { cn } from "@/lib/utils";
import { useMemo } from "react";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";

function getPortfolioTaxWidgets(t: (key: string) => string): WidgetDefinition[] {
  return [
    { id: "summaryCards",    label: t('tax.widget.summaryCards'),    defaultVisible: true },
    { id: "taxByAssetClass", label: t('tax.widget.taxByAssetClass'), defaultVisible: true },
    { id: "taxTypes",        label: t('tax.widget.taxTypes'),        defaultVisible: true },
    { id: "investmentBreakdown", label: t('tax.widget.investmentBreakdown'), defaultVisible: true },
  ];
}
const COLORS = [
  "hsl(217, 91%, 60%)", "hsl(142, 76%, 36%)", "hsl(45, 93%, 47%)",
  "hsl(280, 87%, 65%)", "hsl(340, 82%, 52%)", "hsl(200, 80%, 50%)",
];
export default function PortfolioTaxPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const { summaries } = usePortfolio();
  const WIDGETS = getPortfolioTaxWidgets(t);
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } = useWidgetVisibility('portfolioTax', WIDGETS);
  function fmt(val: number, currency = 'EUR') {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
  }
  // Aggregate totals
  const totalTaxes = summaries.reduce((s, i) => s + i.totalTaxes, 0);
  const totalFees = summaries.reduce((s, i) => s + i.totalFees, 0);
  const totalTaxesAndFees = totalTaxes + totalFees;
  const totalRealizedGain = summaries.reduce((s, i) => s + i.realizedGain, 0);
  const totalUnrealizedGain = summaries.reduce((s, i) => s + i.unrealizedGain, 0);
  // Effective tax rate on realized gains
  const effectiveTaxRate = totalRealizedGain > 0 ? (totalTaxes / totalRealizedGain) * 100 : 0;
  // Tax breakdown by type from transactions
  const taxBreakdown = useMemo(() => {
    const breakdown: Record<string, number> = {
      [t('tax.capitalGainsTax')]: 0,
      [t('tax.dividendWithholding')]: 0,
      [t('tax.transactionTax')]: 0,
      [t('tax.otherTaxes')]: 0,
    };
    summaries.forEach(inv => {
      inv.transactions.forEach((txn: any) => {
        const txnTaxes = Number(txn.taxes) || 0;
        if (txn.type === 'sell' && txnTaxes > 0) {
          breakdown[t('tax.capitalGainsTax')] += txnTaxes;
        } else if (txn.type === 'dividend' && txnTaxes > 0) {
          breakdown[t('tax.dividendWithholding')] += txnTaxes;
        } else if (txn.type === 'buy' && txnTaxes > 0) {
          breakdown[t('tax.transactionTax')] += txnTaxes;
        } else if (txn.type === 'tax') {
          breakdown[t('tax.otherTaxes')] += Number(txn.amount) || 0;
        } else if (txnTaxes > 0) {
          breakdown[t('tax.otherTaxes')] += txnTaxes;
        }
      });
    });
    return Object.entries(breakdown)
      .map(([name, value]) => ({ name, value }))
      .filter(d => d.value > 0);
  }, [summaries, t]);
  // Fee breakdown by type
  const feeBreakdown = useMemo(() => {
    const breakdown: Record<string, number> = {
      [t('tax.brokerFees')]: 0,
      [t('tax.managementFees')]: 0,
      [t('tax.otherFees')]: 0,
    };
    summaries.forEach(inv => {
      inv.transactions.forEach((txn: any) => {
        const txnFees = Number(txn.fees) || 0;
        if (['buy', 'sell'].includes(txn.type) && txnFees > 0) {
          breakdown[t('tax.brokerFees')] += txnFees;
        } else if (txn.type === 'fee') {
          breakdown[t('tax.managementFees')] += Number(txn.amount) || 0;
        } else if (txnFees > 0) {
          breakdown[t('tax.otherFees')] += txnFees;
        }
      });
    });
    return Object.entries(breakdown)
      .map(([name, value]) => ({ name, value }))
      .filter(d => d.value > 0);
  }, [summaries, t]);
  // By asset class
  const taxByAssetClass = useMemo(() => {
    const map: Record<string, { taxes: number; fees: number }> = {};
    summaries.forEach(inv => {
      const label = ASSET_CLASS_LABELS[inv.assetClass] || inv.assetClass;
      if (!map[label]) map[label] = { taxes: 0, fees: 0 };
      map[label].taxes += inv.totalTaxes;
      map[label].fees += inv.totalFees;
    });
    return Object.entries(map)
      .map(([name, { taxes, fees }]) => ({ name, taxes, fees, total: taxes + fees }))
      .filter(d => d.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [summaries]);
  // Per-investment breakdown sorted by total taxes+fees
  const investmentBreakdown = useMemo(() =>
    summaries
      .map(inv => ({
        id: inv.id,
        name: inv.name,
        symbol: inv.symbol,
        assetClass: ASSET_CLASS_LABELS[inv.assetClass],
        taxes: inv.totalTaxes,
        fees: inv.totalFees,
        total: inv.totalTaxes + inv.totalFees,
        realizedGain: inv.realizedGain,
        currency: inv.currency,
      }))
      .filter(i => i.total > 0)
      .sort((a, b) => b.total - a.total),
    [summaries]
  );
  const isEmpty = summaries.length === 0;
  const cards = [
    {
      title: t('tax.totalTaxesPaid'),
      value: fmt(totalTaxes),
      icon: Landmark,
      desc: t('tax.acrossAllInvestments'),
      cls: "text-destructive"
    },
    {
      title: t('tax.totalFeesPaid'),
      value: fmt(totalFees),
      icon: Receipt,
      desc: t('tax.brokerAndMgmtFees'),
      cls: "text-destructive"
    },
    {
      title: t('tax.totalCosts'),
      value: fmt(totalTaxesAndFees),
      icon: TrendingDown,
      desc: t('tax.combinedTaxesAndFees'),
      cls: "text-destructive"
    },
    {
      title: t('tax.effectiveTaxRate'),
      value: `${effectiveTaxRate.toFixed(1)}%`,
      icon: AlertTriangle,
      desc: t('tax.onRealizedGains'),
      cls: effectiveTaxRate > 25 ? "text-destructive" : "text-muted-foreground"
    },
  ];
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">{t('tax.portfolioTitle')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('tax.portfolioDesc')}</p>
        </div>
        <WidgetVisibilityDialog
          widgets={widgetDefs}
          isVisible={isVisible}
          setWidgetVisible={setWidgetVisible}
          setAllVisible={setAllVisible}
          resetToDefaults={resetToDefaults}
        />
      </div>
      {isEmpty ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Landmark className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-1">{t('tax.noData')}</h3>
            <p className="text-muted-foreground text-sm max-w-sm">{t('tax.noDataDesc')}</p>
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
            {/* Tax by Asset Class */}
            {isVisible('taxByAssetClass') && taxByAssetClass.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('tax.widget.taxByAssetClass')}</CardTitle>
                  <CardDescription>{t('tax.taxByAssetClassDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={taxByAssetClass}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="name" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "var(--radius)", color: "hsl(var(--card-foreground))" }}
                        formatter={(v: number) => fmt(v)}
                      />
                      <Bar dataKey="taxes" name={t('tax.taxes')} fill="hsl(340, 82%, 52%)" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="fees" name={t('tax.fees')} fill="hsl(45, 93%, 47%)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
            {/* Tax Type Breakdown */}
            {isVisible('taxTypes') && (taxBreakdown.length > 0 || feeBreakdown.length > 0) && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('tax.widget.taxTypes')}</CardTitle>
                  <CardDescription>{t('tax.taxTypesDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {taxBreakdown.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold text-foreground mb-2">{t('tax.taxes')}</h4>
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
                      <h4 className="text-sm font-semibold text-foreground mb-2">{t('tax.fees')}</h4>
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
                  {/* Gains context */}
                  <div className="pt-2 border-t border-border">
                    <h4 className="text-sm font-semibold text-foreground mb-2">{t('tax.gainsContext')}</h4>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center py-1.5">
                        <span className="text-sm text-muted-foreground">{t('portfolio.realizedGains')}</span>
                        <span className={cn("text-sm font-semibold tabular-nums", totalRealizedGain >= 0 ? "text-accent" : "text-destructive")}>
                          {totalRealizedGain >= 0 ? '+' : ''}{fmt(totalRealizedGain)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center py-1.5">
                        <span className="text-sm text-muted-foreground">{t('portfolio.unrealizedGains')}</span>
                        <span className={cn("text-sm font-semibold tabular-nums", totalUnrealizedGain >= 0 ? "text-accent" : "text-destructive")}>
                          {totalUnrealizedGain >= 0 ? '+' : ''}{fmt(totalUnrealizedGain)}
                        </span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
          {/* Per-Investment Breakdown */}
          {isVisible('investmentBreakdown') && investmentBreakdown.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t('tax.widget.investmentBreakdown')}</CardTitle>
                <CardDescription>{t('tax.investmentBreakdownDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {investmentBreakdown.map((inv) => (
                    <div key={inv.id} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {inv.symbol && <span className="font-mono font-bold text-sm">{inv.symbol}</span>}
                          <span className="font-medium text-sm truncate">{inv.name}</span>
                          <Badge variant="secondary" className="text-[10px] shrink-0">{inv.assetClass}</Badge>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span>{t('tax.taxes')}: {fmt(inv.taxes, inv.currency)}</span>
                          <span>{t('tax.fees')}: {fmt(inv.fees, inv.currency)}</span>
                          {inv.realizedGain !== 0 && (
                            <span className={inv.realizedGain >= 0 ? "text-accent" : "text-destructive"}>
                              {t('tax.realized')}: {inv.realizedGain >= 0 ? '+' : ''}{fmt(inv.realizedGain, inv.currency)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-bold text-sm tabular-nums text-destructive">{fmt(inv.total, inv.currency)}</p>
                        <p className="text-xs text-muted-foreground">{t('tax.totalCosts')}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
