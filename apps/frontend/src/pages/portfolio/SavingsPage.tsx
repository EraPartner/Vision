import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { parseYmd, daysBetween } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/EmptyState";

function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  return Math.ceil(daysBetween(new Date(), parseYmd(dateStr)));
}

export default function SavingsPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const { byAssetClass, deleteInvestment, isLoading, isError, error, refetch } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const accounts = byAssetClass(['savings', 'bond']);

  const { convertToTarget } = useCurrencyConverter(targetCurrency);

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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('savings.title')} icon={PiggyBank} />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('savings.title')} icon={PiggyBank} />
        <PageError message={error?.message ?? t('common.error')} onRetry={() => refetch()} />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t('savings.title')}
          icon={PiggyBank}
          actions={<AddInvestmentDialog allowedAssetClasses={[ 'savings', 'bond' ]} />}
        />
        <Card className="group relative overflow-hidden surface-elevated premium-frame bg-card backdrop-blur-sm">
          <CardContent className="pt-0">
            <EmptyState
              icon={PiggyBank}
              title={t('savings.noAccounts')}
              description={t('savings.noAccountsDesc')}
              action={<AddInvestmentDialog allowedAssetClasses={[ 'savings', 'bond' ]} />}
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
        title={t('savings.title')}
        icon={PiggyBank}
        actions={<AddInvestmentDialog />}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-primary/15">
                <DollarSign className="h-3 w-3" />
              </span>
              {t('portfolio.totalBalance')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-primary tabular-nums">{fmt(totalBalance)}</p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-accent/20 to-accent/5 text-accent ring-1 ring-accent/15">
                <Percent className="h-3 w-3" />
              </span>
              {t('portfolio.avgInterestRate')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-accent tabular-nums">{weightedRate.toFixed(2)}%</p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-accent/20 to-accent/5 text-accent ring-1 ring-accent/15">
                <TrendingUp className="h-3 w-3" />
              </span>
              {t('portfolio.interestEarned')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-accent tabular-nums">+{fmt(totalInterestEarned)}</p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm border-l-4 border-l-primary">
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
                        <Button variant="ghost" size="icon" className="icon-touch-target">
                          <Eye className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <AddPortfolioTxnDialog investment={a} />
                    <Button variant="ghost" size="icon" className="icon-touch-target text-muted-foreground hover:text-destructive"
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
          <p className="text-sm text-muted-foreground">{t('savings.howItWorks')}</p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
