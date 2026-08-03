import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/dashboard/StatCard";
import { RollingNumber } from "@/components/shared/RollingNumber";
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
import { useCurrencyFormatter, useCurrencyPartsFormatter } from "@/hooks/useCurrencyFormatter";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
import { parseYmd, daysBetween } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Skeleton } from "@/components/ui/skeleton";
import { loadingSurfaceProps } from "@/lib/loadingSurface";
import { EmptyState } from "@/components/shared/EmptyState";

function daysUntil(dateStr?: string) {
  if (!dateStr) return null;
  return Math.ceil(daysBetween(new Date(), parseYmd(dateStr)));
}

export default function SavingsPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const { byAssetClass, deleteInvestment, isLoading, isError, error, refetch } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const accounts = byAssetClass(['savings', 'bond']);

  const { convertToTarget } = useCurrencyConverter(targetCurrency);

  const fmt = useCurrencyFormatter(targetCurrency);
  const fmtParts = useCurrencyPartsFormatter(targetCurrency);

  const totalBalance = accounts.reduce((s, a) => s + convertToTarget(a.currentValue, a.currency), 0);
  const totalInterestEarned = accounts.reduce((s, a) => s + convertToTarget(a.totalIncome, a.currency), 0);
  const totalProjectedAnnual = accounts.reduce((s, a) => s + convertToTarget(a.projectedAnnualInterest, a.currency), 0);
  const totalAccrued = accounts.reduce((s, a) => s + convertToTarget(a.accruedInterest, a.currency), 0);
  const weightedRate = totalBalance > 0
    ? accounts.reduce((s, a) => s + (a.interestRate ?? 0) * convertToTarget(a.currentValue, a.currency), 0) / totalBalance
    : 0;

  if (isLoading) {
    return (
      <div {...loadingSurfaceProps} className="space-y-6">
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
        <PageError title={t('savings.pageErrorTitle')} message={error?.message ?? t('common.error')} onRetry={() => refetch()} />
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
        <Card className="group relative overflow-hidden glass-regular premium-frame">
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
        <StatCard size="compact" title={t('portfolio.totalBalance')}
          value={<RollingNumber parts={fmtParts(totalBalance)} />}
          icon={DollarSign} valueClassName="text-primary" />
        <StatCard size="compact" title={t('portfolio.avgInterestRate')} value={`${weightedRate.toFixed(2)}%`}
          icon={Percent} valueClassName="text-accent" />
        <StatCard size="compact" title={t('portfolio.interestEarned')}
          value={<RollingNumber parts={fmtParts(totalInterestEarned, { signed: true })} />}
          icon={TrendingUp} trend="income" valueClassName="text-gain" />
        <StatCard size="compact" title={t('portfolio.projectedAnnual')}
          value={<RollingNumber parts={fmtParts(totalProjectedAnnual, { signed: true })} />}
          valueClassName="text-primary"
          subtitle={totalAccrued > 0 ? `${fmt(totalAccrued)} ${t('portfolio.accrued')}` : undefined} />
      </div>

      {/* Account Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {accounts.map((a) => {
          const daysToMaturity = daysUntil(a.maturityDate);
          const isMaturingSoon = daysToMaturity !== null && daysToMaturity <= 30 && daysToMaturity > 0;
          const isMatured = daysToMaturity !== null && daysToMaturity <= 0;
          
          return (
            <Card key={a.id} className={cn(
              "transition-[box-shadow,border-color] hover:shadow-glass-soft",
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
                        <Button variant="ghost" size="icon" className="icon-touch-target" aria-label={t('portfolio.viewDetails')} title={t('portfolio.viewDetails')}>
                          <Eye className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <AddPortfolioTxnDialog investment={a} />
                    <Button variant="ghost" size="icon" className="icon-touch-target text-muted-foreground hover:text-destructive"
                      aria-label={t('savings.deleteAccount')} title={t('savings.deleteAccount')}
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
                    <p className="text-2xl font-bold text-gain tabular-nums">+{fmt(convertToTarget(a.totalIncome, a.currency))}</p>
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
                        <span className="font-medium text-gain">+{fmt(convertToTarget(a.accruedInterest, a.currency))}</span>
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
                    <span className="font-medium text-loss">-{fmt(convertToTarget(a.totalFees + a.totalTaxes, a.currency))}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Info Card */}
      <Card className="bg-muted/30 !border-dashed">
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">{t('savings.howItWorks')}</p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
