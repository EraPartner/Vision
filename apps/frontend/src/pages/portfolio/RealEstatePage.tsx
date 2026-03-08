import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, Trash2 } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

function fmt(val: number, currency = 'EUR', decimals = 0) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(val);
}

export default function RealEstatePage() {
  const { byAssetClass, deleteInvestment } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const properties = byAssetClass('real_estate');

  const totalValue = properties.reduce((s, p) => s + p.currentValue, 0);
  const totalCost = properties.reduce((s, p) => s + p.totalInvested, 0);
  const monthlyRent = properties.reduce((s, p) => {
    const rentTxns = p.transactions.filter(t => t.type === 'rent_income');
    if (rentTxns.length === 0) return s;
    // Estimate monthly from last rent entry
    return s + (rentTxns[0]?.amount ?? 0);
  }, 0);
  const annualYield = totalValue > 0 ? (monthlyRent * 12) / totalValue * 100 : 0;

  if (properties.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground">Real Estate</h1>
          <AddInvestmentDialog />
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Building2 className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-1">No properties</h3>
            <p className="text-muted-foreground text-sm mb-4">Add your first property to track real estate investments.</p>
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
        <h1 className="text-3xl font-bold text-foreground">Real Estate</h1>
        <AddInvestmentDialog />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Value</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-primary">{fmt(totalValue)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Appreciation</CardTitle></CardHeader>
          <CardContent>
            <p className={cn("text-2xl font-bold", totalValue - totalCost >= 0 ? "text-accent" : "text-destructive")}>
              +{fmt(totalValue - totalCost)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Monthly Rent</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-accent">{fmt(monthlyRent)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Annual Yield</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-foreground">{annualYield.toFixed(1)}%</p></CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {properties.map((p) => (
          <Card key={p.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">{p.name}</CardTitle>
                    {p.location && <CardDescription>{p.location}</CardDescription>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <AddPortfolioTxnDialog investment={p} />
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={async () => { const ok = await confirm({ title: "Delete Property", description: `Are you sure you want to delete "${p.name}"? This action cannot be undone.`, confirmLabel: "Delete", variant: "destructive" }); if (ok) deleteInvestment(p.id); }}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><p className="text-muted-foreground">Purchase Price</p><p className="font-medium tabular-nums">{fmt(p.totalInvested, p.currency)}</p></div>
                <div><p className="text-muted-foreground">Current Value</p><p className="font-medium tabular-nums">{fmt(p.currentValue, p.currency)}</p></div>
                <div><p className="text-muted-foreground">Rent Income</p><p className="font-medium tabular-nums text-accent">+{fmt(p.totalIncome, p.currency)}</p></div>
                <div><p className="text-muted-foreground">Fees & Taxes</p><p className="font-medium tabular-nums text-destructive">-{fmt(p.totalFees + p.totalTaxes, p.currency)}</p></div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
    <ConfirmDialog />
    </>
  );
}
