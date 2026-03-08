import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, DollarSign, PieChart as PieChartIcon, Trash2, RefreshCw, Loader2 } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { ASSET_CLASS_GROUPS, ASSET_CLASS_LABELS } from "@/types/portfolio";
import { cn } from "@/lib/utils";

const COLORS = [
  "hsl(217, 91%, 60%)", "hsl(142, 76%, 36%)", "hsl(45, 93%, 47%)",
  "hsl(280, 87%, 65%)", "hsl(340, 82%, 52%)", "hsl(200, 80%, 50%)",
];

function fmt(val: number, currency = 'EUR') {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val);
}

export default function PortfolioOverviewPage() {
  const { summaries, totalPortfolioValue, totalGainLoss, deleteInvestment, refreshPrices, isRefreshingPrices } = usePortfolio();

  const totalInvested = summaries.reduce((s, i) => s + i.totalInvested, 0);
  const gainPercent = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;

  // Allocation by group
  const allocationData = Object.entries(ASSET_CLASS_GROUPS).map(([group, classes]) => ({
    name: group,
    value: summaries.filter(s => classes.includes(s.assetClass)).reduce((sum, s) => sum + s.currentValue, 0),
  })).filter(d => d.value > 0);

  const cards = [
    { title: "Total Value", value: fmt(totalPortfolioValue), icon: DollarSign, desc: `${summaries.length} investments`, cls: "text-primary" },
    { title: "Total Gain/Loss", value: `${totalGainLoss >= 0 ? '+' : ''}${fmt(totalGainLoss)}`, icon: totalGainLoss >= 0 ? TrendingUp : TrendingDown, desc: `${gainPercent >= 0 ? '+' : ''}${gainPercent.toFixed(1)}% all time`, cls: totalGainLoss >= 0 ? "text-accent" : "text-destructive" },
    { title: "Total Invested", value: fmt(totalInvested), icon: DollarSign, desc: "Cost basis", cls: "text-foreground" },
    { title: "Total Income", value: `+${fmt(summaries.reduce((s, i) => s + i.totalIncome, 0))}`, icon: TrendingUp, desc: "Dividends, interest, rent", cls: "text-accent" },
  ];

  const isEmpty = summaries.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Portfolio Overview</h1>
        <div className="flex items-center gap-2">
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {allocationData.length > 0 && (
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

            <Card>
              <CardHeader><CardTitle>Cost Breakdown</CardTitle><CardDescription>Fees & taxes across portfolio</CardDescription></CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {[
                    { label: 'Total Fees Paid', value: summaries.reduce((s, i) => s + i.totalFees, 0), cls: 'text-destructive' },
                    { label: 'Total Taxes Paid', value: summaries.reduce((s, i) => s + i.totalTaxes, 0), cls: 'text-destructive' },
                    { label: 'Total Dividends', value: summaries.reduce((s, i) => s + i.totalDividends, 0), cls: 'text-accent' },
                    { label: 'Net Income', value: summaries.reduce((s, i) => s + i.totalIncome - i.totalFees - i.totalTaxes, 0) },
                  ].map(({ label, value, cls }) => (
                    <div key={label} className="flex justify-between items-center py-2 border-b border-border/50 last:border-0">
                      <span className="text-sm text-muted-foreground">{label}</span>
                      <span className={cn("text-sm font-semibold tabular-nums", cls ?? (value >= 0 ? 'text-accent' : 'text-destructive'))}>
                        {value >= 0 ? '+' : ''}{fmt(value)}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* All investments list */}
          <Card>
            <CardHeader><CardTitle>All Investments</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-2">
                {summaries.map((inv) => (
                  <div key={inv.id} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {inv.symbol && <span className="font-mono font-bold text-sm">{inv.symbol}</span>}
                        <span className="font-medium text-sm truncate">{inv.name}</span>
                        <Badge variant="secondary" className="text-[10px] shrink-0">{ASSET_CLASS_LABELS[inv.assetClass]}</Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>Invested: {fmt(inv.totalInvested, inv.currency)}</span>
                        {inv.totalUnits > 0 && <span>{inv.totalUnits.toFixed(4)} units</span>}
                        {inv.totalIncome > 0 && <span className="text-accent">Income: +{fmt(inv.totalIncome, inv.currency)}</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-sm tabular-nums">{fmt(inv.currentValue, inv.currency)}</p>
                      <p className={cn("text-xs tabular-nums font-medium", inv.gainLoss >= 0 ? "text-accent" : "text-destructive")}>
                        {inv.gainLoss >= 0 ? '+' : ''}{fmt(inv.gainLoss, inv.currency)} ({inv.gainLossPercent >= 0 ? '+' : ''}{inv.gainLossPercent.toFixed(1)}%)
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <AddPortfolioTxnDialog investment={inv} />
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => { if (confirm(`Delete "${inv.name}" and all its transactions?`)) deleteInvestment(inv.id); }}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
