import { useCallback, useEffect, useMemo, useState } from "react";
import { Money } from "@/components/shared/Money";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, ArrowRight, Store, Hash, DollarSign, Filter } from "lucide-react";
import { parseISO } from "@/components/shared/dateUtils";
import { useSettings } from "@/contexts/SettingsContext";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateWithAppSettings } from "@/components/shared/dateUtils";

type RecipientDetailRow = {
  recipientId: number;
  name: string;
  totalSpend: number;
  transactionCount: number;
  avgAmount: number;
  firstSeen: string;
  lastSeen: string;
};

interface RecipientInsightsTabProps {
  /** Statistics-derived top recipients chart (with exclusion toggle support) */
  statisticsTopRecipientsChart?: React.ReactNode;
}

export function RecipientInsightsTab({ statisticsTopRecipientsChart }: RecipientInsightsTabProps) {
  const { settings } = useSettings();
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const targetCurrency = appSettings.defaultCurrency || "EUR";
  // Memoise the common-case formatter instead of constructing a new
  // Intl.NumberFormat on every formatCurrency call. A non-default
  // fractionDigits override (rare) still builds a one-off formatter.
  const defaultCurrencyFormatter = useMemo(
    () => new Intl.NumberFormat(locale, {
      style: "currency",
      currency: appSettings.defaultCurrency || "EUR",
      minimumFractionDigits: appSettings.showDecimalPlaces,
      maximumFractionDigits: appSettings.showDecimalPlaces,
    }),
    [locale, appSettings.defaultCurrency, appSettings.showDecimalPlaces],
  );
  const formatCurrency = useCallback((val: number, fractionDigits = appSettings.showDecimalPlaces) => {
    if (fractionDigits === appSettings.showDecimalPlaces) {
      return defaultCurrencyFormatter.format(val);
    }
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: appSettings.defaultCurrency || "EUR",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(val);
  }, [defaultCurrencyFormatter, locale, appSettings.defaultCurrency, appSettings.showDecimalPlaces]);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["recipient-insights", targetCurrency],
    queryFn: () => apiClient.getRecipientInsights({ currency: targetCurrency }),
    staleTime: 60000,
  });

  const exclusionsApply = settings.exclusionScope === 'everywhere' || settings.exclusionScope === 'statistics';
  const excludedRecipientIds = useMemo(
    () => new Set(exclusionsApply ? settings.excludedRecipientIds : []),
    [exclusionsApply, settings.excludedRecipientIds]
  );

  const filteredData = useMemo(() => {
    if (!data) return null;
    if (excludedRecipientIds.size === 0) return data;
    return {
      topMerchants: data.topMerchants.filter(m => !excludedRecipientIds.has(m.recipientId)),
      monthOverMonth: data.monthOverMonth.filter(m => !excludedRecipientIds.has(m.recipientId)),
    };
  }, [data, excludedRecipientIds]);

  const PAGE_SIZE = appSettings.defaultPageSize;
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);

  const totalMerchants = filteredData?.topMerchants.length ?? 0;

  // Reset to first page whenever the filtered list changes (e.g. exclusion toggle)
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [totalMerchants, PAGE_SIZE]);

  const displayedMerchants = useMemo(
    () => filteredData?.topMerchants.slice(0, displayCount) ?? [],
    [filteredData, displayCount]
  );
  const hasMore = displayCount < totalMerchants;
  const handleLoadMore = useCallback(() => {
    setDisplayCount(prev => Math.min(prev + PAGE_SIZE, totalMerchants));
  }, [PAGE_SIZE, totalMerchants]);

  const recipientDetailsColumns = useMemo(() => [
    {
      key: "rank",
      header: "#",
      sortable: false,
      filterable: false,
      className: "w-14",
      render: (_row: RecipientDetailRow, _isEditing: boolean, index?: number) => (
        <span className="font-medium text-muted-foreground">{(index ?? 0) + 1}</span>
      ),
    },
    {
      key: "name",
      header: t('txPage.col.recipient'),
      render: (row: RecipientDetailRow) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "totalSpend",
      header: t('insights.col.totalSpend'),
      className: "text-right",
      render: (row: RecipientDetailRow) => <span className="font-mono"><Money amount={row.totalSpend} /></span>,
    },
    {
      key: "transactionCount",
      header: t('insights.transactionCount'),
      className: "text-right",
    },
    {
      key: "avgAmount",
      header: t('insights.col.avgAmount'),
      className: "text-right",
      render: (row: RecipientDetailRow) => <span className="font-mono"><Money amount={row.avgAmount} /></span>,
    },
    {
      key: "firstSeen",
      header: t('insights.col.firstSeen'),
      className: "text-right",
      render: (row: RecipientDetailRow) => (
        <span className="text-muted-foreground text-sm">{formatDateWithAppSettings(parseISO(row.firstSeen), appSettings.dateFormat)}</span>
      ),
    },
    {
      key: "lastSeen",
      header: t('insights.col.lastSeen'),
      className: "text-right",
      render: (row: RecipientDetailRow) => (
        <span className="text-muted-foreground text-sm">{formatDateWithAppSettings(parseISO(row.lastSeen), appSettings.dateFormat)}</span>
      ),
    },
  ], [t, appSettings.dateFormat, formatCurrency]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (isError || !filteredData) {
    return <p className="text-muted-foreground">{t('insights.failedToLoad')}</p>;
  }

  const top10 = filteredData.topMerchants.slice(0, 10);
  const totalTopSpend = top10.reduce((s, m) => s + m.totalSpend, 0);
  const totalTopTx = top10.reduce((s, m) => s + m.transactionCount, 0);
  const avgTopAmount = totalTopTx > 0 ? totalTopSpend / totalTopTx : 0;

  const increases = filteredData.monthOverMonth.filter(m => m.changePercent > 0);
  const decreases = filteredData.monthOverMonth.filter(m => m.changePercent < 0);

  return (
    <div className="space-y-6">
      {excludedRecipientIds.size > 0 && (
        <Badge variant="secondary" className="gap-1.5">
          <Filter className="h-3 w-3" />
          {t('insights.excluded', { n: excludedRecipientIds.size })}
        </Badge>
      )}

      {/* KPI cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('insights.topRecipient')}</CardTitle>
            <Store className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{top10[0]?.name || "—"}</div>
            <p className="text-xs text-muted-foreground">
              {top10[0] ? formatCurrency(top10[0].totalSpend) : t('insights.noDataFallback')}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('insights.top10Total')}</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold"><Money amount={totalTopSpend} /></div>
            <p className="text-xs text-muted-foreground">{totalTopTx} {t('insights.transactionCount').toLowerCase()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('insights.avgTransaction')}</CardTitle>
            <Hash className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold"><Money amount={avgTopAmount} /></div>
            <p className="text-xs text-muted-foreground">{t('insights.acrossTop10')}</p>
          </CardContent>
        </Card>
      </div>

      {/* Statistics-derived chart with exclusion toggle */}
      {statisticsTopRecipientsChart}

      {/* Month over month alerts */}
      {filteredData.monthOverMonth.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('insights.momChanges')}</CardTitle>
            <CardDescription>{t('insights.momDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {increases.length > 0 && (
              <div className="space-y-2">
                {increases.map((m) => (
                  <div key={m.recipientId} className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                    <TrendingUp className="h-5 w-5 text-destructive shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {t('insights.spentMoreAt', { n: m.changePercent.toFixed(1), name: m.name })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatCurrency(m.previousSpend, 2)} <ArrowRight className="inline h-3 w-3" /> {formatCurrency(m.currentSpend, 2)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {decreases.length > 0 && (
              <div className="space-y-2">
                {decreases.map((m) => (
                  <div key={m.recipientId} className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <TrendingDown className="h-5 w-5 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {t('insights.spentLessAt', { n: Math.abs(m.changePercent).toFixed(1), name: m.name })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatCurrency(m.previousSpend, 2)} <ArrowRight className="inline h-3 w-3" /> {formatCurrency(m.currentSpend, 2)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <VirtualDataTable
        title={t('insights.detailsTitle')}
        subtitle={t('insights.detailsSubtitle')}
        columns={recipientDetailsColumns}
        data={displayedMerchants}
        totalItems={totalMerchants}
        hasMore={hasMore}
        onLoadMore={handleLoadMore}
        emptyMessage={t('insights.detailsEmpty')}
        maxHeight={700}
        rowHeight={48}
      />
    </div>
  );
}
