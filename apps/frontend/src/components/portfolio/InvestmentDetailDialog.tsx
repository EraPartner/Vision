import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  TrendingUp, TrendingDown, Eye, Trash2, Calendar,
  DollarSign, Percent, ArrowUpRight, ArrowDownRight, Clock, Pencil,
} from 'lucide-react';
import { usePortfolio } from '@/hooks/usePortfolio';
import { AddPortfolioTxnDialog } from './AddPortfolioTxnDialog';
import { EditInvestmentDialog } from './EditInvestmentDialog';
import { EditPortfolioTxnDialog } from './EditPortfolioTxnDialog';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { numberFormatToLocale } from '@/utils/currency';
import { formatDateStringWithAppSettings } from '@/components/shared/dateUtils';
import type { InvestmentSummary, PortfolioTxnType } from '@/types/portfolio';
import { getAssetClassLabel, getTxnTypeLabel } from '@/types/portfolio';
import { cn } from '@/lib/utils';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { useNavigate } from 'react-router-dom';

interface Props {
  investment: InvestmentSummary;
  fxAwarePnl?: {
    realizedTarget: number;
    unrealizedTarget: number;
    unrealizedPercent: number;
  };
  fxAwareCurrency?: string;
  trigger?: React.ReactNode;
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

export function InvestmentDetailDialog({ investment, fxAwarePnl, fxAwareCurrency, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { deleteTransaction } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);

  function fmt(
    val: number,
    currency = appSettings.defaultCurrency || 'EUR',
    decimals = appSettings.showDecimalPlaces
  ) {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(val);
  }

  function fmtNum(val: number, decimals = 2) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(val);
  }

  const isUnitBased = ['stock', 'etf', 'crypto', 'metals'].includes(investment.assetClass);
  const isFixedIncome = ['savings', 'bond'].includes(investment.assetClass);
  const isRealEstate = investment.assetClass === 'real_estate';

  const handleDeleteTxn = async (txnId: number, txnType: string) => {
    const ok = await confirm({
      title: t('invDetail.delete.title'),
      description: t('invDetail.delete.desc', { txType: txnType }),
      confirmLabel: t('invDetail.delete.confirm'),
      variant: 'destructive',
    });
    if (ok) deleteTransaction(txnId);
  };

  const openMarketLookup = () => {
    if (!investment.symbol) return;
    navigate(`/portfolio/market?symbol=${encodeURIComponent(investment.symbol)}`);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          {trigger ?? (
            <Button size="sm" variant="ghost" className="gap-1.5">
              <Eye className="h-4 w-4" /> {t('invDetail.trigger')}
            </Button>
          )}
        </DialogTrigger>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-2">
              {investment.symbol && (
                <span className="font-mono font-bold text-lg">{investment.symbol}</span>
              )}
              <DialogTitle className="text-xl">
                <button
                  type="button"
                  className="hover:underline cursor-pointer"
                  onDoubleClick={openMarketLookup}
                  title={investment.symbol ? t('watchlist.doubleClickChart') : undefined}
                >
                  {investment.name}
                </button>
              </DialogTitle>
              <Badge variant="secondary">{getAssetClassLabel(t, investment.assetClass)}</Badge>
              <div className="ml-auto">
                <EditInvestmentDialog
                  investment={investment}
                  trigger={
                    <Button size="sm" variant="outline" className="gap-1.5">
                      <Pencil className="h-4 w-4" /> {t('common.edit')}
                    </Button>
                  }
                />
              </div>
            </div>
          </DialogHeader>

          <Tabs defaultValue="overview" className="mt-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="overview">{t('invDetail.tab.performance')}</TabsTrigger>
               <TabsTrigger value="transactions">
                {t('invDetail.tab.transactions', { n: investment.transactions.length })}
               </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4 mt-4">
              {/* Key Metrics */}
              <div className="grid grid-cols-2 gap-3">
               <Card>
                 <CardContent className="pt-4">
                   <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                     <DollarSign className="h-4 w-4" />
                     {t('invDetail.currentValue')}
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
                       {t('invDetail.totalGainLoss')}
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
                   <CardTitle className="text-sm font-medium">{t('invDetail.breakdown')}</CardTitle>
                 </CardHeader>
                <CardContent className="space-y-2">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="space-y-2">
                      <div className="flex justify-between py-1.5 border-b border-border/50">
                         <span className="text-muted-foreground">{t('invDetail.totalCost')}</span>
                        <span className="font-medium tabular-nums">{fmt(investment.totalBuyCost, investment.currency)}</span>
                      </div>
                      
                      {isUnitBased && (
                        <>
                          <div className="flex justify-between py-1.5 border-b border-border/50">
                            <span className="text-muted-foreground">{t('invDetail.unitsHeld')}</span>
                            <span className="font-medium tabular-nums">{fmtNum(investment.totalUnits, 4)}</span>
                          </div>
                          <div className="flex justify-between py-1.5 border-b border-border/50">
                            <span className="text-muted-foreground">{t('invDetail.avgCostPerUnit')}</span>
                            <span className="font-medium tabular-nums">{fmt(investment.avgCostBasis, investment.currency, 2)}</span>
                          </div>
                          {investment.currentPrice && (
                            <div className="flex justify-between py-1.5 border-b border-border/50">
                               <span className="text-muted-foreground">{t('invDetail.currentPrice')}</span>
                              <span className="font-medium tabular-nums">{fmt(investment.currentPrice, investment.currency, 2)}</span>
                            </div>
                          )}
                        </>
                      )}
                      
                      {isFixedIncome && investment.interestRate && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                           <span className="text-muted-foreground">{t('invDetail.interestRate')}</span>
                          <span className="font-medium tabular-nums">{fmtNum(investment.interestRate)}%</span>
                        </div>
                      )}

