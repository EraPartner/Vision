import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/dashboard/StatCard";
import { Button } from "@/components/ui/button";
import { Building2, Trash2, Eye, TrendingUp, DollarSign, Home, MapPin, Percent } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/EmptyState";
import { DeltaPill } from "@/components/shared/DeltaPill";

export default function RealEstatePage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const { byAssetClass, deleteInvestment, isLoading, isError, error, refetch } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const properties = byAssetClass('real_estate');

  const { convertToTarget } = useCurrencyConverter(targetCurrency);

  function fmt(
    val: number,
    currency = targetCurrency,
    decimals = appSettings.showDecimalPlaces
  ) {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(val);
  }

  function fmtNum(val: number, decimals = 2) {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(val);
  }

  const totalValue = properties.reduce((s, p) => s + convertToTarget(p.currentValue, p.currency), 0);
  const totalCost = properties.reduce((s, p) => s + convertToTarget(p.totalBuyCost, p.currency), 0);
  const totalAppreciation = properties.reduce((s, p) => s + convertToTarget(p.totalAppreciation, p.currency), 0);
  const totalRentIncome = properties.reduce((s, p) => s + convertToTarget(p.totalIncome, p.currency), 0);
  const totalFees = properties.reduce((s, p) => s + convertToTarget(p.totalFees, p.currency), 0);
  const totalTaxes = properties.reduce((s, p) => s + convertToTarget(p.totalTaxes, p.currency), 0);
  
  // Estimate monthly rent from most recent rent_income transactions
  const estimatedMonthlyRent = properties.reduce((s, p) => {
    const rentTxns = p.transactions.filter(t => t.type === 'rent_income');
    if (rentTxns.length === 0) return s;
    // Use most recent rent as monthly estimate
    return s + convertToTarget(rentTxns[0]?.amount ?? 0, p.currency);
  }, 0);
  
  const annualYield = totalValue > 0 ? (estimatedMonthlyRent * 12) / totalValue * 100 : 0;
  const totalReturn = totalAppreciation + totalRentIncome - totalFees - totalTaxes;
  const roi = totalCost > 0 ? (totalReturn / totalCost) * 100 : 0;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('realestate.title')} icon={Building2} />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('realestate.title')} icon={Building2} />
        <PageError message={error?.message ?? t('common.error')} onRetry={() => refetch()} />
      </div>
    );
  }

  if (properties.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t('realestate.title')}
          icon={Building2}
          actions={<AddInvestmentDialog allowedAssetClasses={[ 'real_estate' ]} />}
        />
        <Card className="group relative overflow-hidden glass-regular premium-frame">
          <CardContent className="pt-0">
            <EmptyState
              icon={Building2}
              title={t('realestate.noProperties')}
              description={t('realestate.noPropertiesDesc')}
              action={<AddInvestmentDialog allowedAssetClasses={[ 'real_estate' ]} />}
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
        title={t('realestate.title')}
        icon={Building2}
        actions={<AddInvestmentDialog />}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard size="compact" title={t('portfolio.totalValue')} value={fmt(totalValue)}
          icon={DollarSign} valueClassName="text-primary" />
        <StatCard size="compact" title={t('portfolio.totalCost')} value={fmt(totalCost)}
          icon={Home} valueClassName="text-muted-foreground" />
        <StatCard size="compact" title={t('portfolio.appreciation')}
          value={`${totalAppreciation >= 0 ? "+" : ""}${fmt(totalAppreciation)}`}
          icon={TrendingUp} trend={totalAppreciation >= 0 ? "income" : "expense"}
          valueClassName={totalAppreciation >= 0 ? "amount-gain" : "amount-loss"} />
        <StatCard size="compact" title={t('portfolio.rentalIncome')} value={`+${fmt(totalRentIncome)}`}
          trend="income" valueClassName="text-gain"
          subtitle={`~${fmt(estimatedMonthlyRent)}${t('realestate.perMonth')}`} />
        <StatCard size="compact" title={t('portfolio.yield')} value={`${annualYield.toFixed(1)}%`}
          icon={Percent} subtitle={t('portfolio.annual')} />
        <StatCard size="compact" title={t('portfolio.totalReturn')}
          value={`${totalReturn >= 0 ? "+" : ""}${fmt(totalReturn)}`}
          trend={totalReturn >= 0 ? "income" : "expense"}
          valueClassName={totalReturn >= 0 ? "amount-gain" : "amount-loss"}>
          <div className="mt-1 flex items-center gap-1.5">
            <DeltaPill value={roi} label={`${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`} />
            <span className="text-xs text-muted-foreground">{t('portfolio.totalROI')}</span>
          </div>
        </StatCard>
      </div>

      {/* Property Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {properties.map((p) => {
          const propertyCost = convertToTarget(p.totalBuyCost, p.currency);
          const propertyReturn = convertToTarget(p.totalAppreciation + p.totalIncome - p.totalFees - p.totalTaxes, p.currency);
          const propertyROI = propertyCost > 0
            ? (propertyReturn / propertyCost) * 100
            : 0;
          const monthlyRent = convertToTarget(p.transactions.filter(t => t.type === 'rent_income')[0]?.amount ?? 0, p.currency);
          const currentValueInTarget = convertToTarget(p.currentValue, p.currency);
          const propertyYield = currentValueInTarget > 0 ? (monthlyRent * 12) / currentValueInTarget * 100 : 0;
          
          return (
            <Card key={p.id} className="glass-regular overflow-hidden">
              <CardHeader className="bg-muted/30">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Building2 className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{p.name}</CardTitle>
                      {p.location && (
                        <CardDescription className="flex items-center gap-1 mt-0.5">
                          <MapPin className="h-3 w-3" /> {p.location}
                        </CardDescription>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <InvestmentDetailDialog 
                      investment={p} 
                      trigger={
                        <Button variant="ghost" size="icon" className="icon-touch-target" aria-label={t('portfolio.viewDetails')} title={t('portfolio.viewDetails')}>
                          <Eye className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <AddPortfolioTxnDialog investment={p} />
                     <Button variant="ghost" size="icon" className="icon-touch-target text-muted-foreground hover:text-destructive"
                      aria-label={t('realestate.deleteProperty')} title={t('realestate.deleteProperty')}
                      onClick={async () => {
                        const ok = await confirm({ 
                          title: t('realestate.deleteProperty'), 
                          description: t('realestate.deletePropertyDesc', { name: p.name }), 
                          confirmLabel: t('common.delete'), 
                          variant: "destructive" 
                        }); 
                        if (ok) deleteInvestment(p.id); 
                      }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              
              <CardContent className="pt-4 space-y-4">
                {/* Value Summary */}
                  <div className="grid grid-cols-2 gap-4">
                   <div>
                     <p className="text-xs text-muted-foreground mb-1">{t('portfolio.purchasePrice')}</p>
                     <p className="text-xl font-bold tabular-nums">{fmt(convertToTarget(p.totalBuyCost, p.currency))}</p>
                   </div>
                   <div className="text-right">
                     <p className="text-xs text-muted-foreground mb-1">{t('portfolio.currentValue')}</p>
                      <p className="text-xl font-bold text-primary tabular-nums">{fmt(convertToTarget(p.currentValue, p.currency))}</p>
                   </div>
                 </div>

                  {/* Returns Breakdown */}
                  <div className="grid grid-cols-2 gap-3">
                   <div className="p-3 rounded-lg bg-muted/50">
                     <p className="text-xs text-muted-foreground mb-1">{t('portfolio.appreciation')}</p>
                     <p className={cn(
                       "text-lg font-bold tabular-nums",
                       p.totalAppreciation >= 0 ? "amount-gain" : "amount-loss"
                     )}>
                        {p.totalAppreciation >= 0 ? "+" : ""}{fmt(convertToTarget(p.totalAppreciation, p.currency))}
                     </p>
                  </div>

                  {/* Municipality / cadastral info for real estate */}
                  {(p.municipality || p.cadastral_income || p.cadastral_income === 0 || p.municipality_tax_rate || p.municipality_tax_rate === 0) && (
                    <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                      {p.municipality && (
                        <div className="p-2 rounded-lg bg-muted/50">
                          <p className="text-xs text-muted-foreground">{t('invDetail.municipality')}</p>
                          <p className="font-medium truncate">{p.municipality}</p>
                        </div>
                      )}

                      {(p.cadastral_income || p.cadastral_income === 0) && (
                        <div className="p-2 rounded-lg bg-muted/50">
                          <p className="text-xs text-muted-foreground">{t('invDetail.cadastralIncome')}</p>
                           <p className="font-medium tabular-nums">{fmt(convertToTarget(p.cadastral_income || 0, p.currency))}</p>
                        </div>
                      )}

                      {(p.municipality_tax_rate || p.municipality_tax_rate === 0) && (
                        <div className="p-2 rounded-lg bg-muted/50">
                          <p className="text-xs text-muted-foreground">{t('invDetail.municipalityTaxRate')}</p>
                          <p className="font-medium tabular-nums">{fmtNum(p.municipality_tax_rate || 0)}%</p>
                        </div>
                      )}
                    </div>
                  )}
                   <div className="p-3 rounded-lg bg-muted/50">
                     <p className="text-xs text-muted-foreground mb-1">{t('portfolio.rentalIncome')}</p>
                     <p className="text-lg font-bold text-gain tabular-nums">
                       +{fmt(convertToTarget(p.totalIncome, p.currency))}
                     </p>
                     {monthlyRent > 0 && (
                        <p className="text-xs text-muted-foreground">~{fmt(monthlyRent)}{t('realestate.perMonth')}</p>
                     )}
                   </div>
                 </div>

                 {/* Yield & ROI */}
                 <div className="flex items-center justify-between py-3 border-t border-border">
                   <div>
                     <p className="text-xs text-muted-foreground">{t('portfolio.yield')}</p>
                     <p className="text-sm font-medium">{propertyYield.toFixed(1)}% {t('portfolio.annual')}</p>
                   </div>
                   <div className="flex flex-col items-end gap-1">
                     <p className="text-xs text-muted-foreground">{t('portfolio.totalROI')}</p>
                     <DeltaPill value={propertyROI} label={`${propertyROI >= 0 ? "+" : ""}${propertyROI.toFixed(1)}%`} />
                   </div>
                 </div>

                 {/* Expenses */}
                 {(p.totalFees > 0 || p.totalTaxes > 0) && (
                   <div className="flex justify-between text-sm border-t border-border pt-3">
                     <span className="text-muted-foreground">{t('portfolio.feesAndTaxes')}</span>
                      <span className="font-medium text-loss">-{fmt(convertToTarget(p.totalFees + p.totalTaxes, p.currency))}</span>
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
          <p className="text-sm text-muted-foreground">{t('realestate.howItWorks')}</p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
