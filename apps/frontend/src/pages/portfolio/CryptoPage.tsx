import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, Trash2, Bitcoin, Eye, DollarSign, ArrowUpRight } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { StalePriceIndicator } from "@/components/portfolio/StalePriceIndicator";
import { StalePricesBanner } from "@/components/portfolio/StalePricesBanner";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import { onActivateKeyDown } from "@/utils/a11y";

function fmtPct(val: number) {
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
}

export default function CryptoPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const { byAssetClass, deleteInvestment, refreshPrices, isRefreshingPrices, isLoading, isError, error, refetch } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const holdings = byAssetClass('crypto');

  const { convertToTarget } = useCurrencyConverter(targetCurrency);

  function fmt(
    val: number,
    currency = targetCurrency,
    decimals = appSettings.showDecimalPlaces
  ) {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(val);
  }

  function openMarketLookup(symbol?: string, investmentId?: number) {
    if (!symbol) return;
    // Pass the holding id so the market page can chart non-Yahoo providers
    // (binance/custom) from this holding's own price history.
    const suffix = investmentId != null ? `&investmentId=${investmentId}` : "";
    navigate(`/portfolio/market?symbol=${encodeURIComponent(symbol)}${suffix}`);
  }

  const totalValue = holdings.reduce((s, h) => s + convertToTarget(h.currentValue, h.currency), 0);
  const totalRealizedGain = holdings.reduce((s, h) => s + convertToTarget(h.realizedGain, h.currency), 0);
  const totalUnrealizedGain = holdings.reduce((s, h) => s + convertToTarget(h.unrealizedGain, h.currency), 0);
  const totalFees = holdings.reduce((s, h) => s + convertToTarget(h.totalFees, h.currency), 0);
  const totalTaxes = holdings.reduce((s, h) => s + convertToTarget(h.totalTaxes, h.currency), 0);
  const netGain = totalRealizedGain + totalUnrealizedGain - totalFees - totalTaxes;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('crypto.title')} icon={Bitcoin} />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('crypto.title')} icon={Bitcoin} />
        <PageError message={error?.message ?? t('common.error')} onRetry={() => refetch()} />
      </div>
    );
  }

  if (holdings.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t('crypto.title')}
          icon={Bitcoin}
          actions={<AddInvestmentDialog allowedAssetClasses={[ 'crypto' ]} />}
        />
        <Card className="group relative overflow-hidden surface-elevated premium-frame bg-card backdrop-blur-sm">
          <CardContent className="pt-0">
            <EmptyState
              icon={Bitcoin}
              title={t('crypto.noCrypto')}
              description={t('crypto.noCryptoDesc')}
              action={<AddInvestmentDialog allowedAssetClasses={[ 'crypto' ]} />}
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
        title={t('crypto.title')}
        icon={Bitcoin}
        actions={<AddInvestmentDialog allowedAssetClasses={[ 'crypto' ]} />}
      />

      <StalePricesBanner
        investments={holdings}
        onRefresh={refreshPrices}
        isRefreshing={isRefreshingPrices}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
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
                {totalUnrealizedGain >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
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
                  <th className="py-2 px-3 text-left font-medium text-muted-foreground">{t('portfolio.asset')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.units')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.avgCost')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.price')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.value')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.unrealized')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.realized')}</th>
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
                          <button
                            type="button"
                            className="block text-xs text-muted-foreground hover:underline cursor-pointer"
                            onDoubleClick={() => openMarketLookup(h.symbol, h.id)}
                            onKeyDown={onActivateKeyDown(() => openMarketLookup(h.symbol, h.id))}
                            title={h.symbol ? t('watchlist.doubleClickChart') : undefined}
                          >
                            {h.name}
                          </button>
                        </div>
                      </div>
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums font-mono">{h.totalUnits.toFixed(6)}</td>
                    <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">{fmt(convertToTarget(h.avgCostBasis, h.currency))}</td>
                    <td className="text-right py-2 px-3 tabular-nums">
                      <span className="inline-flex items-center gap-1 justify-end">
                        {fmt(convertToTarget(h.currentPrice ?? 0, h.currency))}
                        <StalePriceIndicator
                          priceProvider={h.price_provider}
                          priceUpdatedAt={h.price_updated_at}
                        />
                      </span>
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums font-medium">{fmt(convertToTarget(h.currentValue, h.currency))}</td>
                    <td className={cn("text-right py-2 px-3 tabular-nums font-medium", h.unrealizedGain >= 0 ? "text-accent" : "text-destructive")}>
                      {h.unrealizedGain >= 0 ? "+" : ""}{fmt(convertToTarget(h.unrealizedGain, h.currency))}
                      <span className="text-xs ml-1 opacity-70">{fmtPct(h.gainLossPercent)}</span>
                    </td>
                    <td className={cn("text-right py-2 px-3 tabular-nums", h.realizedGain !== 0 ? (h.realizedGain >= 0 ? "text-accent" : "text-destructive") : "text-muted-foreground")}>
                      {h.realizedGain !== 0 ? `${h.realizedGain >= 0 ? "+" : ""}${fmt(convertToTarget(h.realizedGain, h.currency))}` : '—'}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                        <InvestmentDetailDialog 
                          investment={h} 
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
                              title: t('crypto.deleteAsset'), 
                              description: t('crypto.deleteAssetDesc', { name: h.name }), 
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
          <p className="text-sm text-muted-foreground">{t('crypto.howItWorks')}</p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