                      {isRealEstate && investment.municipality && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground">{t('invDetail.municipality')}</span>
                          <span className="font-medium tabular-nums">{investment.municipality}</span>
                        </div>
                      )}

                      {isRealEstate && (investment.cadastral_income || investment.cadastral_income === 0) && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground">{t('invDetail.cadastralIncome')}</span>
                          <span className="font-medium tabular-nums">{fmt(investment.cadastral_income || 0, investment.currency)}</span>
                        </div>
                      )}

                      {isRealEstate && (investment.municipality_tax_rate || investment.municipality_tax_rate === 0) && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground">{t('invDetail.municipalityTaxRate')}</span>
                          <span className="font-medium tabular-nums">{fmtNum(investment.municipality_tax_rate || 0)}%</span>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground flex items-center gap-1">
                            <ArrowUpRight className="h-3 w-3 text-accent" />
                            {t('invDetail.realizedGain')}
                          </span>
                        <span className={cn(
                          "font-medium tabular-nums",
                          investment.realizedGain >= 0 ? "text-accent" : "text-destructive"
                        )}>
                          {investment.realizedGain >= 0 ? '+' : ''}{fmt(investment.realizedGain, investment.currency)}
                        </span>
                      </div>
                      {fxAwarePnl && fxAwareCurrency && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground text-xs">FX-aware {t('invDetail.realizedGain')} ({fxAwareCurrency})</span>
                          <span className={cn(
                            "font-medium tabular-nums",
                            fxAwarePnl.realizedTarget >= 0 ? "text-accent" : "text-destructive"
                          )}>
                            {fxAwarePnl.realizedTarget >= 0 ? '+' : ''}{fmt(fxAwarePnl.realizedTarget, fxAwareCurrency)}
                          </span>
                        </div>
                      )}
                      <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {t('invDetail.unrealizedGain')}
                          </span>
                        <span className={cn(
                          "font-medium tabular-nums",
                          investment.unrealizedGain >= 0 ? "text-accent" : "text-destructive"
                        )}>
                          {investment.unrealizedGain >= 0 ? '+' : ''}{fmt(investment.unrealizedGain, investment.currency)}
                        </span>
                      </div>
                      {fxAwarePnl && fxAwareCurrency && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground text-xs">FX-aware {t('invDetail.unrealizedGain')} ({fxAwareCurrency})</span>
                          <span className={cn(
                            "font-medium tabular-nums",
                            fxAwarePnl.unrealizedTarget >= 0 ? "text-accent" : "text-destructive"
                          )}>
                            {fxAwarePnl.unrealizedTarget >= 0 ? '+' : ''}{fmt(fxAwarePnl.unrealizedTarget, fxAwareCurrency)}
                            <span className="text-xs ml-1 opacity-70">{fxAwarePnl.unrealizedPercent >= 0 ? '+' : ''}{fmtNum(fxAwarePnl.unrealizedPercent)}%</span>
                          </span>
                        </div>
                      )}
                      
                      {investment.totalIncome > 0 && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                           <span className="text-muted-foreground">{t('invDetail.totalIncome')}</span>
                          <span className="font-medium tabular-nums text-accent">
                            +{fmt(investment.totalIncome, investment.currency)}
                          </span>
                        </div>
                      )}
                      
                      {(investment.totalFees > 0 || investment.totalTaxes > 0) && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                           <span className="text-muted-foreground">{t('invDetail.feesAndTaxes')}</span>
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
                          {t('portfolio.projectedAnnualInterest')}
                         </p>
                        <p className="text-lg font-bold text-primary tabular-nums">
                          +{fmt(investment.projectedAnnualInterest, investment.currency)}
                        </p>
                      </div>
                      {investment.accruedInterest > 0 && (
                        <div className="text-right">
                           <p className="text-sm text-muted-foreground">{t('portfolio.accruedUnpaid')}</p>
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
                       <p className="text-sm text-muted-foreground">{t('invDetail.totalAppreciation')}</p>
                      <p className={cn(
                        "text-lg font-bold tabular-nums",
                        investment.totalAppreciation >= 0 ? "text-accent" : "text-destructive"
                      )}>
                        {investment.totalAppreciation >= 0 ? '+' : ''}{fmt(investment.totalAppreciation, investment.currency)}
                      </p>
                    </div>
                    {investment.totalIncome > 0 && (
                      <div className="text-right">
                         <p className="text-sm text-muted-foreground">{t('portfolio.rentalIncome')}</p>
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
                   <p>{t('invDetail.noTransactions')}</p>
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
                            {getTxnTypeLabel(t, txn.type as PortfolioTxnType)}
                          </Badge>
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {formatDateStringWithAppSettings(txn.date, appSettings.dateFormat)}
                          </span>
                        </div>
                        
                        {txn.units && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('invDetail.unitsAt', {
                              units: fmtNum(txn.units, 4),
                              price: fmt(txn.price_per_unit || (txn.amount / txn.units), investment.currency, 2),
                            })}
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
                             {txn.fees > 0 && t('invDetail.fee', { amount: fmt(txn.fees, investment.currency) })}
                            {txn.fees > 0 && txn.taxes > 0 && ' · '}
                            {txn.taxes > 0 && t('invDetail.tax', { amount: fmt(txn.taxes, investment.currency) })}
                          </p>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-1">
                        <EditPortfolioTxnDialog
                          investment={investment}
                          transaction={txn}
                          trigger={
                            <Button
                              size="icon"
                              variant="ghost"
                              className="icon-touch-target shrink-0 text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          }
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="icon-touch-target shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleDeleteTxn(txn.id, getTxnTypeLabel(t, txn.type as PortfolioTxnType))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
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
