import { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  TrendingUp, TrendingDown, Eye, Trash2, Calendar,
  DollarSign, Percent, ArrowUpRight, Clock, Pencil, Plus,
} from 'lucide-react';
import { isUnitBased, isFixedIncome, isRealEstate } from '@/utils/assetClass';
import { onActivateKeyDown } from '@/utils/a11y';
import { usePortfolio } from '@/hooks/usePortfolio';
import { usePortfolioSummaryQuery } from '@/hooks/portfolio/usePortfolioSummary';
import { useFxAwarePnl } from '@/hooks/portfolio/useFxAwarePnl';
import { AddPortfolioTxnDialog } from './AddPortfolioTxnDialog';
import { EditInvestmentDialog } from './EditInvestmentDialog';
import { EditPortfolioTxnDialog } from './EditPortfolioTxnDialog';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useCurrencyFormatter } from '@/hooks/useCurrencyFormatter';
import { numberFormatToLocale } from '@/utils/currency';
import { formatDateStringWithAppSettings } from '@/components/shared/dateUtils';
import type { InvestmentSummary, PortfolioTxnType } from '@/types/portfolio';
import { getAssetClassLabel, getTxnTypeLabel } from '@/types/portfolio';
import { cn } from '@/lib/utils';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { useNavigate } from 'react-router';

type TxnRow = InvestmentSummary['transactions'][number];

interface Props {
  investment: InvestmentSummary;
  trigger?: React.ReactNode;
  /** When provided, replaces the embedded AddPortfolioTxnDialog with a callback */
  onAddTransaction?: (investment: InvestmentSummary) => void;
  /** When provided, replaces the embedded EditInvestmentDialog with a callback */
  onEditInvestment?: (investment: InvestmentSummary) => void;
  /** When provided, replaces the embedded EditPortfolioTxnDialog with a callback */
  onEditTransaction?: (txn: TxnRow, investment: InvestmentSummary) => void;
}

// Module-level plain-number formatter cache. The transactions tab calls fmtNum
// several times per row and re-renders the whole (unbounded) list on any
// dialog-level state change, so constructing a fresh Intl.NumberFormat per call
// (~50-200µs each) was pure waste. Currency formatting comes from the shared
// useCurrencyFormatter hook, which carries its own per-key cache (SIMP-67).
const numberFmtCache = new Map<string, Intl.NumberFormat>();
function getNumberFmt(locale: string, decimals: number): Intl.NumberFormat {
  const key = `${locale}:${decimals}`;
  let f = numberFmtCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    });
    numberFmtCache.set(key, f);
  }
  return f;
}

const TXN_TYPE_COLORS: Record<PortfolioTxnType, string> = {
  buy: 'bg-accent/10 text-accent border-accent/20',
  sell: 'bg-destructive/10 text-destructive border-destructive/20',
  dividend: 'bg-primary/10 text-primary border-primary/20',
  interest: 'bg-primary/10 text-primary border-primary/20',
  rent_income: 'bg-accent/10 text-accent border-accent/20',
  gift: 'bg-primary/10 text-primary border-primary/20',
  fee: 'bg-muted text-muted-foreground border-border',
  tax: 'bg-muted text-muted-foreground border-border',
  appreciation: 'bg-accent/10 text-accent border-accent/20',
};

