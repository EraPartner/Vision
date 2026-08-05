import { useCallback, useEffect, useMemo, useState } from "react";
import { Money } from "@/components/shared/Money";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { aggregationKeys } from "@/lib/queryKeys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { Skeleton } from "@/components/ui/skeleton";
import { loadingSurfaceProps } from "@/lib/loadingSurface";
import { TrendingUp, TrendingDown, ArrowRight, Store, Hash, DollarSign, Filter } from "lucide-react";
import { parseISO } from "@/components/shared/dateUtils";
import { useExcludedIds } from "@/hooks/useExcludedIds";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { formatDateWithAppSettings } from "@/components/shared/dateUtils";
import { StatCard } from "@/components/dashboard/StatCard";

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
  // Resolve exclusions (settings + hidden categories, alias-aware) and pass them
  // to the SERVER. The old client-side filter compared raw settings ids against
  // the server's alias-rolled-up primary ids, so excluding an alias filtered
  // nothing, and category/hidden-category exclusions never applied at all.
  const { excludedCategoryIds, excludedRecipientIds, exclusionsApply } = useExcludedIds('statistics');
  const effectiveExcludedCatIds = exclusionsApply ? excludedCategoryIds : [];
  const effectiveExcludedRecIds = exclusionsApply ? excludedRecipientIds : [];
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || "EUR";
  // Shared cached currency formatter; an optional fractionDigits override falls
  // back to the app's showDecimalPlaces setting.
  const formatCurrencyBase = useCurrencyFormatter();
  const formatCurrency = useCallback(
    (val: number, fractionDigits?: number) => formatCurrencyBase(val, undefined, fractionDigits),
    [formatCurrencyBase],
  );
  const { data, isLoading, isError } = useQuery({
    // Keyed under the ['aggregations', …] prefix so invalidateTransactionData
    // (which invalidates the whole aggregations family) reaches this copy too —
    // otherwise it stayed stale until staleTime expiry after a mutation.
    queryKey: aggregationKeys.recipientInsightsWithExclusions(targetCurrency, effectiveExcludedCatIds, effectiveExcludedRecIds),
    queryFn: () => apiClient.getRecipientInsights({
      currency: targetCurrency,
      excluded_category_ids: effectiveExcludedCatIds,
      excluded_recipient_ids: effectiveExcludedRecIds,
    }),
    staleTime: 60000,
  });

  // Server already applied exclusions (alias-aware) — no client-side post-filter.
  const filteredData = data;

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
  ], [t, appSettings.dateFormat]);

  if (isLoading) {
    return (
      <div {...loadingSurfaceProps} className="space-y-6">
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
      {effectiveExcludedRecIds.length > 0 && (
        <Badge variant="secondary" className="gap-1.5">
          <Filter className="h-3 w-3" />
          {t('insights.excluded', { n: effectiveExcludedRecIds.length })}
        </Badge>
      )}

      {/* KPI cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title={t('insights.topRecipient')}
          value={top10[0]?.name || "—"}
          odometer={false}
          icon={Store}
          subtitle={top10[0] ? <Money amount={top10[0].totalSpend} /> : t('insights.noDataFallback')}
        />
        <StatCard
          title={t('insights.top10Total')}
          value={<Money amount={totalTopSpend} />}
          icon={DollarSign}
          subtitle={`${totalTopTx} ${t('insights.transactionCount').toLowerCase()}`}
        />
        <StatCard
          title={t('insights.avgTransaction')}
          value={<Money amount={avgTopAmount} />}
          icon={Hash}
          subtitle={t('insights.acrossTop10')}
        />
      </div>

      {/* Statistics-derived chart with exclusion toggle */}
      {statisticsTopRecipientsChart}

      {/* Month over month alerts */}
      {filteredData.monthOverMonth.length > 0 && (
        <Card className="glass-regular">
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
        serverMode={{ pagination: { totalItems: totalMerchants, hasMore, onLoadMore: handleLoadMore } }}
        emptyMessage={t('insights.detailsEmpty')}
        maxHeight={700}
        rowHeight={48}
      />
    </div>
  );
}
