import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, DollarSign, PieChart as PieChartIcon, Trash2, RefreshCw, Loader2, ArrowUpRight, Clock } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { PortfolioNewsFeed } from "@/components/portfolio/PortfolioNewsFeed";
import { ASSET_CLASS_GROUPS, ASSET_CLASS_LABELS } from "@/types/portfolio";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useMemo } from "react";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";

const PORTFOLIO_WIDGETS: WidgetDefinition[] = [
  { id: "summaryCards",    label: "Summary Cards",       defaultVisible: true },
  { id: "allocation",      label: "Asset Allocation",    defaultVisible: true },
  { id: "performance",     label: "Performance Summary", defaultVisible: true },
  { id: "investments",     label: "All Investments",     defaultVisible: true },
  { id: "news",            label: "News Feed",           defaultVisible: true },
];

const COLORS = [
  "hsl(217, 91%, 60%)", "hsl(142, 76%, 36%)", "hsl(45, 93%, 47%)",
  "hsl(280, 87%, 65%)", "hsl(340, 82%, 52%)", "hsl(200, 80%, 50%)",
];

function fmt(val: number, currency = 'EUR') {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val);
}

export default function PortfolioOverviewPage() {
  const {
    summaries, totalPortfolioValue, totalGainLoss,
    totalRealizedGain, totalUnrealizedGain,
    deleteInvestment, refreshPrices, isRefreshingPrices
  } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } = useWidgetVisibility('portfolio', PORTFOLIO_WIDGETS);

  const totalInvested = summaries.reduce((s, i) => s + i.totalBuyCost, 0);
  const totalIncome = summaries.reduce((s, i) => s + i.totalIncome, 0);
  const gainPercent = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;

  const newsSymbols = useMemo(() =>
    summaries
      .filter(s => s.symbol)
      .map(s => s.symbol!)
      .slice(0, 10),
    [summaries]
  );

  const allocationData = Object.entries(ASSET_CLASS_GROUPS).map(([group, classes]) => ({
    name: group,
    value: summaries.filter(s => classes.includes(s.assetClass)).reduce((sum, s) => sum + s.currentValue, 0),
  })).filter(d => d.value > 0);

  const cards = [
    {
      title: "Total Value",
      value: fmt(totalPortfolioValue),
      icon: DollarSign,
      desc: `${summaries.length} investments`,
      cls: "text-primary"
    },
    {
      title: "Total Gain/Loss",
      value: `${totalGainLoss >= 0 ? '+' : ''}${fmt(totalGainLoss)}`,
      icon: totalGainLoss >= 0 ? TrendingUp : TrendingDown,
      desc: `${gainPercent >= 0 ? '+' : ''}${gainPercent.toFixed(1)}% all time`,
      cls: totalGainLoss >= 0 ? "text-accent" : "text-destructive"
    },
    {
      title: "Realized Gains",
      value: `${totalRealizedGain >= 0 ? '+' : ''}${fmt(totalRealizedGain)}`,
      icon: ArrowUpRight,
      desc: "From closed positions",
      cls: totalRealizedGain >= 0 ? "text-accent" : "text-destructive"
    },
    {
      title: "Unrealized Gains",
      value: `${totalUnrealizedGain >= 0 ? '+' : ''}${fmt(totalUnrealizedGain)}`,
      icon: Clock,
      desc: "Paper profit/loss",
      cls: totalUnrealizedGain >= 0 ? "text-accent" : "text-destructive"
    },
  ];

  const isEmpty = summaries.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Portfolio Overview</h1>
        <div className="flex items-center gap-2">
          <WidgetVisibilityDialog
            widgets={widgetDefs}
            isVisible={isVisible}
            setWidgetVisible={setWidgetVisible}
            setAllVisible={setAllVisible}
            resetToDefaults={resetToDefaults}
          />
          <Button size="sm" variant="outline" className="gap-1.5" onClick={refreshPrices} disabled={isRefreshingPrices}>
            {isRefreshingPrices ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh Prices
          </Button>
          <AddInvestmentDialog />
        </div>
      </div>

      {isEmpty ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <PieChartIcon className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-1">No investments yet</h3>
            <p className="text-muted-foreground text-sm mb-4 max-w-sm">
              Add your first investment to start tracking stocks, ETFs, crypto, real estate, or savings.
            </p>
            <AddInvestmentDialog />
          </CardContent>
        </Card>
      ) : (
        <>
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
            {isVisible('allocation') && allocationData.length > 0 && (
              <Card>
                <CardHeader><CardTitle>Asset Allocation</CardTitle><CardDescription>By asset class</CardDescription></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie data={allocationData} cx="50%" cy="50%" outerRadius={100} innerRadius={50} dataKey="value"
                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={{ strokeWidth: 1 }}>
                        {allocationData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "var(--radius)", color: "hsl(var(--card-foreground))" }} formatter={(v: number) => fmt(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {isVisible('performance') && (
              <Card>
                <CardHeader><CardTitle>Performance Summary</CardTitle><CardDescription>Gains, income & costs</CardDescription></CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {[
                      { label: 'Total Invested', value: totalInvested, cls: 'text-foreground' },
                      { label: 'Current Value', value: totalPortfolioValue, cls: 'text-foreground' },
                      { label: 'Realized Gains', value: totalRealizedGain, cls: totalRealizedGain >= 0 ? 'text-accent' : 'text-destructive', showSign: true },
                      { label: 'Unrealized Gains', value: totalUnrealizedGain, cls: totalUnrealizedGain >= 0 ? 'text-accent' : 'text-destructive', showSign: true },
                      { label: 'Total Income', value: totalIncome, cls: 'text-accent', showSign: true },
                      { label: 'Total Fees', value: -summaries.reduce((s, i) => s + i.totalFees, 0), cls: 'text-destructive' },
                      { label: 'Total Taxes', value: -summaries.reduce((s, i) => s + i.totalTaxes, 0), cls: 'text-destructive' },
                    ].map(({ label, value, cls, showSign }) => (
                      <div key={label} className="flex justify-between items-center py-2 border-b border-border/50 last:border-0">
                        <span className="text-sm text-muted-foreground">{label}</span>
                        <span className={cn("text-sm font-semibold tabular-nums", cls)}>
                          {showSign && value > 0 ? '+' : ''}{fmt(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {isVisible('investments') && (
              <div className={isVisible('news') && newsSymbols.length > 0 ? "lg:col-span-2" : "lg:col-span-3"}>
                <Card>
                  <CardHeader><CardTitle>All Investments</CardTitle></CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {summaries.map((inv) => {
                        const isUnitBased = ['stock', 'etf', 'crypto'].includes(inv.assetClass);
                        return (
                          <div key={inv.id} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {inv.symbol && <span className="font-mono font-bold text-sm">{inv.symbol}</span>}
                                <span className="font-medium text-sm truncate">{inv.name}</span>
                                <Badge variant="secondary" className="text-[10px] shrink-0">{ASSET_CLASS_LABELS[inv.assetClass]}</Badge>
                              </div>
                              <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                                <span>Cost: {fmt(inv.totalBuyCost, inv.currency)}</span>
                                {isUnitBased && inv.totalUnits > 0 && (
                                  <span>{inv.totalUnits.toFixed(4)} units @ {fmt(inv.avgCostBasis, inv.currency)}/ea</span>
                                )}
                                {inv.totalIncome > 0 && <span className="text-accent">Income: +{fmt(inv.totalIncome, inv.currency)}</span>}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="font-bold text-sm tabular-nums">{fmt(inv.currentValue, inv.currency)}</p>
                              <p className={cn("text-xs tabular-nums font-medium", inv.totalGain >= 0 ? "text-accent" : "text-destructive")}>
                                {inv.totalGain >= 0 ? '+' : ''}{fmt(inv.totalGain, inv.currency)} ({inv.gainLossPercent >= 0 ? '+' : ''}{inv.gainLossPercent.toFixed(1)}%)
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <InvestmentDetailDialog investment={inv} />
                              <AddPortfolioTxnDialog investment={inv} />
                              <Button
                                variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                onClick={async () => {
                                  const ok = await confirm({
                                    title: "Delete Investment",
                                    description: `Are you sure you want to delete "${inv.name}" and all its transactions? This action cannot be undone.`,
                                    confirmLabel: "Delete",
                                    variant: "destructive",
                                  });
                                  if (ok) deleteInvestment(inv.id);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
            {isVisible('news') && newsSymbols.length > 0 && (
              <div className="lg:col-span-1">
                <PortfolioNewsFeed symbols={newsSymbols} />
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmDialog />
    </div>
  );
}
