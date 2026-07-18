import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, Database, Globe, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api";
import type { ExchangeRatesData } from "@/lib/api/info";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { toast } from "sonner";
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateTimeStringWithAppSettings } from "@/components/shared/dateUtils";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { EXCHANGE_RATES_QUERY_KEY } from "@/hooks/useExchangeRates";
import { cn } from "@/lib/utils";

// Hoisted out of the page component so React keeps the table subtree mounted
// across page re-renders instead of remounting a fresh inline component type.
function RatesTable({
    rows,
    showFallbackNote,
}: {
    rows: { currency: string; rate: number }[];
    showFallbackNote?: boolean;
}) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b text-muted-foreground">
                        <th className="text-left py-2 px-3 font-medium">{t('exchangeRates.col.currency')}</th>
                        <th className="text-right py-2 px-3 font-medium">{t('exchangeRates.col.unitToEur')}</th>
                        <th className="text-right py-2 px-3 font-medium">{t('exchangeRates.col.eurToUnit')}</th>
                        <th className="text-right py-2 px-3 font-medium">{t('exchangeRates.col.hundredInEur')}</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(({ currency, rate }) => (
                        <tr key={currency} className="border-b border-border/50 hover:bg-muted/50">
                            <td className="py-2 px-3 font-mono font-medium">{currency}</td>
                            <td className="py-2 px-3 text-right font-mono">{rate.toFixed(6)}</td>
                            <td className="py-2 px-3 text-right font-mono">{(1 / rate).toFixed(4)}</td>
                            <td className="py-2 px-3 text-right">{formatCurrency(100 * rate, defaultCurrency, locale)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {showFallbackNote && (
                <p className="text-xs text-muted-foreground mt-3 px-3">{t('exchangeRates.fallbackNote')}</p>
            )}
        </div>
    );
}

export default function ExchangeRatesPage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const queryClient = useQueryClient();

    // Share the one exchange-rates cache entry — same flat key, queryFn, and
    // staleTime as useExchangeRates/useCurrencyConverter, so this page reads
    // the copy every other consumer already fetched instead of a third
    // duplicate (the request is always db-only, so the {dbOnly} discriminator
    // carried no information). "Refresh rates" below invalidates the shared
    // namespace for everyone.
    const { data, isLoading, error, isFetching } = useQuery<ExchangeRatesData>({
        queryKey: [EXCHANGE_RATES_QUERY_KEY],
        queryFn: () => apiClient.getExchangeRates({ dbOnly: true }),
        staleTime: 10 * 60_000,
        gcTime: 30 * 60_000,
    });

    const refreshMutation = useMutation({
        mutationFn: () => apiClient.refreshExchangeRates(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: [EXCHANGE_RATES_QUERY_KEY] });
            toast.success(t('exchangeRates.refreshSuccess'));
        },
        onError: () => {
            toast.error(t('exchangeRates.refreshError'));
        },
    });

    const isRefreshing = refreshMutation.isPending || isFetching;

    if (isLoading) {
        return (
            <SectionLoader />
        );
    }

    if (error) {
        return (
            <Card className="glass-regular">
                <CardContent className="py-8 text-center text-muted-foreground">
                    {t('exchangeRates.failedToLoad')}
                </CardContent>
            </Card>
        );
    }

    const liveRates = data?.rates ?? [];
    const rateDate = liveRates[0]?.rate_date ?? null;
    const fetchedAt = liveRates[0]?.fetched_at ?? null;

    const fallbackEntries = Object.entries(data?.fallback_rates ?? {})
        .filter(([k]) => k !== "EUR")
        .sort(([a], [b]) => a.localeCompare(b));

    // The three summary cards differ only in icon/title/value/subtext.
    const summaryCards = [
        {
            icon: Database,
            title: t('exchangeRates.storedRates'),
            value: data?.total_rates ?? 0,
            sub: t('exchangeRates.storedRatesDesc'),
        },
        {
            icon: Globe,
            title: t('exchangeRates.fallbackCurrencies'),
            value: fallbackEntries.length,
            sub: t('exchangeRates.fallbackCurrenciesDesc'),
        },
        {
            icon: RefreshCw,
            title: t('exchangeRates.latestFetch'),
            value: rateDate ?? "—",
            sub: fetchedAt
                ? t('exchangeRates.fetchedAt', {
                    date: formatDateTimeStringWithAppSettings(fetchedAt, appSettings.dateFormat, locale),
                })
                : t('exchangeRates.noDataFetched'),
        },
    ];

    return (
        <div className="space-y-6">
            <PageHeader
                title={t('exchangeRates.title')}
                subtitle={t('exchangeRates.subtitle')}
                icon={Database}
                actions={(
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => refreshMutation.mutate()} disabled={isRefreshing}>
                        <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
                        {t('exchangeRates.refresh')}
                    </Button>
                )}
            />

            {(data?.is_stale || data?.source === 'fallback') && (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                    <AlertTriangle className="h-4 w-4 mt-0.5 text-warning shrink-0" />
                    <div className="text-foreground/80">
                        {data?.source === 'fallback'
                            ? t('exchangeRates.fallbackInUse')
                            : t('exchangeRates.staleWarning', {
                                date: data?.last_fetched_at
                                    ? formatDateTimeStringWithAppSettings(data.last_fetched_at, appSettings.dateFormat, locale)
                                    : '—',
                            })}
                    </div>
                </div>
            )}

            {/* Summary cards */}
            <div className="grid gap-4 sm:grid-cols-3">
                {summaryCards.map(({ icon: Icon, title, value, sub }) => (
                    <Card key={title} className="glass-regular premium-frame">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                <Icon className="h-4 w-4" /> {title}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-2xl font-bold">{value}</p>
                            <p className="text-xs text-muted-foreground">{sub}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <Tabs defaultValue="live" className="space-y-4">
                <TabsList>
                    <TabsTrigger value="live">
                        <Database className="h-4 w-4 mr-1.5" /> {t('exchangeRates.liveRates')}
                    </TabsTrigger>
                    <TabsTrigger value="fallback">
                        <Globe className="h-4 w-4 mr-1.5" /> {t('exchangeRates.fallbackRates')}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="live">
                    {liveRates.length === 0 ? (
                        <Card className="glass-regular">
                            <CardContent className="py-8 text-center text-muted-foreground">
                                {t('exchangeRates.noRates')}
                            </CardContent>
                        </Card>
                    ) : (
                        <Card>
                            <CardHeader>
                                <CardTitle className="text-lg">{t('exchangeRates.latestEcbRates')}</CardTitle>
                                <CardDescription>
                                    {t('exchangeRates.latestEcbDesc', {
                                        count: liveRates.length,
                                        date: rateDate ?? '',
                                        fetchedAt: fetchedAt
                                            ? formatDateTimeStringWithAppSettings(fetchedAt, appSettings.dateFormat, locale)
                                            : '',
                                    })}
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <RatesTable rows={liveRates.map(r => ({ currency: r.currency, rate: r.rate_to_eur }))} />
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                <TabsContent value="fallback">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg">{t('exchangeRates.fallbackRates')}</CardTitle>
                            <CardDescription>
                                {t('exchangeRates.fallbackDesc')}
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <RatesTable
                                rows={fallbackEntries.map(([currency, rate]) => ({ currency, rate: rate as number }))}
                                showFallbackNote
                            />
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    );
}