export function InvestmentDetailDialog({
  investment, trigger,
  onAddTransaction, onEditInvestment, onEditTransaction,
}: Props) {
  const [open, setOpen] = useState(false);

  // The three nested dialogs are mounted OUTSIDE this dialog's DialogContent.
  // Radix unmounts content when the dialog closes, so a nested dialog rendered
  // inside it lost its preserved draft (useDialogFormState only survives while
  // mounted) the moment this outer dialog was dismissed — the user's own
  // dialog was never the one being dismissed, which made the loss silent.
  // Mounting is therefore this component's, not the content's; opening is
  // driven by the controls below. `nestedMounted` keeps the cost off rows the
  // user never opened (usePortfolio recomputes the whole portfolio per
  // consumer, and there is one of these per holding row).
  const [nestedMounted, setNestedMounted] = useState(false);
  const [addTxnOpen, setAddTxnOpen] = useState(false);
  const [editInvestmentOpen, setEditInvestmentOpen] = useState(false);
  // The row being edited is held by id, so the dialog keeps reading the live
  // transaction after a refetch instead of a frozen copy. It is deliberately
  // NOT cleared on close: that is what keeps the draft alive for a reopen.
  const [editTxnId, setEditTxnId] = useState<number | null>(null);
  const [editTxnOpen, setEditTxnOpen] = useState(false);
  const editTxn = investment.transactions.find((tx) => tx.id === editTxnId);
  // Without a DialogTrigger of their own the nested dialogs have nothing to
  // hand focus back to, so the control that opened them is remembered here.
  const nestedOpenerRef = useRef<HTMLElement | null>(null);

  const openNested = (openDialog: (v: boolean) => void) => (event: React.MouseEvent<HTMLElement>) => {
    nestedOpenerRef.current = event.currentTarget;
    openDialog(true);
  };

  const navigate = useNavigate();
  const { deleteTransaction } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  // Shared cached currency formatter: fmt(val, currency?, decimals?) with the
  // same defaults (app default currency, showDecimalPlaces) as the old local copy.
  const fmt = useCurrencyFormatter();

  function fmtNum(val: number, decimals = 2) {
    return getNumberFmt(locale, decimals).format(val);
  }

  const unitBased = isUnitBased(investment.assetClass);
  const fixedIncome = isFixedIncome(investment.assetClass);
  const realEstate = isRealEstate(investment.assetClass);

  // Anything FX-related is shown only when the holding is in a foreign currency;
  // for base-currency holdings the conversion is a no-op and the extra rows
  // would just duplicate the native figures. On an InvestmentSummary `currency`
  // is the display/target currency (all amounts are converted to it) — the
  // holding's NATIVE currency lives in `originalCurrency`, which is what decides
  // foreign-ness.
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const nativeCurrency = (investment.originalCurrency || investment.currency || 'EUR').toUpperCase();
  const isForeignCurrency = nativeCurrency !== targetCurrency.toUpperCase();

  // FX attribution from the backend summary (it owns the historical-rate
  // machinery). The query is shared with the overview/performance pages, so this
  // is usually a cache hit.
  const { data: apiSummary } = usePortfolioSummaryQuery(targetCurrency);
  const fxSummary = isForeignCurrency
    ? apiSummary?.summaries.find((s) => s.id === investment.id)
    : undefined;

  // FX-aware realized/unrealized P&L in the target currency, computed here so the
  // dialog renders identically wherever it is opened (overview, stocks, crypto,
  // …) instead of depending on the caller to pass it in.
  const computeFxAwarePnl = useFxAwarePnl(targetCurrency);
  const fxAwarePnl = isForeignCurrency ? computeFxAwarePnl(investment) : undefined;

  // The same add-transaction control appears in three spots (overview footer,
  // empty-transactions CTA, transactions footer) — build it once.
  const addTransactionControl = onAddTransaction ? (
    <Button size="sm" className="gap-1.5" onClick={() => onAddTransaction(investment)}>
      {t('portfolio.addTransaction')}
    </Button>
  ) : (
    // Same button AddPortfolioTxnDialog renders as its own default trigger; it
    // only opens the lifted dialog below instead of being that dialog's trigger,
    // so it also carries by hand the opener semantics DialogTrigger used to add.
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={addTxnOpen}
      onClick={openNested(setAddTxnOpen)}
    >
      <Plus className="h-4 w-4" /> {t('form.addTransaction.title')}
    </Button>
  );

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
    // Pass the investment id so the market page can serve the chart from this
    // holding's own price provider (Kinesis/custom/binance) when Yahoo has no
    // data for the symbol; Yahoo holdings are unaffected.
    navigate(`/research/market?symbol=${encodeURIComponent(investment.symbol)}&investmentId=${investment.id}`);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (v) setNestedMounted(true); setOpen(v); }}>
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
                  className="hover:underline cursor-pointer touch-manipulation"
                  onDoubleClick={openMarketLookup}
                  // Coarse pointers (touch) can't reliably double-click, so a
                  // single tap opens the chart. Fine pointers keep double-click
                  // only, so desktop behavior is unchanged.
                  onClick={() => {
                    if (typeof window !== "undefined"
                      && typeof window.matchMedia === "function"
                      && window.matchMedia("(pointer: coarse)").matches) {
                      openMarketLookup();
                    }
                  }}
                  onKeyDown={onActivateKeyDown(openMarketLookup)}
                  title={investment.symbol ? t('watchlist.doubleClickChart') : undefined}
                >
                  {investment.name}
                </button>
              </DialogTitle>
              <Badge variant="secondary">{getAssetClassLabel(t, investment.assetClass)}</Badge>
              <div className="ml-auto flex items-center gap-1.5">
                {onEditInvestment ? (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onEditInvestment(investment)}>
                    <Pencil className="h-4 w-4" /> {t('common.edit')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={editInvestmentOpen}
                    onClick={openNested(setEditInvestmentOpen)}
                  >
                    <Pencil className="h-4 w-4" /> {t('common.edit')}
                  </Button>
                )}
              </div>
            </div>
            <DialogDescription className="sr-only">{investment.name}</DialogDescription>
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
                        <TrendingUp className="h-4 w-4 text-gain" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-loss" />
                      )}
                       {t('invDetail.totalGainLoss')}
                    </div>
                    <p className={cn(
                      "text-2xl font-bold tabular-nums",
                      investment.totalGain >= 0 ? "amount-gain" : "amount-loss"
                    )}>
                      {investment.totalGain >= 0 ? '+' : ''}{fmt(investment.totalGain, investment.currency)}
                    </p>
                    <p className={cn(
                      "text-sm tabular-nums",
                      investment.gainLossPercent >= 0 ? "amount-gain" : "amount-loss"
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
                      
                      {unitBased && (
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
                      
                      {fixedIncome && investment.interestRate && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                           <span className="text-muted-foreground">{t('invDetail.interestRate')}</span>
                          <span className="font-medium tabular-nums">{fmtNum(investment.interestRate)}%</span>
                        </div>
                      )}

                      {realEstate && investment.municipality && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground">{t('invDetail.municipality')}</span>
                          <span className="font-medium tabular-nums">{investment.municipality}</span>
                        </div>
                      )}

                      {realEstate && (investment.cadastral_income || investment.cadastral_income === 0) && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground">{t('invDetail.cadastralIncome')}</span>
                          <span className="font-medium tabular-nums">{fmt(investment.cadastral_income || 0, investment.currency)}</span>
                        </div>
                      )}

                      {realEstate && (investment.municipality_tax_rate || investment.municipality_tax_rate === 0) && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground">{t('invDetail.municipalityTaxRate')}</span>
                          <span className="font-medium tabular-nums">{fmtNum(investment.municipality_tax_rate || 0)}%</span>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground flex items-center gap-1">
                            <ArrowUpRight className="h-3 w-3 text-gain" />
                            {t('invDetail.realizedGain')}
                          </span>
                        <span className={cn(
                          "font-medium tabular-nums",
                          investment.realizedGain >= 0 ? "amount-gain" : "amount-loss"
                        )}>
                          {investment.realizedGain >= 0 ? '+' : ''}{fmt(investment.realizedGain, investment.currency)}
                        </span>
                      </div>
                      {fxAwarePnl && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground text-xs">{t('invDetail.fxAwareRealized', { currency: targetCurrency })}</span>
                          <span className={cn(
                            "font-medium tabular-nums",
                            fxAwarePnl.realizedTarget >= 0 ? "amount-gain" : "amount-loss"
                          )}>
                            {fxAwarePnl.realizedTarget >= 0 ? '+' : ''}{fmt(fxAwarePnl.realizedTarget, targetCurrency)}
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
                          investment.unrealizedGain >= 0 ? "amount-gain" : "amount-loss"
                        )}>
                          {investment.unrealizedGain >= 0 ? '+' : ''}{fmt(investment.unrealizedGain, investment.currency)}
                        </span>
                      </div>
                      {fxAwarePnl && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                          <span className="text-muted-foreground text-xs">{t('invDetail.fxAwareUnrealized', { currency: targetCurrency })}</span>
                          <span className={cn(
                            "font-medium tabular-nums",
                            fxAwarePnl.unrealizedTarget >= 0 ? "amount-gain" : "amount-loss"
                          )}>
                            {fxAwarePnl.unrealizedTarget >= 0 ? '+' : ''}{fmt(fxAwarePnl.unrealizedTarget, targetCurrency)}
                            <span className="text-xs ml-1 opacity-70">{fxAwarePnl.unrealizedPercent >= 0 ? '+' : ''}{fmtNum(fxAwarePnl.unrealizedPercent)}%</span>
                          </span>
                        </div>
                      )}
                      
                      {investment.totalIncome > 0 && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                           <span className="text-muted-foreground">{t('invDetail.totalIncome')}</span>
                          <span className="font-medium tabular-nums text-gain">
                            +{fmt(investment.totalIncome, investment.currency)}
                          </span>
                        </div>
                      )}
                      
                      {(investment.totalFees > 0 || investment.totalTaxes > 0) && (
                        <div className="flex justify-between py-1.5 border-b border-border/50">
                           <span className="text-muted-foreground">{t('invDetail.feesAndTaxes')}</span>
                          <span className="font-medium tabular-nums text-loss">
                            -{fmt(investment.totalFees + investment.totalTaxes, investment.currency)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* FX attribution — invested at purchase-date rates, gain split
                  into asset performance vs currency effect */}
              {fxSummary && typeof fxSummary.fxGain === 'number' && (
                <Card className="!border-primary/50 bg-primary/5">
                  <CardContent className="pt-4 space-y-2">
                    <p className="text-sm font-semibold text-muted-foreground">{t('invDetail.fxAttribution')}</p>
                    <div className="flex justify-between py-1 border-b border-border/50 text-sm">
                      <span className="text-muted-foreground">{t('portfolio.nativeValue', { currency: nativeCurrency })}</span>
                      <span className="font-medium tabular-nums">{fmt(fxSummary.nativeCurrentValue ?? investment.currentValue, nativeCurrency)}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-border/50 text-sm">
                      <span className="text-muted-foreground">{t('invDetail.investedAtHistoricalRates', { currency: targetCurrency })}</span>
                      <span className="font-medium tabular-nums">{fmt(fxSummary.totalInvested, targetCurrency)}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-border/50 text-sm">
                      <span className="text-muted-foreground">{t('portfolio.assetGain')}</span>
                      <span className={cn("font-medium tabular-nums", (fxSummary.assetGain ?? 0) >= 0 ? "amount-gain" : "amount-loss")}>
                        {(fxSummary.assetGain ?? 0) >= 0 ? '+' : ''}{fmt(fxSummary.assetGain ?? 0, targetCurrency)}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 text-sm">
                      <span className="text-muted-foreground">{t('portfolio.fxEffect')}</span>
                      <span className={cn("font-medium tabular-nums", fxSummary.fxGain >= 0 ? "amount-gain" : "amount-loss")}>
                        {fxSummary.fxGain >= 0 ? '+' : ''}{fmt(fxSummary.fxGain, targetCurrency)}
                      </span>
                    </div>
                    {fxSummary.usedFallbackRate && (
                      <p className="text-xs text-warning">{t('portfolio.fxFallbackNote')}</p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Fixed Income Projections */}
              {fixedIncome && investment.projectedAnnualInterest > 0 && (
                <Card className="!border-primary/50 bg-primary/5">
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
                          <p className="text-lg font-bold text-gain tabular-nums">
                            +{fmt(investment.accruedInterest, investment.currency)}
                          </p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Real Estate Appreciation */}
              {realEstate && investment.totalAppreciation !== 0 && (
                <Card className="!border-accent/50 bg-accent/5">
                  <CardContent className="pt-4 flex items-center justify-between">
                    <div>
                       <p className="text-sm text-muted-foreground">{t('invDetail.totalAppreciation')}</p>
                      <p className={cn(
                        "text-lg font-bold tabular-nums",
                        investment.totalAppreciation >= 0 ? "amount-gain" : "amount-loss"
                      )}>
                        {investment.totalAppreciation >= 0 ? '+' : ''}{fmt(investment.totalAppreciation, investment.currency)}
                      </p>
                    </div>
                    {investment.totalIncome > 0 && (
                      <div className="text-right">
                         <p className="text-sm text-muted-foreground">{t('portfolio.rentalIncome')}</p>
                        <p className="text-lg font-bold text-gain tabular-nums">
                          +{fmt(investment.totalIncome, investment.currency)}
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
              
              <div className="flex justify-end">
                {addTransactionControl}
              </div>
            </TabsContent>

            <TabsContent value="transactions" className="mt-4">
              {investment.transactions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                   <p>{t('invDetail.noTransactions')}</p>
                  <div className="mt-4">
                    {addTransactionControl}
                  </div>
                </div>
              ) : (
                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
                  {investment.transactions.map((txn) => (
                    <div
                      key={txn.id}
                      className="cv-auto-row flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/30 transition-colors"
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
                        
                        {txn.units != null && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('invDetail.unitsAt', {
                              units: fmtNum(txn.units, 4),
                              price: fmt(txn.price_per_unit || (txn.units !== 0 ? txn.amount / txn.units : 0), txn.currency || nativeCurrency, 2),
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
                          ['buy', 'fee', 'tax'].includes(txn.type) ? 'text-loss' : 'text-gain'
                        )}>
                          {['buy', 'fee', 'tax'].includes(txn.type) ? '-' : '+'}{fmt(txn.amount, txn.currency || nativeCurrency)}
                        </p>
                        
                        {((txn.fees ?? 0) > 0 || (txn.taxes ?? 0) > 0) && (
                          <p className="text-xs text-muted-foreground">
                             {(txn.fees ?? 0) > 0 && t('invDetail.fee', { amount: fmt(txn.fees ?? 0, txn.currency || nativeCurrency) })}
                            {(txn.fees ?? 0) > 0 && (txn.taxes ?? 0) > 0 && ' · '}
                            {(txn.taxes ?? 0) > 0 && t('invDetail.tax', { amount: fmt(txn.taxes ?? 0, txn.currency || nativeCurrency) })}
                          </p>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-1">
                        {onEditTransaction ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="icon-touch-target shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() => onEditTransaction(txn, investment)}
                            aria-label={t('aria.editTransaction')}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="icon-touch-target shrink-0 text-muted-foreground hover:text-foreground"
                            aria-label={t('aria.editTransaction')}
                            type="button"
                            aria-haspopup="dialog"
                            aria-expanded={editTxnOpen && editTxnId === txn.id}
                            onClick={(event) => {
                              setEditTxnId(txn.id);
                              openNested(setEditTxnOpen)(event);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="icon-touch-target shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleDeleteTxn(txn.id, getTxnTypeLabel(t, txn.type as PortfolioTxnType))}
                          aria-label={t('aria.deleteTransaction')}
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
                  {addTransactionControl}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      {/* Siblings of the dialog above, not children of its content: they must
          outlive its dismissal for their drafts to survive one. */}
      {nestedMounted && !onAddTransaction && (
        <AddPortfolioTxnDialog
          investment={investment}
          open={addTxnOpen}
          onOpenChange={setAddTxnOpen}
          returnFocusRef={nestedOpenerRef}
        />
      )}
      {nestedMounted && !onEditInvestment && (
        <EditInvestmentDialog
          investment={investment}
          open={editInvestmentOpen}
          onOpenChange={setEditInvestmentOpen}
          returnFocusRef={nestedOpenerRef}
        />
      )}
      {nestedMounted && !onEditTransaction && editTxn && (
        <EditPortfolioTxnDialog
          investment={investment}
          transaction={editTxn}
          open={editTxnOpen}
          onOpenChange={setEditTxnOpen}
          returnFocusRef={nestedOpenerRef}
        />
      )}
      <ConfirmDialog />
    </>
  );
}
