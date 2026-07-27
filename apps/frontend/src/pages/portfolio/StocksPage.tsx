import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/dashboard/StatCard";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, Trash2, Eye, DollarSign, ArrowUpRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
import { useFxAwarePnl } from "@/hooks/portfolio/useFxAwarePnl";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { useCurrencyFormatter, useCurrencyPartsFormatter } from "@/hooks/useCurrencyFormatter";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { StalePriceIndicator } from "@/components/portfolio/StalePriceIndicator";
import { StalePricesBanner } from "@/components/portfolio/StalePricesBanner";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import type { AssetClass } from "@/types/portfolio";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Skeleton } from "@/components/ui/skeleton";
import { loadingSurfaceProps } from "@/lib/loadingSurface";
import { onActivateKeyDown } from "@/utils/a11y";
import { EmptyState } from "@/components/shared/EmptyState";
import { ExportDialog } from "@/components/reports/ExportDialog";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { FxPnlCell } from "@/components/portfolio/FxPnlCell";
import { fmtPct } from "@/utils/percent";

interface StocksPageProps {
  assetClasses?: AssetClass[];
  titleKey?: string;
  emptyTitleKey?: string;
  emptyDescriptionKey?: string;
  allowedAddAssetClasses?: AssetClass[];
  enableFxAwarePnl?: boolean;
  /** Page icon shown in the header, empty state, and (combined variant) asset cell. */
  icon?: LucideIcon;
  /** i18n key for the dashed "how it works" info card at the bottom. */
  howItWorksKey?: string;
  /** i18n keys for the delete-confirmation dialog (description key receives {name}). */
  deleteTitleKey?: string;
  deleteDescriptionKey?: string;
  /** Whether the empty-state header also offers the portfolio ExportDialog (Stocks/Metals: yes, Crypto: no). */
  showEmptyStateExport?: boolean;
  /**
   * Whether dividends are surfaced: summary card, table column, and the
   * dividends term inside the net-return card. Crypto hides all three.
   */
  showDividends?: boolean;
  /** Unrealized-P&L card icon follows the sign (up/down) instead of a fixed TrendingUp (Crypto). */
  dynamicUnrealizedIcon?: boolean;
  /**
   * 'split' = separate Symbol and Name columns with an asset-class badge
   * (Stocks/Metals); 'combined' = single Asset column with an icon avatar,
   * symbol, and name stacked (Crypto).
   */
  assetCellVariant?: 'split' | 'combined';
  /** Decimal places for the units column (Stocks: 4, Crypto: 6). */
  unitsDecimals?: number;
  /** Render the units column in a monospace font (Crypto). */
  unitsMonospace?: boolean;
  /**
   * Show avg-cost/price/value converted to the display currency instead of the
   * holding's native currency (Crypto converts, Stocks/Metals stay native).
   */
  priceColumnsInTargetCurrency?: boolean;
  /**
   * Percentage shown in the unrealized pill when enableFxAwarePnl is false:
   * 'costBasis' = unrealizedGain / cost-of-held-units; 'totalReturn' = the
   * legacy gainLossPercent figure (incl. dividends + realized) that CryptoPage
   * has always displayed. Ignored while FX-aware P&L is enabled.
   */
  simplePnlPercentSource?: 'costBasis' | 'totalReturn';
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
  icon: PageIcon = TrendingUp,
  howItWorksKey = 'stocks.howItWorks',
  deleteTitleKey = 'portfolio.deleteInvestment',
  deleteDescriptionKey = 'portfolio.deleteInvestmentDesc',
  showEmptyStateExport = true,
  showDividends = true,
  dynamicUnrealizedIcon = false,
  assetCellVariant = 'split',
  unitsDecimals = 4,
  unitsMonospace = false,
  priceColumnsInTargetCurrency = false,
  simplePnlPercentSource = 'costBasis',
}: StocksPageProps = {}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { appSettings } = useAppSettings();
  const { byAssetClass, deleteInvestment, refreshPrices, isRefreshingPrices, isLoading, isError, error, refetch } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const holdings = useMemo(() => byAssetClass(assetClasses), [byAssetClass, assetClasses]);
  const targetCurrency = appSettings.defaultCurrency || 'EUR';

  const { convertToTarget } = useCurrencyConverter(targetCurrency);
  const computeFxAwarePnl = useFxAwarePnl(targetCurrency);

  // Per-investment FX attribution comes from the backend summary (it has the
  // historical-rate machinery); only shown when a holding is in a foreign currency.
  const { data: apiSummary } = usePortfolioSummaryQuery(targetCurrency);
  const fxInfoById = useMemo(
    () => new Map((apiSummary?.summaries ?? []).map((s) => [s.id, s])),
    [apiSummary],
  );
  const pageHasFxExposure = useMemo(
    () => holdings.some((h) => (h.originalCurrency || h.currency || 'EUR').toUpperCase() !== targetCurrency.toUpperCase()),
    [holdings, targetCurrency],
  );

  const fmt = useCurrencyFormatter(targetCurrency);
  const fmtParts = useCurrencyPartsFormatter(targetCurrency);

  const openMarketLookup = useCallback((symbol?: string, investmentId?: number) => {
    if (!symbol) return;
    // Pass the holding id so the market page can chart non-Yahoo providers
    // (custom/kinesis/binance) from this holding's own price history.
    const suffix = investmentId != null ? `&investmentId=${investmentId}` : "";
    navigate(`/research/market?symbol=${encodeURIComponent(symbol)}${suffix}`);
  }, [navigate]);

  const displayedPnlByHoldingId = useMemo(() => {
    const map: Record<number, { realizedTarget: number; unrealizedTarget: number; unrealizedPercent: number }> = {};
    for (const holding of holdings) {
      if (enableFxAwarePnl) {
        map[holding.id] = computeFxAwarePnl(holding);
        continue;
      }

      // True unrealized % = unrealizedGain / cost-of-held-units (a currency-free
      // ratio). gainLossPercent is total-return (incl. dividends + realized) —
      // the wrong label for an "unrealized %" column — but CryptoPage has always
      // displayed it, so the 'totalReturn' source preserves that page's pill
      // verbatim while 'costBasis' stays the correct default.
      const heldCost = (Number(holding.avgCostBasis) || 0) * (Number(holding.totalUnits) || 0);
      map[holding.id] = {
        realizedTarget: convertToTarget(holding.realizedGain, holding.currency),
        unrealizedTarget: convertToTarget(holding.unrealizedGain, holding.currency),
        unrealizedPercent: simplePnlPercentSource === 'totalReturn'
          ? holding.gainLossPercent
          : heldCost > 0 ? ((Number(holding.unrealizedGain) || 0) / heldCost) * 100 : 0,
      };
    }
    return map;
  }, [holdings, enableFxAwarePnl, computeFxAwarePnl, convertToTarget, simplePnlPercentSource]);

  const totals = useMemo(() => {
    return holdings.reduce((acc, holding) => {
      acc.totalValue += convertToTarget(holding.currentValue, holding.currency);
      acc.totalRealizedGain += displayedPnlByHoldingId[holding.id]?.realizedTarget || 0;
      acc.totalUnrealizedGain += displayedPnlByHoldingId[holding.id]?.unrealizedTarget || 0;
      acc.totalDividends += convertToTarget(holding.totalDividends, holding.currency);
      acc.totalFees += convertToTarget(holding.totalFees, holding.currency);
      acc.totalTaxes += convertToTarget(holding.totalTaxes, holding.currency);
      acc.feeTransactions += convertToTarget(holding.feeTransactions ?? 0, holding.currency);
      acc.taxTransactions += convertToTarget(holding.taxTransactions ?? 0, holding.currency);
      return acc;
    }, {
      totalValue: 0,
      totalRealizedGain: 0,
      totalUnrealizedGain: 0,
      totalDividends: 0,
      totalFees: 0,
      totalTaxes: 0,
      feeTransactions: 0,
      taxTransactions: 0,
    });
  }, [holdings, displayedPnlByHoldingId, convertToTarget]);

  const {
    totalValue,
    totalRealizedGain,
    totalUnrealizedGain,
    totalDividends,
    totalFees,
    totalTaxes,
    feeTransactions,
    taxTransactions,
  } = totals;
  // realized/unrealized (from the FX-aware pool) already net the per-row
  // fees/taxes columns into cost/proceeds, so net gain subtracts ONLY standalone
  // fee/tax transaction rows. Subtracting totalFees/totalTaxes double-counted the
  // per-row columns. (totalFees/totalTaxes remain for the fees-&-taxes display card.)
  // Pages that hide dividends (Crypto) also exclude them from net return.
  const netGain = totalRealizedGain + totalUnrealizedGain + (showDividends ? totalDividends : 0) - feeTransactions - taxTransactions;

  // Stocks/Metals show avg-cost/price/value in the holding's native currency;
  // Crypto shows them converted to the display currency.
  const fmtPriceCol = (value: number, currency?: string) =>
    priceColumnsInTargetCurrency ? fmt(convertToTarget(value, currency)) : fmt(value, currency);

  if (isLoading) {
    return (
      <div {...loadingSurfaceProps} className="space-y-6">
        <PageHeader title={t(titleKey)} icon={PageIcon} />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader title={t(titleKey)} icon={PageIcon} />
        <PageError message={error?.message ?? t('common.error')} onRetry={() => refetch()} />
      </div>
    );
  }

  if (holdings.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t(titleKey)}
          icon={PageIcon}
          actions={showEmptyStateExport
            ? <><ExportDialog defaultType="portfolio" /><AddInvestmentDialog allowedAssetClasses={allowedAddAssetClasses} /></>
            : <AddInvestmentDialog allowedAssetClasses={allowedAddAssetClasses} />}
        />
        <Card className="group relative overflow-hidden glass-regular premium-frame">
          <CardContent className="pt-0">
            <EmptyState
              icon={PageIcon}
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
        icon={PageIcon}
        actions={<AddInvestmentDialog allowedAssetClasses={allowedAddAssetClasses} />}
      />

      <StalePricesBanner
        investments={holdings}
        onRefresh={refreshPrices}
        isRefreshing={isRefreshingPrices}
      />

      {/* Summary Cards */}
      <div className={cn("grid grid-cols-2 sm:grid-cols-3 gap-3", showDividends ? "lg:grid-cols-6" : "lg:grid-cols-5")}>
        <StatCard size="compact" title={t('portfolio.portfolioValue')}
          value={<RollingNumber parts={fmtParts(totalValue)} />}
          icon={DollarSign} valueClassName="text-primary" />
        <StatCard size="compact" title={t('portfolio.realizedPnl')}
          value={<RollingNumber parts={fmtParts(totalRealizedGain, { signed: true })} />}
          icon={ArrowUpRight} trend={totalRealizedGain >= 0 ? "income" : "expense"}
          valueClassName={totalRealizedGain >= 0 ? "amount-gain" : "amount-loss"} />
        <StatCard size="compact" title={t('portfolio.unrealizedPnl')}
          value={<RollingNumber parts={fmtParts(totalUnrealizedGain, { signed: true })} />}
          icon={dynamicUnrealizedIcon && totalUnrealizedGain < 0 ? TrendingDown : TrendingUp}
          trend={totalUnrealizedGain >= 0 ? "income" : "expense"}
          valueClassName={totalUnrealizedGain >= 0 ? "amount-gain" : "amount-loss"} />
        {showDividends && (
          <StatCard size="compact" title={t('portfolio.dividends')}
            value={<RollingNumber parts={fmtParts(totalDividends, { signed: true })} />}
            trend="income" valueClassName="text-gain" />
        )}
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
                  {assetCellVariant === 'split' ? (
                    <>
                      <th className="py-2 px-3 text-left font-medium text-muted-foreground">{t('portfolio.symbol')}</th>
                      <th className="py-2 px-3 text-left font-medium text-muted-foreground">{t('portfolio.name')}</th>
                    </>
                  ) : (
                    <th className="py-2 px-3 text-left font-medium text-muted-foreground">{t('portfolio.asset')}</th>
                  )}
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.units')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.avgCost')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.price')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.value')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.unrealized')}</th>
                  <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.realized')}</th>
                  {pageHasFxExposure && (
                    <th className="py-2 px-3 text-right font-medium text-muted-foreground" title={t('portfolio.fxEffect')}>{t('portfolio.fxPnl')}</th>
                  )}
                  {showDividends && (
                    <th className="py-2 px-3 text-right font-medium text-muted-foreground">{t('portfolio.dividends')}</th>
                  )}
                  <th className="py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors group">
                    {assetCellVariant === 'split' ? (
                      <>
                        <td className="py-2 px-3 font-mono font-bold text-primary">{h.symbol || '—'}</td>
                        <td className="py-2 px-3">
                          <button
                            type="button"
                            className="font-medium text-left hover:underline cursor-pointer"
                            onDoubleClick={() => openMarketLookup(h.symbol, h.id)}
                            onKeyDown={onActivateKeyDown(() => openMarketLookup(h.symbol, h.id))}
                            title={h.symbol ? t('watchlist.doubleClickChart') : undefined}
                          >
                            {h.name}
                          </button>
                           <Badge variant="outline" className="ml-2 text-[10px] px-1.5 py-0">
                             {h.assetClass === 'etf' ? t('stocks.etf') : h.assetClass === 'metals' ? t('portfolio.assetClass.metals') : t('stocks.stock')}
                           </Badge>
                        </td>
                      </>
                    ) : (
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                            <PageIcon className="h-4 w-4 text-primary" />
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
                    )}
                    <td className={cn("text-right py-2 px-3 tabular-nums", unitsMonospace && "font-mono")}>{h.totalUnits.toFixed(unitsDecimals)}</td>
                    <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">{fmtPriceCol(h.avgCostBasis, h.currency)}</td>
                    <td className="text-right py-2 px-3 tabular-nums">
                      <span className="inline-flex items-center gap-1 justify-end">
                        {fmtPriceCol(h.currentPrice ?? 0, h.currency)}
                        <StalePriceIndicator
                          priceProvider={h.price_provider}
                          priceUpdatedAt={h.price_updated_at}
                        />
                      </span>
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums font-medium">{fmtPriceCol(h.currentValue, h.currency)}</td>
                    <td className={cn("text-right py-2 px-3 tabular-nums font-medium", (displayedPnlByHoldingId[h.id]?.unrealizedTarget || 0) >= 0 ? "amount-gain" : "amount-loss")}>
                      {(displayedPnlByHoldingId[h.id]?.unrealizedTarget || 0) >= 0 ? "+" : ""}{fmt(displayedPnlByHoldingId[h.id]?.unrealizedTarget || 0)}
                      <DeltaPill
                        value={displayedPnlByHoldingId[h.id]?.unrealizedPercent || 0}
                        label={fmtPct(displayedPnlByHoldingId[h.id]?.unrealizedPercent || 0)}
                        className="ml-1.5"
                      />
                    </td>
                    <td className={cn("text-right py-2 px-3 tabular-nums", (displayedPnlByHoldingId[h.id]?.realizedTarget || 0) !== 0 ? ((displayedPnlByHoldingId[h.id]?.realizedTarget || 0) >= 0 ? "amount-gain" : "amount-loss") : "text-muted-foreground")}>
                      {(displayedPnlByHoldingId[h.id]?.realizedTarget || 0) !== 0 ? `${(displayedPnlByHoldingId[h.id]?.realizedTarget || 0) >= 0 ? "+" : ""}${fmt(displayedPnlByHoldingId[h.id]?.realizedTarget || 0)}` : '—'}
                    </td>
                    {pageHasFxExposure && (
                      <FxPnlCell holding={h} fxInfo={fxInfoById.get(h.id)} targetCurrency={targetCurrency} fmt={fmt} t={t} />
                    )}
                    {showDividends && (
                      <td className="text-right py-2 px-3 tabular-nums text-gain">
                        {h.totalDividends > 0 ? `+${fmt(convertToTarget(h.totalDividends, h.currency))}` : '—'}
                      </td>
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
                          aria-label={t(deleteTitleKey)} title={t(deleteTitleKey)}
                          onClick={async () => {
                            const ok = await confirm({
                              title: t(deleteTitleKey),
                              description: t(deleteDescriptionKey, { name: h.name }),
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
          <p className="text-sm text-muted-foreground">{t(howItWorksKey)}</p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
