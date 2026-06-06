import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
        <Card className="group relative overflow-hidden surface-elevated premium-frame bg-card backdrop-blur-sm">
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
        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-primary/15">
                <DollarSign className="h-3 w-3" />
              </span>
              {t('portfolio.totalValue')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-primary tabular-nums">{fmt(totalValue)}</p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-muted-foreground/20 to-muted-foreground/5 text-muted-foreground ring-1 ring-muted-foreground/15">
                <Home className="h-3 w-3" />
              </span>
              {t('portfolio.totalCost')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-muted-foreground tabular-nums">{fmt(totalCost)}</p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <span className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br ring-1",
                totalAppreciation >= 0
                  ? "from-accent/20 to-accent/5 text-accent ring-accent/15"
                  : "from-destructive/20 to-destructive/5 text-destructive ring-destructive/15"
              )}>
                <TrendingUp className="h-3 w-3" />
              </span>
              {t('portfolio.appreciation')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className={cn("text-xl font-bold tabular-nums", totalAppreciation >= 0 ? "text-accent" : "text-destructive")}>
              {totalAppreciation >= 0 ? "+" : ""}{fmt(totalAppreciation)}
            </p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t('portfolio.rentalIncome')}</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-accent tabular-nums">+{fmt(totalRentIncome)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">~{fmt(estimatedMonthlyRent)}{t('realestate.perMonth')}</p>
          </CardContent>
        </Card>

        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-foreground/15 to-foreground/5 text-foreground ring-1 ring-foreground/10">
                <Percent className="h-3 w-3" />
              </span>
              {t('portfolio.yield')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className="text-xl font-bold text-foreground tabular-nums">{annualYield.toFixed(1)}%</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t('portfolio.annual')}</p>
          </CardContent>
        </Card>

        <Card className={cn("group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm border-l-4", totalReturn >= 0 ? "border-l-accent" : "border-l-destructive")}>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t('portfolio.totalReturn')}</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <p className={cn("text-xl font-bold tabular-nums", totalReturn >= 0 ? "text-accent" : "text-destructive")}>
              {totalReturn >= 0 ? "+" : ""}{fmt(totalReturn)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{roi >= 0 ? "+" : ""}{roi.toFixed(1)}% {t('portfolio.totalROI')}</p>
          </CardContent>
        </Card>
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
            <Card key={p.id} className="overflow-hidden">
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
                       p.totalAppreciation >= 0 ? "text-accent" : "text-destructive"
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
                     <p className="text-lg font-bold text-accent tabular-nums">
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
                   <div className="text-right">
                     <p className="text-xs text-muted-foreground">{t('portfolio.totalROI')}</p>
                     <p className={cn(
                       "text-sm font-bold",
                       propertyROI >= 0 ? "text-accent" : "text-destructive"
                     )}>
                       {propertyROI >= 0 ? "+" : ""}{propertyROI.toFixed(1)}%
                     </p>
                   </div>
                 </div>

                 {/* Expenses */}
                 {(p.totalFees > 0 || p.totalTaxes > 0) && (
                   <div className="flex justify-between text-sm border-t border-border pt-3">
                     <span className="text-muted-foreground">{t('portfolio.feesAndTaxes')}</span>
                      <span className="font-medium text-destructive">-{fmt(convertToTarget(p.totalFees + p.totalTaxes, p.currency))}</span>
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
          <p className="text-sm text-muted-foreground">{t('realestate.howItWorks')}</p>
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog />
    </>
  );
}
