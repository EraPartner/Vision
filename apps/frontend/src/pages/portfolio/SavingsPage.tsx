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
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now = new Date();
  const diff = Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

export default function SavingsPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const { byAssetClass, deleteInvestment } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const accounts = byAssetClass(['savings', 'bond']);

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

  const totalBalance = accounts.reduce((s, a) => s + convertToTarget(a.currentValue, a.currency), 0);
  const totalInterestEarned = accounts.reduce((s, a) => s + convertToTarget(a.totalIncome, a.currency), 0);
  const totalProjectedAnnual = accounts.reduce((s, a) => s + convertToTarget(a.projectedAnnualInterest, a.currency), 0);
  const totalAccrued = accounts.reduce((s, a) => s + convertToTarget(a.accruedInterest, a.currency), 0);
  const weightedRate = totalBalance > 0
    ? accounts.reduce((s, a) => s + (a.interestRate ?? 0) * convertToTarget(a.currentValue, a.currency), 0) / totalBalance
    : 0;

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground">{t('savings.title')}</h1>
          <AddInvestmentDialog allowedAssetClasses={[ 'savings', 'bond' ]} />
        </div>
        <Card className="border-none shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <PiggyBank className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold mb-1">{t('savings.noAccounts')}</h3>
            <p className="text-muted-foreground text-sm mb-4">
              {t('savings.noAccountsDesc')}
            </p>
            <AddInvestmentDialog allowedAssetClasses={[ 'savings', 'bond' ]} />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">{t('savings.title')}</h1>
        <AddInvestmentDialog />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="border-none shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-3 w-3" /> {t('portfolio.totalBalance')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-primary tabular-nums">{fmt(totalBalance)}</p>
          </CardContent>
        </Card>
        
        <Card className="border-none shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Percent className="h-3 w-3" /> {t('portfolio.avgInterestRate')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-accent tabular-nums">{weightedRate.toFixed(2)}%</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> {t('portfolio.interestEarned')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-accent tabular-nums">+{fmt(totalInterestEarned)}</p>
          </CardContent>
        </Card>
        
        <Card className="border-none border-l-4 border-l-primary shadow-lg card-elevated hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t('portfolio.projectedAnnual')}</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-primary tabular-nums">+{fmt(totalProjectedAnnual)}</p>
            {totalAccrued > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">{fmt(totalAccrued)} {t('portfolio.accrued')}</p>
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
                          {a.assetClass === 'savings' ? t('portfolio.savings') : t('portfolio.bond')}
                        </Badge>
                        {a.interestRate && (
                          <span className="text-xs font-medium text-accent">{a.interestRate}% {t('savings.pa')}</span>
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
                          title: t('savings.deleteAccount'), 
                          description: t('savings.deleteAccountDesc', { name: a.name }), 
                          confirmLabel: t('common.delete'), 
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
                    <p className="text-xs text-muted-foreground mb-1">{t('portfolio.currentBalance')}</p>
                    <p className="text-2xl font-bold tabular-nums">{fmt(convertToTarget(a.currentValue, a.currency))}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground mb-1">{t('portfolio.interestEarned')}</p>
                    <p className="text-2xl font-bold text-accent tabular-nums">+{fmt(convertToTarget(a.totalIncome, a.currency))}</p>
                  </div>
                </div>
                
                {/* Projections for fixed income */}
                {a.interestRate && a.projectedAnnualInterest > 0 && (
                  <div className="p-3 rounded-lg bg-muted/50 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{t('portfolio.projectedAnnualInterest')}</span>
                      <span className="font-medium text-primary">+{fmt(convertToTarget(a.projectedAnnualInterest, a.currency))}</span>
                    </div>
                    {a.accruedInterest > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">{t('portfolio.accruedUnpaid')}</span>
                        <span className="font-medium text-accent">+{fmt(convertToTarget(a.accruedInterest, a.currency))}</span>
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
                        {isMatured ? t('portfolio.matured') : t('portfolio.matures')}
                      </span>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">
                        {formatDateStringWithAppSettings(a.maturityDate, appSettings.dateFormat)}
                      </p>
                      {!isMatured && daysToMaturity !== null && (
                        <p className={cn(
                          "text-xs",
                          isMaturingSoon ? "text-primary" : "text-muted-foreground"
                        )}>
                          {t('portfolio.daysRemaining', { days: String(daysToMaturity) })}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Cost Breakdown */}
                {(a.totalFees > 0 || a.totalTaxes > 0) && (
                  <div className="flex justify-between text-sm border-t border-border pt-3">
                    <span className="text-muted-foreground">{t('portfolio.feesAndTaxesPaid')}</span>
                    <span className="font-medium text-destructive">-{fmt(convertToTarget(a.totalFees + a.totalTaxes, a.currency))}</span>
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
          <p className="text-sm text-muted-foreground" dangerouslySetInnerHTML={{ __html: t('savings.howItWorks') }} />
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
