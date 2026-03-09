import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, Trash2, Bitcoin, Eye, DollarSign, ArrowUpRight } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

function fmt(val: number, currency = 'EUR', decimals = 2) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(val);
}

function fmtPct(val: number) {
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
}

export default function CryptoPage() {
  const { byAssetClass, deleteInvestment } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const holdings = byAssetClass('crypto');

  const totalValue = holdings.reduce((s, h) => s + h.currentValue, 0);
  const totalRealizedGain = holdings.reduce((s, h) => s + h.realizedGain, 0);
  const totalUnrealizedGain = holdings.reduce((s, h) => s + h.unrealizedGain, 0);
  const totalFees = holdings.reduce((s, h) => s + h.totalFees, 0);
  const totalTaxes = holdings.reduce((s, h) => s + h.totalTaxes, 0);
  const netGain = totalRealizedGain + totalUnrealizedGain - totalFees - totalTaxes;

  if (holdings.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground">Cryptocurrency</h1>
          <AddInvestmentDialog />
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Bitcoin className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-1">No crypto assets</h3>
            <p className="text-muted-foreground text-sm mb-4">
              Track your crypto with live prices, weighted average cost, and capital gains calculations.
            </p>
            <AddInvestmentDialog />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Cryptocurrency</h1>
        <AddInvestmentDialog />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-3 w-3" /> Portfolio Value
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-primary tabular-nums">{fmt(totalValue)}</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <ArrowUpRight className="h-3 w-3" /> Realized P&L
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className={cn("text-xl font-bold tabular-nums", totalRealizedGain >= 0 ? "text-accent" : "text-destructive")}>
              {totalRealizedGain >= 0 ? "+" : ""}{fmt(totalRealizedGain)}
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Unrealized P&L
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className={cn("text-xl font-bold tabular-nums", totalUnrealizedGain >= 0 ? "text-accent" : "text-destructive")}>
              {totalUnrealizedGain >= 0 ? "+" : ""}{fmt(totalUnrealizedGain)}
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">Fees & Taxes</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-destructive tabular-nums">-{fmt(totalFees + totalTaxes)}</p>
          </CardContent>
        </Card>
        
        <Card className={cn("border-l-4", netGain >= 0 ? "border-l-accent" : "border-l-destructive")}>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">Net Return</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className={cn("text-xl font-bold tabular-nums", netGain >= 0 ? "text-accent" : "text-destructive")}>
              {netGain >= 0 ? "+" : ""}{fmt(netGain)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Holdings Table */}
      <Card>
        <CardHeader><CardTitle>Holdings</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 px-3 text-left font-medium text-muted-foreground">Asset</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">Units</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">Avg Cost</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">Price</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">Value</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">Unrealized</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">Realized</th>
                  <th className="py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors group">
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <Bitcoin className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <span className="font-mono font-bold">{h.symbol || '?'}</span>
                          <p className="text-xs text-muted-foreground">{h.name}</p>
                        </div>
                      </div>
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums font-mono">{h.totalUnits.toFixed(6)}</td>
                    <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">{fmt(h.avgCostBasis, h.currency)}</td>
                    <td className="text-right py-2 px-3 tabular-nums">{fmt(h.currentPrice ?? 0, h.currency)}</td>
                    <td className="text-right py-2 px-3 tabular-nums font-medium">{fmt(h.currentValue, h.currency)}</td>
                    <td className={cn("text-right py-2 px-3 tabular-nums font-medium", h.unrealizedGain >= 0 ? "text-accent" : "text-destructive")}>
                      {h.unrealizedGain >= 0 ? "+" : ""}{fmt(h.unrealizedGain, h.currency)}
                      <span className="text-xs ml-1 opacity-70">{fmtPct(h.gainLossPercent)}</span>
                    </td>
                    <td className={cn("text-right py-2 px-3 tabular-nums", h.realizedGain !== 0 ? (h.realizedGain >= 0 ? "text-accent" : "text-destructive") : "text-muted-foreground")}>
                      {h.realizedGain !== 0 ? `${h.realizedGain >= 0 ? "+" : ""}${fmt(h.realizedGain, h.currency)}` : '—'}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <InvestmentDetailDialog 
                          investment={h} 
                          trigger={
                            <Button variant="ghost" size="icon" className="h-7 w-7">
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          }
                        />
                        <AddPortfolioTxnDialog investment={h} />
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={async () => { 
                            const ok = await confirm({ 
                              title: "Delete Asset", 
                              description: `Delete "${h.name}"? All transactions will be removed.`, 
                              confirmLabel: "Delete", 
                              variant: "destructive" 
                            }); 
                            if (ok) deleteInvestment(h.id); 
                          }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Info Card */}
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">
            <strong>How it works:</strong> Cost basis uses weighted average of all purchases. 
            When you sell, realized gains are calculated based on average cost. Track fees per transaction for tax reporting.
          </p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
