import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, Trash2, Eye, DollarSign, ArrowUpRight } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { cn } from "@/lib/utils";
import type { InvestmentSummary } from "@/types/portfolio";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import type { AssetClass } from "@/types/portfolio";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";

function fmtPct(val: number) {
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
}

interface StocksPageProps {
  assetClasses?: AssetClass[];
  titleKey?: string;
  emptyTitleKey?: string;
  emptyDescriptionKey?: string;
  allowedAddAssetClasses?: AssetClass[];
  enableFxAwarePnl?: boolean;
}

const DEFAULT_STOCKS_ASSET_CLASSES: AssetClass[] = ['stock', 'etf'];
const DEFAULT_STOCKS_ALLOWED_ADD_ASSET_CLASSES: AssetClass[] = ['stock', 'etf'];

export default function StocksPage({
  assetClasses = DEFAULT_STOCKS_ASSET_CLASSES,
  titleKey = 'stocks.title',
  emptyTitleKey = 'stocks.noStocks',
  emptyDescriptionKey = 'stocks.noStocksDesc',
  allowedAddAssetClasses = DEFAULT_STOCKS_ALLOWED_ADD_ASSET_CLASSES,
  enableFxAwarePnl = true,
}: StocksPageProps = {}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const { byAssetClass, deleteInvestment } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const holdings = useMemo(() => byAssetClass(assetClasses), [byAssetClass, assetClasses]);
  const targetCurrency = appSettings.defaultCurrency || 'EUR';

  const { convertToTarget, ratesToEur } = useCurrencyConverter(targetCurrency);

  const formatterCache = useMemo(() => new Map<string, Intl.NumberFormat>(), []);

  const fmt = useCallback((
    val: number,
    currency = targetCurrency,
    decimals = appSettings.showDecimalPlaces
  ) => {
    const key = `${locale}:${currency}:${decimals}`;
    let formatter = formatterCache.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      formatterCache.set(key, formatter);
    }
    return formatter.format(val);
  }, [targetCurrency, appSettings.showDecimalPlaces, locale, formatterCache]);

  const getRateToEur = useCallback((currency?: string) => {
    const code = (currency || 'EUR').toUpperCase();
    return ratesToEur[code] || 1;
  }, [ratesToEur]);

  const convertEurToTarget = useCallback((amountEur: number) => {
    const rateTo = getRateToEur(targetCurrency);
    return rateTo ? amountEur / rateTo : amountEur;
  }, [getRateToEur, targetCurrency]);

  const openMarketLookup = useCallback((symbol?: string) => {
    if (!symbol) return;
    navigate(`/portfolio/market?symbol=${encodeURIComponent(symbol)}`);
  }, [navigate]);

  const calculateFxAwarePnl = useCallback((holding: InvestmentSummary) => {
    const sortedTxns = [...(holding.transactions || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let poolUnits = 0;
    let poolCostEur = 0;
    let realizedEur = 0;

    for (const txn of sortedTxns) {
      const units = Number(txn.units) || 0;
      const amount = Number(txn.amount) || 0;
      const fees = Number(txn.fees) || 0;
      const taxes = Number(txn.taxes) || 0;
      const txnRateToEur = Number(txn.fx_rate_to_eur) > 0
        ? Number(txn.fx_rate_to_eur)
        : getRateToEur(txn.currency || holding.currency);

      if (txn.type === 'buy' || txn.type === 'gift') {
        poolUnits += units;
        poolCostEur += (amount + fees + taxes) * txnRateToEur;
      } else if (txn.type === 'sell' && units > 0 && poolUnits > 0) {
        const sellUnits = Math.min(units, poolUnits);
        const sellRatio = units > 0 ? sellUnits / units : 0;
        const avgCostPerUnitEur = poolCostEur / poolUnits;
        const costOfSoldEur = avgCostPerUnitEur * sellUnits;
        const netProceedsEur = (amount - fees - taxes) * sellRatio * txnRateToEur;
        realizedEur += netProceedsEur - costOfSoldEur;

        poolUnits -= sellUnits;
        poolCostEur -= costOfSoldEur;
      }
    }

    poolCostEur = Math.max(0, poolCostEur);

    const currentPrice = Number(holding.currentPrice ?? holding.current_price) || 0;
    const currentValueEur = (Number(holding.totalUnits) || 0) * currentPrice * getRateToEur(holding.currency);
    const unrealizedEur = currentValueEur - poolCostEur;

    return {
      realizedTarget: convertEurToTarget(realizedEur),
      unrealizedTarget: convertEurToTarget(unrealizedEur),
      unrealizedPercent: poolCostEur > 0 ? (unrealizedEur / poolCostEur) * 100 : 0,
    };
  }, [convertEurToTarget, getRateToEur]);

  const displayedPnlByHoldingId = useMemo(() => {
    const map: Record<number, { realizedTarget: number; unrealizedTarget: number; unrealizedPercent: number }> = {};
    for (const holding of holdings) {
      if (enableFxAwarePnl) {
        map[holding.id] = calculateFxAwarePnl(holding);
        continue;
      }

      map[holding.id] = {
        realizedTarget: convertToTarget(holding.realizedGain, holding.currency),
        unrealizedTarget: convertToTarget(holding.unrealizedGain, holding.currency),
        unrealizedPercent: Number(holding.gainLossPercent) || 0,
      };
    }
    return map;
  }, [holdings, enableFxAwarePnl, calculateFxAwarePnl, convertToTarget]);

  const totals = useMemo(() => {
    return holdings.reduce((acc, holding) => {
      acc.totalValue += convertToTarget(holding.currentValue, holding.currency);
      acc.totalRealizedGain += displayedPnlByHoldingId[holding.id]?.realizedTarget || 0;
      acc.totalUnrealizedGain += displayedPnlByHoldingId[holding.id]?.unrealizedTarget || 0;
      acc.totalDividends += convertToTarget(holding.totalDividends, holding.currency);
      acc.totalFees += convertToTarget(holding.totalFees, holding.currency);
      acc.totalTaxes += convertToTarget(holding.totalTaxes, holding.currency);
      return acc;
    }, {
      totalValue: 0,
      totalRealizedGain: 0,
      totalUnrealizedGain: 0,
      totalDividends: 0,
      totalFees: 0,
      totalTaxes: 0,
    });
  }, [holdings, displayedPnlByHoldingId, convertToTarget]);

  const {
    totalValue,
    totalRealizedGain,
    totalUnrealizedGain,
    totalDividends,
    totalFees,
    totalTaxes,
  } = totals;
  const netGain = totalRealizedGain + totalUnrealizedGain + totalDividends - totalFees - totalTaxes;

  if (holdings.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t(titleKey)}
          icon={TrendingUp}
          actions={<AddInvestmentDialog allowedAssetClasses={allowedAddAssetClasses} />}
        />
        <Card className="group relative overflow-hidden surface-elevated premium-frame bg-card backdrop-blur-sm">
          <CardContent className="pt-0">
            <EmptyState
              icon={TrendingUp}
              title={t(emptyTitleKey)}
              description={t(emptyDescriptionKey)}
              action={<AddInvestmentDialog allowedAssetClasses={allowedAddAssetClasses} />}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-6">
      <PageHeader
        title={t(titleKey)}
        icon={TrendingUp}
        actions={<AddInvestmentDialog allowedAssetClasses={allowedAddAssetClasses} />}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-primary/15">
                <DollarSign className="h-3 w-3" />
              </span>
              {t('portfolio.portfolioValue')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-primary tabular-nums">{fmt(totalValue)}</p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <span className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-md ring-1",
                totalRealizedGain >= 0
                  ? "bg-gradient-to-br from-accent/20 to-accent/5 text-accent ring-accent/15"
                  : "bg-gradient-to-br from-destructive/20 to-destructive/5 text-destructive ring-destructive/15"
              )}>
                <ArrowUpRight className="h-3 w-3" />
              </span>
              {t('portfolio.realizedPnl')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className={cn("text-xl font-bold tabular-nums", totalRealizedGain >= 0 ? "text-accent" : "text-destructive")}>
              {totalRealizedGain >= 0 ? "+" : ""}{fmt(totalRealizedGain)}
            </p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <span className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-md ring-1",
                totalUnrealizedGain >= 0
                  ? "bg-gradient-to-br from-accent/20 to-accent/5 text-accent ring-accent/15"
                  : "bg-gradient-to-br from-destructive/20 to-destructive/5 text-destructive ring-destructive/15"
              )}>
                <TrendingUp className="h-3 w-3" />
              </span>
              {t('portfolio.unrealizedPnl')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className={cn("text-xl font-bold tabular-nums", totalUnrealizedGain >= 0 ? "text-accent" : "text-destructive")}>
              {totalUnrealizedGain >= 0 ? "+" : ""}{fmt(totalUnrealizedGain)}
            </p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t('portfolio.dividends')}</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-accent tabular-nums">+{fmt(totalDividends)}</p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t('portfolio.feesAndTaxes')}</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-destructive tabular-nums">-{fmt(totalFees + totalTaxes)}</p>
          </CardContent>
        </Card>

        <Card className={cn(
          "group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm border-l-4",
          netGain >= 0 ? "border-l-accent" : "border-l-destructive"
        )}>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t('portfolio.netReturn')}</CardTitle>
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
        <CardHeader><CardTitle>{t('portfolio.holdings')}</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 px-3 text-left font-medium text-muted-foreground">{t('portfolio.symbol')}</th>
                  <th className="py-2 px-3 text-left font-medium text-muted-foreground">{t('portfolio.name')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.units')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.avgCost')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.price')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.value')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.unrealized')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.realized')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.dividends')}</th>
                  <th className="py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors group">
                    <td className="py-2 px-3 font-mono font-bold text-primary">{h.symbol || '—'}</td>
                    <td className="py-2 px-3">
                      <button
                        type="button"
                        className="font-medium text-left hover:underline cursor-pointer"
                        onDoubleClick={() => openMarketLookup(h.symbol)}
                        title={h.symbol ? t('watchlist.doubleClickChart') : undefined}
                      >
                        {h.name}
                      </button>
                       <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0">
                         {h.assetClass === 'etf' ? t('stocks.etf') : h.assetClass === 'metals' ? t('portfolio.assetClass.metals') : t('stocks.stock')}
                       </Badge>
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums">{h.totalUnits.toFixed(4)}</td>
                    <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">{fmt(h.avgCostBasis, h.currency)}</td>
                    <td className="text-right py-2 px-3 tabular-nums">{fmt(h.currentPrice ?? 0, h.currency)}</td>
                    <td className="text-right py-2 px-3 tabular-nums font-medium">{fmt(h.currentValue, h.currency)}</td>
                    <td className={cn("text-right py-2 px-3 tabular-nums font-medium", (displayedPnlByHoldingId[h.id]?.unrealizedTarget || 0) >= 0 ? "text-accent" : "text-destructive")}>
                      {(displayedPnlByHoldingId[h.id]?.unrealizedTarget || 0) >= 0 ? "+" : ""}{fmt(displayedPnlByHoldingId[h.id]?.unrealizedTarget || 0)}
                      <span className="text-xs ml-1 opacity-70">{fmtPct(displayedPnlByHoldingId[h.id]?.unrealizedPercent || 0)}</span>
                    </td>
                    <td className={cn("text-right py-2 px-3 tabular-nums", (displayedPnlByHoldingId[h.id]?.realizedTarget || 0) !== 0 ? ((displayedPnlByHoldingId[h.id]?.realizedTarget || 0) >= 0 ? "text-accent" : "text-destructive") : "text-muted-foreground")}>
                      {(displayedPnlByHoldingId[h.id]?.realizedTarget || 0) !== 0 ? `${(displayedPnlByHoldingId[h.id]?.realizedTarget || 0) >= 0 ? "+" : ""}${fmt(displayedPnlByHoldingId[h.id]?.realizedTarget || 0)}` : '—'}
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums text-accent">
                      {h.totalDividends > 0 ? `+${fmt(convertToTarget(h.totalDividends, h.currency))}` : '—'}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <InvestmentDetailDialog 
                          investment={h}
                          fxAwarePnl={enableFxAwarePnl ? displayedPnlByHoldingId[h.id] : undefined}
                          fxAwareCurrency={enableFxAwarePnl ? targetCurrency : undefined}
                          trigger={
                            <Button variant="ghost" size="icon" className="icon-touch-target">
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          }
                        />
                        <AddPortfolioTxnDialog investment={h} />
                        <Button variant="ghost" size="icon" className="icon-touch-target text-muted-foreground hover:text-destructive"
                          onClick={async () => { 
                            const ok = await confirm({ 
                              title: t('portfolio.deleteInvestment'), 
                              description: t('portfolio.deleteInvestmentDesc', { name: h.name }), 
                              confirmLabel: t('common.delete'), 
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
          <p className="text-sm text-muted-foreground">{t('stocks.howItWorks')}</p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
