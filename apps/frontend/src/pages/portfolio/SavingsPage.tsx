import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PiggyBank, Shield, Trash2 } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

function fmt(val: number, currency = 'EUR') {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(val);
}

export default function SavingsPage() {
  const { byAssetClass, deleteInvestment } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const accounts = byAssetClass(['savings', 'bond']);

  const totalBalance = accounts.reduce((s, a) => s + a.currentValue, 0);
  const totalInterest = accounts.reduce((s, a) => s + a.totalIncome, 0);
  const weightedRate = totalBalance > 0
    ? accounts.reduce((s, a) => s + (a.interestRate ?? 0) * a.currentValue, 0) / totalBalance
    : 0;

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground">Savings & Bonds</h1>
          <AddInvestmentDialog />
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <PiggyBank className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-1">No savings accounts</h3>
            <p className="text-muted-foreground text-sm mb-4">Add a savings account or bond to start tracking.</p>
            <AddInvestmentDialog />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Savings & Bonds</h1>
        <AddInvestmentDialog />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Balance</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-primary">{fmt(totalBalance)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Avg Interest Rate</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-accent">{weightedRate.toFixed(2)}%</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total Interest Earned</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-bold text-accent">+{fmt(totalInterest)}</p></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Accounts</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-3">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between p-4 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    {a.assetClass === 'savings'
                      ? <PiggyBank className="h-5 w-5 text-primary" />
                      : <Shield className="h-5 w-5 text-primary" />
                    }
                  </div>
                  <div>
                    <p className="font-medium">{a.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="secondary" className="text-xs">{a.assetClass === 'savings' ? 'Savings' : 'Bond'}</Badge>
                      {a.interestRate && <span className="text-xs text-accent">{a.interestRate}% p.a.</span>}
                      {a.maturityDate && <span className="text-xs text-muted-foreground">Matures: {a.maturityDate}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="font-bold tabular-nums">{fmt(a.currentValue, a.currency)}</p>
                    {a.totalIncome > 0 && <p className="text-xs text-accent">+{fmt(a.totalIncome, a.currency)} earned</p>}
                  </div>
                  <AddPortfolioTxnDialog investment={a} />
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={async () => { const ok = await confirm({ title: "Delete Account", description: `Are you sure you want to delete "${a.name}"? This action cannot be undone.`, confirmLabel: "Delete", variant: "destructive" }); if (ok) deleteInvestment(a.id); }}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
