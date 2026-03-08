import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, Trash2, Bitcoin } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { cn } from "@/lib/utils";

function fmt(val: number, currency = 'EUR') {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(val);
}

export default function CryptoPage() {
  const { byAssetClass, deleteInvestment } = usePortfolio();
  const holdings = byAssetClass('crypto');

  const totalValue = holdings.reduce((s, h) => s + h.currentValue, 0);
  const totalCost = holdings.reduce((s, h) => s + h.totalInvested, 0);
  const totalGain = totalValue - totalCost;

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
            <p className="text-muted-foreground text-sm mb-4">Add your first cryptocurrency to start tracking.</p>
            <AddInvestmentDialog />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Cryptocurrency</h1>
        <AddInvestmentDialog />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Value</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-primary">{fmt(totalValue)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Gain/Loss</CardTitle></CardHeader>
          <CardContent>
            <p className={cn("text-2xl font-bold", totalGain >= 0 ? "text-accent" : "text-destructive")}>
              {totalGain >= 0 ? "+" : ""}{fmt(totalGain)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Assets</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-foreground">{holdings.length}</p></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Holdings</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['Asset', 'Units', 'Avg Price', 'Current', 'Value', 'P&L', ''].map(h => (
                    <th key={h} className={cn("py-2 px-3 font-medium text-muted-foreground", h !== 'Asset' ? 'text-right' : 'text-left')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => {
                  const avgPrice = h.totalUnits > 0 ? h.totalInvested / h.totalUnits : 0;
                  return (
                    <tr key={h.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                      <td className="py-2 px-3">
                        <span className="font-mono font-bold">{h.symbol || '?'}</span>{' '}
                        <span className="text-muted-foreground">{h.name}</span>
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums">{h.totalUnits.toFixed(6)}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{fmt(avgPrice, h.currency)}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{fmt(h.currentPrice ?? 0, h.currency)}</td>
                      <td className="text-right py-2 px-3 tabular-nums font-medium">{fmt(h.currentValue, h.currency)}</td>
                      <td className={cn("text-right py-2 px-3 tabular-nums font-medium", h.gainLoss >= 0 ? "text-accent" : "text-destructive")}>
                        {h.gainLoss >= 0 ? "+" : ""}{fmt(h.gainLoss, h.currency)}
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-1 justify-end">
                          <AddPortfolioTxnDialog investment={h} />
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={async () => { const ok = await confirm({ title: "Delete Investment", description: `Are you sure you want to delete "${h.name}"? This action cannot be undone.`, confirmLabel: "Delete", variant: "destructive" }); if (ok) deleteInvestment(h.id); }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
