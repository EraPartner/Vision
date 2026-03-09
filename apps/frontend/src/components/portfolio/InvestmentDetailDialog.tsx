import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  TrendingUp, TrendingDown, Eye, Trash2, Calendar, 
  DollarSign, Percent, ArrowUpRight, ArrowDownRight, Clock
} from 'lucide-react';
import { usePortfolio } from '@/hooks/usePortfolio';
import { AddPortfolioTxnDialog } from './AddPortfolioTxnDialog';
import type { InvestmentSummary, PortfolioTxnType } from '@/types/portfolio';
import { TXN_TYPE_LABELS, ASSET_CLASS_LABELS } from '@/types/portfolio';
import { cn } from '@/lib/utils';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';

interface Props {
  investment: InvestmentSummary;
  trigger?: React.ReactNode;
}

function fmt(val: number, currency = 'EUR', decimals = 0) {
  return new Intl.NumberFormat('en-US', { 
    style: 'currency', 
    currency, 
    minimumFractionDigits: decimals, 
    maximumFractionDigits: decimals 
  }).format(val);
}

function fmtNum(val: number, decimals = 2) {
  return new Intl.NumberFormat('en-US', { 
    minimumFractionDigits: decimals, 
    maximumFractionDigits: decimals 
  }).format(val);
}

const TXN_TYPE_COLORS: Record<PortfolioTxnType, string> = {
  buy: 'bg-accent/10 text-accent border-accent/20',
  sell: 'bg-destructive/10 text-destructive border-destructive/20',
  dividend: 'bg-primary/10 text-primary border-primary/20',
  interest: 'bg-primary/10 text-primary border-primary/20',
  rent_income: 'bg-accent/10 text-accent border-accent/20',
  fee: 'bg-muted text-muted-foreground border-border',
  tax: 'bg-muted text-muted-foreground border-border',
  appreciation: 'bg-accent/10 text-accent border-accent/20',
};

