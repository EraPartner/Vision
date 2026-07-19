import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/dashboard/StatCard";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, Trash2, Bitcoin, Eye, DollarSign, ArrowUpRight } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
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
import { useCurrencyFormatter, useCurrencyPartsFormatter } from "@/hooks/useCurrencyFormatter";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import { onActivateKeyDown } from "@/utils/a11y";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { FxPnlCell } from "@/components/portfolio/FxPnlCell";
import { fmtPct } from "@/utils/percent";

export default function CryptoPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const { byAssetClass, deleteInvestment, refreshPrices, isRefreshingPrices, isLoading, isError, error, refetch } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const holdings = byAssetClass('crypto');

  const { convertToTarget } = useCurrencyConverter(targetCurrency);

  // Per-investment FX attribution from the backend summary (historical rates);
  // only rendered when a holding is denominated in a foreign currency.
  const { data: apiSummary } = usePortfolioSummaryQuery(targetCurrency);
  const fxInfoById = new Map((apiSummary?.summaries ?? []).map((s) => [s.id, s]));
  const pageHasFxExposure = holdings.some((h) => (h.originalCurrency || h.currency || 'EUR').toUpperCase() !== targetCurrency.toUpperCase());

  const fmt = useCurrencyFormatter(targetCurrency);
  const fmtParts = useCurrencyPartsFormatter(targetCurrency);

  function openMarketLookup(symbol?: string, investmentId?: number) {
    if (!symbol) return;
    // Pass the holding id so the market page can chart non-Yahoo providers
    // (binance/custom) from this holding's own price history.
    const suffix = investmentId != null ? `&investmentId=${investmentId}` : "";
    navigate(`/research/market?symbol=${encodeURIComponent(symbol)}${suffix}`);
  }

  const totalValue = holdings.reduce((s, h) => s + convertToTarget(h.currentValue, h.currency), 0);
  const totalRealizedGain = holdings.reduce((s, h) => s + convertToTarget(h.realizedGain, h.currency), 0);
  const totalUnrealizedGain = holdings.reduce((s, h) => s + convertToTarget(h.unrealizedGain, h.currency), 0);
  const totalFees = holdings.reduce((s, h) => s + convertToTarget(h.totalFees, h.currency), 0);
  const totalTaxes = holdings.reduce((s, h) => s + convertToTarget(h.totalTaxes, h.currency), 0);
  // realizedGain/unrealizedGain already fold the per-row fees/taxes columns into
  // cost basis (calculateCostBasis), so net gain subtracts ONLY standalone
  // fee/tax transaction rows — totalFees/totalTaxes would double-count the columns.
  const feeTxns = holdings.reduce((s, h) => s + convertToTarget(h.feeTransactions ?? 0, h.currency), 0);
  const taxTxns = holdings.reduce((s, h) => s + convertToTarget(h.taxTransactions ?? 0, h.currency), 0);
  const netGain = totalRealizedGain + totalUnrealizedGain - feeTxns - taxTxns;

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
        <Card className="group relative overflow-hidden glass-regular premium-frame">
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
        <StatCard size="compact" title={t('portfolio.portfolioValue')}
          value={<RollingNumber parts={fmtParts(totalValue)} />}
          icon={DollarSign} valueClassName="text-primary" />
        <StatCard size="compact" title={t('portfolio.realizedPnl')}
          value={<RollingNumber parts={fmtParts(totalRealizedGain, { signed: true })} />}
          icon={ArrowUpRight} trend={totalRealizedGain >= 0 ? "income" : "expense"}
          valueClassName={totalRealizedGain >= 0 ? "amount-gain" : "amount-loss"} />
        <StatCard size="compact" title={t('portfolio.unrealizedPnl')}
          value={<RollingNumber parts={fmtParts(totalUnrealizedGain, { signed: true })} />}
          icon={totalUnrealizedGain >= 0 ? TrendingUp : TrendingDown}
          trend={totalUnrealizedGain >= 0 ? "income" : "expense"}
          valueClassName={totalUnrealizedGain >= 0 ? "amount-gain" : "amount-loss"} />
        <StatCard size="compact" title={t('portfolio.feesAndTaxes')}
          value={<RollingNumber parts={fmtParts(-(totalFees + totalTaxes), { signed: true })} />}
          trend="expense" valueClassName="text-loss" />

        <StatCard size="compact" title={t('portfolio.netReturn')}
          value={<RollingNumber parts={fmtParts(netGain, { signed: true })} />}
          trend={netGain >= 0 ? "income" : "expense"}
          valueClassName={netGain >= 0 ? "amount-gain" : "amount-loss"} />
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
                  {pageHasFxExposure && (
                    <th className="py-2 px-3 text-right font-medium text-muted-foreground" title={t('portfolio.fxEffect')}>{t('portfolio.fxPnl')}</th>
                  )}
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
                    <td className={cn("text-right py-2 px-3 tabular-nums font-medium", h.unrealizedGain >= 0 ? "amount-gain" : "amount-loss")}>
                      {h.unrealizedGain >= 0 ? "+" : ""}{fmt(convertToTarget(h.unrealizedGain, h.currency))}
                      <DeltaPill value={h.gainLossPercent} label={fmtPct(h.gainLossPercent)} className="ml-1.5" />
                    </td>
                    <td className={cn("text-right py-2 px-3 tabular-nums", h.realizedGain !== 0 ? (h.realizedGain >= 0 ? "amount-gain" : "amount-loss") : "text-muted-foreground")}>
                      {h.realizedGain !== 0 ? `${h.realizedGain >= 0 ? "+" : ""}${fmt(convertToTarget(h.realizedGain, h.currency))}` : '—'}
                    </td>
                    {pageHasFxExposure && (
                      <FxPnlCell holding={h} fxInfo={fxInfoById.get(h.id)} targetCurrency={targetCurrency} fmt={fmt} t={t} />
                    )}
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity">
                        <InvestmentDetailDialog 
                          investment={h} 
                          trigger={
                            <Button variant="ghost" size="icon" className="icon-touch-target" aria-label={t('portfolio.viewDetails')} title={t('portfolio.viewDetails')}>
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          }
                        />
                        <AddPortfolioTxnDialog investment={h} />
                        <Button variant="ghost" size="icon" className="icon-touch-target text-muted-foreground hover:text-destructive"
                          aria-label={t('crypto.deleteAsset')} title={t('crypto.deleteAsset')}
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
      <Card className="bg-muted/30 !border-dashed">
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">{t('crypto.howItWorks')}</p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
