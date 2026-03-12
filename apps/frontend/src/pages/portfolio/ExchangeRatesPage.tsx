import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, Database, Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api";
import { formatCurrency } from "@/utils/currency";
import { toast } from "sonner";
import { useLanguage } from '@/contexts/LanguageContext';

interface ExchangeRate {
    currency: string;
    rate_to_eur: number;
    rate_date: string;
    fetched_at: string;
}

interface ExchangeRatesData {
    total_rates: number;
    rates: ExchangeRate[];
    fallback_rates: Record<string, number>;
}

export default function ExchangeRatesPage() {
    const { t } = useLanguage();
    const queryClient = useQueryClient();

    const { data, isLoading, error, isFetching } = useQuery<ExchangeRatesData>({
        queryKey: ["exchangeRates"],
        queryFn: () => apiClient.request("/api/info/exchange-rates"),
        staleTime: 60_000,
    });

    const refreshMutation = useMutation({
        mutationFn: () => apiClient.request("/api/info/exchange-rates/refresh", { method: "POST" }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["exchangeRates"] });
            toast.success(t('exchangeRates.refreshSuccess'));
        },
        onError: () => {
            toast.error(t('exchangeRates.refreshError'));
        },
    });

    const isRefreshing = refreshMutation.isPending || isFetching;

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (error) {
        return (
            <Card>
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

    const RatesTable = ({
        rows,
        showFallbackNote,
    }: {
        rows: { currency: string; rate: number }[];
        showFallbackNote?: boolean;
    }) => (
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
                            <td className="py-2 px-3 text-right">{formatCurrency(100 * rate, "EUR")}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {showFallbackNote && (
                <p className="text-xs text-muted-foreground mt-3 px-3">{t('exchangeRates.fallbackNote')}</p>
            )}
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">{t('exchangeRates.title')}</h1>
                    <p className="text-muted-foreground mt-1">{t('exchangeRates.subtitle')}</p>
                </div>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => refreshMutation.mutate()} disabled={isRefreshing}>
                    <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
                    {t('exchangeRates.refresh')}
                </Button>
            </div>

            {/* Summary cards */}
            <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <Database className="h-4 w-4" /> {t('exchangeRates.storedRates')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{data?.total_rates ?? 0}</p>
                        <p className="text-xs text-muted-foreground">{t('exchangeRates.storedRatesDesc')}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <Globe className="h-4 w-4" /> {t('exchangeRates.fallbackCurrencies')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{fallbackEntries.length}</p>
                        <p className="text-xs text-muted-foreground">{t('exchangeRates.fallbackCurrenciesDesc')}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <RefreshCw className="h-4 w-4" /> {t('exchangeRates.latestFetch')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{rateDate ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">
                            {fetchedAt ? t('exchangeRates.fetchedAt', { date: new Date(fetchedAt).toLocaleString() }) : t('exchangeRates.noDataFetched')}
                        </p>
                    </CardContent>
                </Card>
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
                        <Card>
                            <CardContent className="py-8 text-center text-muted-foreground">
                                {t('exchangeRates.noRates')}
                            </CardContent>
                        </Card>
                    ) : (
                        <Card>
                            <CardHeader>
                                <CardTitle className="text-lg">{t('exchangeRates.latestEcbRates')}</CardTitle>
                                <CardDescription>
                                    {t('exchangeRates.latestEcbDesc', { count: liveRates.length, date: rateDate ?? '', fetchedAt: fetchedAt ? new Date(fetchedAt).toLocaleString() : '' })}
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