export function InvestmentDetailDialog({ investment, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const { deleteTransaction } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  
  const isUnitBased = ['stock', 'etf', 'crypto'].includes(investment.assetClass);
  const isFixedIncome = ['savings', 'bond'].includes(investment.assetClass);
  const isRealEstate = investment.assetClass === 'real_estate';

  const handleDeleteTxn = async (txnId: number, txnType: string) => {
    const ok = await confirm({
      title: 'Delete Transaction',
      description: `Delete this ${txnType} transaction? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (ok) deleteTransaction(txnId);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          {trigger ?? (
            <Button size="sm" variant="ghost" className="gap-1.5">
              <Eye className="h-4 w-4" /> Details
            </Button>
          )}
        </DialogTrigger>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-2">
              {investment.symbol && (
                <span className="font-mono font-bold text-lg">{investment.symbol}</span>
              )}
              <DialogTitle className="text-xl">{investment.name}</DialogTitle>
              <Badge variant="secondary">{ASSET_CLASS_LABELS[investment.assetClass]}</Badge>
            </div>
          </DialogHeader>

          <Tabs defaultValue="overview" className="mt-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="overview">Performance</TabsTrigger>
              <TabsTrigger value="transactions">
                Transactions ({investment.transactions.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4 mt-4">
              {/* Key Metrics */}
              <div className="grid grid-cols-2 gap-3">
                <Card>
                  <CardContent className="pt-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                      <DollarSign className="h-4 w-4" />
                      Current Value
                    </div>
                    <p className="text-2xl font-bold tabular-nums">
                      {fmt(investment.currentValue, investment.currency)}
                    </p>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardContent className="pt-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                      {investment.totalGain >= 0 ? (
                        <TrendingUp className="h-4 w-4 text-accent" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-destructive" />
                      )}
                      Total Gain/Loss
                    </div>
                    <p className={cn(
                      "text-2xl font-bold tabular-nums",
                      investment.totalGain >= 0 ? "text-accent" : "text-destructive"
                    )}>
                      {investment.totalGain >= 0 ? '+' : ''}{fmt(investment.totalGain, investment.currency)}
                    </p>
                    <p className={cn(
                      "text-sm tabular-nums",
                      investment.gainLossPercent >= 0 ? "text-accent" : "text-destructive"
                    )}>
                      {investment.gainLossPercent >= 0 ? '+' : ''}{fmtNum(investment.gainLossPercent)}%
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* Detailed Breakdown */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Investment Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="space-y-2">
                      <div className="flex justify-between py-1.5 border-b border-border/50">
                        <span className="text-muted-foreground">Total Cost</span>
                        <span className="font-medium tabular-nums">{fmt(investment.totalBuyCost, investment.currency)}</span>
                      </div>
                      
                      {isUnitBased && (
                        <>
                          <div className="flex justify-between py-1.5 border-b border-border/50">
                            <span className="text-muted-foreground">Units Held</span>
                            <span className="font-medium tabular-nums">{fmtNum(investment.totalUnits, 4)}</span>
                          </div>
                          <div className="flex justify-between py-1.5 border-b border-border/50">
                            <span className="text-muted-foreground">Avg Cost/Unit</span>
                            <span className="font-medium tabular-nums">{fmt(investment.avgCostBasis, investment.currency, 2)}</span>
                          </div>
                          {investment.currentPrice && (
                            <div className="flex justify-between py-1.5 border-b border-border/50">
                              <span className="text-muted-foreground">Current Price</span>
                              <span className="font-medium tabular-nums">{fmt(investment.currentPrice, investment.currency, 2)}</span>
                            </div>
                          )}
                        </>
                      )}
                      
                      {isFixedIncome && investment.interestRate && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground">Interest Rate</span>
                          <span className="font-medium tabular-nums">{fmtNum(investment.interestRate)}%</span>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between py-1.5 border-b border-border/50">
                        <span className="text-muted-foreground flex items-center gap-1">
                          <ArrowUpRight className="h-3 w-3 text-accent" />
                          Realized Gain
                        </span>
                        <span className={cn(
                          "font-medium tabular-nums",
                          investment.realizedGain >= 0 ? "text-accent" : "text-destructive"
                        )}>
                          {investment.realizedGain >= 0 ? '+' : ''}{fmt(investment.realizedGain, investment.currency)}
                        </span>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-border/50">
                        <span className="text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          Unrealized Gain
                        </span>
                        <span className={cn(
                          "font-medium tabular-nums",
                          investment.unrealizedGain >= 0 ? "text-accent" : "text-destructive"
                        )}>
                          {investment.unrealizedGain >= 0 ? '+' : ''}{fmt(investment.unrealizedGain, investment.currency)}
                        </span>
                      </div>
                      
                      {investment.totalIncome > 0 && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground">Total Income</span>
                          <span className="font-medium tabular-nums text-accent">
                            +{fmt(investment.totalIncome, investment.currency)}
                          </span>
                        </div>
                      )}
                      
                      {(investment.totalFees > 0 || investment.totalTaxes > 0) && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground">Fees & Taxes</span>
                          <span className="font-medium tabular-nums text-destructive">
                            -{fmt(investment.totalFees + investment.totalTaxes, investment.currency)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Fixed Income Projections */}
              {isFixedIncome && investment.projectedAnnualInterest > 0 && (
                <Card className="border-primary/20 bg-primary/5">
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                          <Percent className="h-4 w-4" />
                          Projected Annual Interest
                        </p>
                        <p className="text-lg font-bold text-primary tabular-nums">
                          +{fmt(investment.projectedAnnualInterest, investment.currency)}
                        </p>
                      </div>
                      {investment.accruedInterest > 0 && (
                        <div className="text-right">
                          <p className="text-sm text-muted-foreground">Accrued (Unpaid)</p>
                          <p className="text-lg font-bold text-accent tabular-nums">
                            +{fmt(investment.accruedInterest, investment.currency)}
                          </p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Real Estate Appreciation */}
              {isRealEstate && investment.totalAppreciation !== 0 && (
                <Card className="border-accent/20 bg-accent/5">
                  <CardContent className="pt-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Total Appreciation</p>
                      <p className={cn(
                        "text-lg font-bold tabular-nums",
                        investment.totalAppreciation >= 0 ? "text-accent" : "text-destructive"
                      )}>
                        {investment.totalAppreciation >= 0 ? '+' : ''}{fmt(investment.totalAppreciation, investment.currency)}
                      </p>
                    </div>
                    {investment.totalIncome > 0 && (
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">Rental Income</p>
                        <p className="text-lg font-bold text-accent tabular-nums">
                          +{fmt(investment.totalIncome, investment.currency)}
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
              
              <div className="flex justify-end">
                <AddPortfolioTxnDialog investment={investment} />
              </div>
            </TabsContent>

            <TabsContent value="transactions" className="mt-4">
              {investment.transactions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <p>No transactions recorded yet.</p>
                  <div className="mt-4">
                    <AddPortfolioTxnDialog investment={investment} />
                  </div>
                </div>
              ) : (
                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
                  {investment.transactions.map((txn) => (
                    <div
                      key={txn.id}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge 
                            variant="outline" 
                            className={cn("text-xs", TXN_TYPE_COLORS[txn.type as PortfolioTxnType])}
                          >
                            {TXN_TYPE_LABELS[txn.type as PortfolioTxnType] || txn.type}
                          </Badge>
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {new Date(txn.date).toLocaleDateString('en-US', { 
                              month: 'short', 
                              day: 'numeric', 
                              year: 'numeric' 
                            })}
                          </span>
                        </div>
                        
                        {txn.units && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {fmtNum(txn.units, 4)} units @ {fmt(txn.price_per_unit || (txn.amount / txn.units), investment.currency, 2)}
                          </p>
                        )}
                        
                        {txn.note && (
                          <p className="text-xs text-muted-foreground mt-1 truncate">{txn.note}</p>
                        )}
                      </div>
                      
                      <div className="text-right shrink-0">
                        <p className={cn(
                          "font-bold tabular-nums",
                          ['buy', 'fee', 'tax'].includes(txn.type) ? 'text-destructive' : 'text-accent'
                        )}>
                          {['buy', 'fee', 'tax'].includes(txn.type) ? '-' : '+'}{fmt(txn.amount, investment.currency)}
                        </p>
                        
                        {(txn.fees > 0 || txn.taxes > 0) && (
                          <p className="text-xs text-muted-foreground">
                            {txn.fees > 0 && `Fee: ${fmt(txn.fees, investment.currency)}`}
                            {txn.fees > 0 && txn.taxes > 0 && ' · '}
                            {txn.taxes > 0 && `Tax: ${fmt(txn.taxes, investment.currency)}`}
                          </p>
                        )}
                      </div>
                      
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDeleteTxn(txn.id, TXN_TYPE_LABELS[txn.type as PortfolioTxnType])}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              
              {investment.transactions.length > 0 && (
                <div className="flex justify-end mt-4 pt-4 border-t border-border">
                  <AddPortfolioTxnDialog investment={investment} />
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <ConfirmDialog />
    </>
  );
}
