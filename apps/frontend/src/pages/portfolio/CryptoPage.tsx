import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, Trash2, Bitcoin, Eye, DollarSign, ArrowUpRight } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { useNavigate } from "react-router-dom";

function fmtPct(val: number) {
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
}

export default function CryptoPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const { byAssetClass, deleteInvestment } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const holdings = byAssetClass('crypto');

  const { data: exchangeData } = useQuery({
    queryKey: ['exchange-rates', targetCurrency],
    queryFn: () => apiClient.request('/api/info/exchange-rates'),
    staleTime: 60_000,
  });

  const ratesToEur: Record<string, number> = {
    EUR: 1,
    ...Object.fromEntries(
      (exchangeData?.rates || []).map((r: { currency: string; rate_to_eur: number }) => [r.currency, Number(r.rate_to_eur)])
    ),
    ...(exchangeData?.fallback_rates || {}),
  };

  function convertToTarget(amount: number, fromCurrency?: string) {
    const from = (fromCurrency || 'EUR').toUpperCase();
    const to = targetCurrency.toUpperCase();
    if (from === to) return amount;
    const rateFrom = ratesToEur[from];
    const rateTo = ratesToEur[to];
    if (!rateFrom || !rateTo) return amount;
    return (amount * rateFrom) / rateTo;
  }

  function fmt(
    val: number,
    currency = targetCurrency,
    decimals = appSettings.showDecimalPlaces
  ) {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(val);
  }

  function openMarketLookup(symbol?: string) {
    if (!symbol) return;
    navigate(`/portfolio/market?symbol=${encodeURIComponent(symbol)}`);
  }

  const totalValue = holdings.reduce((s, h) => s + convertToTarget(h.currentValue, h.currency), 0);
  const totalRealizedGain = holdings.reduce((s, h) => s + convertToTarget(h.realizedGain, h.currency), 0);
  const totalUnrealizedGain = holdings.reduce((s, h) => s + convertToTarget(h.unrealizedGain, h.currency), 0);
  const totalFees = holdings.reduce((s, h) => s + convertToTarget(h.totalFees, h.currency), 0);
  const totalTaxes = holdings.reduce((s, h) => s + convertToTarget(h.totalTaxes, h.currency), 0);
  const netGain = totalRealizedGain + totalUnrealizedGain - totalFees - totalTaxes;

  if (holdings.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground">{t('crypto.title')}</h1>
          <AddInvestmentDialog allowedAssetClasses={[ 'crypto' ]} />
        </div>
        <Card className="border-none shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Bitcoin className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-1">{t('crypto.noCrypto')}</h3>
            <p className="text-muted-foreground text-sm mb-4">
              {t('crypto.noCryptoDesc')}
            </p>
            <AddInvestmentDialog allowedAssetClasses={[ 'crypto' ]} />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">{t('crypto.title')}</h1>
        <AddInvestmentDialog allowedAssetClasses={[ 'crypto' ]} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card className="border-none shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-3 w-3" /> {t('portfolio.portfolioValue')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-primary tabular-nums">{fmt(totalValue)}</p>
          </CardContent>
        </Card>
        
        <Card className="border-none shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <ArrowUpRight className="h-3 w-3" /> {t('portfolio.realizedPnl')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className={cn("text-xl font-bold tabular-nums", totalRealizedGain >= 0 ? "text-accent" : "text-destructive")}>
              {totalRealizedGain >= 0 ? "+" : ""}{fmt(totalRealizedGain)}
            </p>
          </CardContent>
        </Card>
        
        <Card className="border-none shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> {t('portfolio.unrealizedPnl')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className={cn("text-xl font-bold tabular-nums", totalUnrealizedGain >= 0 ? "text-accent" : "text-destructive")}>
              {totalUnrealizedGain >= 0 ? "+" : ""}{fmt(totalUnrealizedGain)}
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t('portfolio.feesAndTaxes')}</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-destructive tabular-nums">-{fmt(totalFees + totalTaxes)}</p>
          </CardContent>
        </Card>
        
        <Card className={cn("border-none border-l-4 shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5", netGain >= 0 ? "border-l-accent" : "border-l-destructive")}>
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
                            onDoubleClick={() => openMarketLookup(h.symbol)}
                            title={h.symbol ? t('watchlist.doubleClickChart') : undefined}
                          >
                            {h.name}
                          </button>
                        </div>
                      </div>
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums font-mono">{h.totalUnits.toFixed(6)}</td>
                    <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">{fmt(convertToTarget(h.avgCostBasis, h.currency))}</td>
                    <td className="text-right py-2 px-3 tabular-nums">{fmt(convertToTarget(h.currentPrice ?? 0, h.currency))}</td>
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
                            <Button variant="ghost" size="icon" className="h-7 w-7">
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          }
                        />
                        <AddPortfolioTxnDialog investment={h} />
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
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
          <p className="text-sm text-muted-foreground" dangerouslySetInnerHTML={{ __html: t('crypto.howItWorks') }} />
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
