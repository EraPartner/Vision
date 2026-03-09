import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { PiggyBank, Shield, Trash2, Eye, Percent, TrendingUp, Calendar, DollarSign } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { cn } from "@/lib/utils";

function fmt(val: number, currency = 'EUR', decimals = 2) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(val);
}

function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now = new Date();
  const diff = Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

export default function SavingsPage() {
  const { byAssetClass, deleteInvestment } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const accounts = byAssetClass(['savings', 'bond']);

  const totalBalance = accounts.reduce((s, a) => s + a.currentValue, 0);
  const totalInterestEarned = accounts.reduce((s, a) => s + a.totalIncome, 0);
  const totalProjectedAnnual = accounts.reduce((s, a) => s + a.projectedAnnualInterest, 0);
  const totalAccrued = accounts.reduce((s, a) => s + a.accruedInterest, 0);
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
            <h3 className="text-lg font-semibold mb-1">No savings accounts or bonds</h3>
            <p className="text-muted-foreground text-sm mb-4">
              Track fixed-income investments with interest rate calculations, maturity dates, and projected returns.
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
        <h1 className="text-3xl font-bold text-foreground">Savings & Bonds</h1>
        <AddInvestmentDialog />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-3 w-3" /> Total Balance
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-primary tabular-nums">{fmt(totalBalance)}</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Percent className="h-3 w-3" /> Avg Interest Rate
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-accent tabular-nums">{weightedRate.toFixed(2)}%</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Interest Earned
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-accent tabular-nums">+{fmt(totalInterestEarned)}</p>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-primary">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">Projected Annual</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-primary tabular-nums">+{fmt(totalProjectedAnnual)}</p>
            {totalAccrued > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">{fmt(totalAccrued)} accrued</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Account Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {accounts.map((a) => {
          const daysToMaturity = daysUntil(a.maturityDate);
          const isMaturingSoon = daysToMaturity !== null && daysToMaturity <= 30 && daysToMaturity > 0;
          const isMatured = daysToMaturity !== null && daysToMaturity <= 0;
          
          return (
            <Card key={a.id} className={cn(
              "transition-all hover:shadow-md",
              isMatured && "border-accent",
              isMaturingSoon && "border-primary"
            )}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "h-10 w-10 rounded-lg flex items-center justify-center",
                      a.assetClass === 'savings' ? "bg-primary/10" : "bg-accent/10"
                    )}>
                      {a.assetClass === 'savings'
                        ? <PiggyBank className="h-5 w-5 text-primary" />
                        : <Shield className="h-5 w-5 text-accent" />
                      }
                    </div>
                    <div>
                      <CardTitle className="text-base">{a.name}</CardTitle>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="secondary" className="text-xs">
                          {a.assetClass === 'savings' ? 'Savings' : 'Bond'}
                        </Badge>
                        {a.interestRate && (
                          <span className="text-xs font-medium text-accent">{a.interestRate}% p.a.</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <InvestmentDetailDialog 
                      investment={a} 
                      trigger={
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Eye className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <AddPortfolioTxnDialog investment={a} />
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={async () => { 
                        const ok = await confirm({ 
                          title: "Delete Account", 
                          description: `Delete "${a.name}"? All transaction history will be removed.`, 
                          confirmLabel: "Delete", 
                          variant: "destructive" 
                        }); 
                        if (ok) deleteInvestment(a.id); 
                      }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              
              <CardContent className="space-y-4">
                {/* Balance & Interest */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Current Balance</p>
                    <p className="text-2xl font-bold tabular-nums">{fmt(a.currentValue, a.currency)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground mb-1">Interest Earned</p>
                    <p className="text-2xl font-bold text-accent tabular-nums">+{fmt(a.totalIncome, a.currency)}</p>
                  </div>
                </div>
                
                {/* Projections for fixed income */}
                {a.interestRate && a.projectedAnnualInterest > 0 && (
                  <div className="p-3 rounded-lg bg-muted/50 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Projected Annual Interest</span>
                      <span className="font-medium text-primary">+{fmt(a.projectedAnnualInterest, a.currency)}</span>
                    </div>
                    {a.accruedInterest > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Accrued (Unpaid)</span>
                        <span className="font-medium text-accent">+{fmt(a.accruedInterest, a.currency)}</span>
                      </div>
                    )}
                  </div>
                )}
                
                {/* Maturity Date for bonds */}
                {a.maturityDate && (
                  <div className={cn(
                    "flex items-center justify-between p-3 rounded-lg",
                    isMatured ? "bg-accent/10" : isMaturingSoon ? "bg-primary/10" : "bg-muted/50"
                  )}>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">
                        {isMatured ? 'Matured' : 'Matures'}
                      </span>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">
                        {new Date(a.maturityDate).toLocaleDateString('en-US', { 
                          month: 'short', day: 'numeric', year: 'numeric' 
                        })}
                      </p>
                      {!isMatured && daysToMaturity !== null && (
                        <p className={cn(
                          "text-xs",
                          isMaturingSoon ? "text-primary" : "text-muted-foreground"
                        )}>
                          {daysToMaturity} days remaining
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Cost Breakdown */}
                {(a.totalFees > 0 || a.totalTaxes > 0) && (
                  <div className="flex justify-between text-sm border-t border-border pt-3">
                    <span className="text-muted-foreground">Fees & Taxes Paid</span>
                    <span className="font-medium text-destructive">-{fmt(a.totalFees + a.totalTaxes, a.currency)}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Info Card */}
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">
            <strong>How it works:</strong> Set an interest rate when creating the account. 
            Record interest payments as "Interest" transactions when received. 
            Projected annual interest is calculated from current balance × rate.
          </p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
