import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, Database, Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api";
import { formatCurrency } from "@/utils/currency";
import { toast } from "sonner";
import { formatCurrency } from "@/utils/currency";

interface ExchangeRate {
    currency: string;
    rate_to_eur: number;
    is_latest: boolean;
    fetched_at: string;
}

interface RateDate {
    date: string;
    currency_count: number;
    rates: ExchangeRate[];
}

interface ExchangeRatesData {
    total_rates: number;
    dates_stored: number;
    dates: RateDate[];
    fallback_rates: Record<string, number>;
}

export default function ExchangeRatesPage() {
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
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
            toast.success("Exchange rates refreshed from ECB");
        },
        onError: () => {
            toast.error("Failed to refresh exchange rates");
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
                    Failed to load exchange rates.
                </CardContent>
            </Card>
        );
    }

    const fallbackEntries = Object.entries(data?.fallback_rates || {})
        .filter(([k]) => k !== "EUR")
        .sort(([a], [b]) => a.localeCompare(b));

    const latestDate = data?.dates?.find(d => d.rates.some(r => r.is_latest));
    const activeDate = selectedDate || latestDate?.date || data?.dates?.[0]?.date;
    const activeDateData = data?.dates?.find(d => d.date === activeDate);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Exchange Rates</h1>
                    <p className="text-muted-foreground mt-1">ECB rates cached in database &amp; fallback values</p>
                </div>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => refetch()} disabled={isFetching}>
                    <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
                    Refresh
                </Button>
            </div>

            {/* Summary cards */}
            <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <Database className="h-4 w-4" /> Stored Rates
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{data?.total_rates ?? 0}</p>
                        <p className="text-xs text-muted-foreground">{data?.dates_stored ?? 0} date(s) cached</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <Globe className="h-4 w-4" /> Fallback Currencies
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{fallbackEntries.length}</p>
                        <p className="text-xs text-muted-foreground">Hardcoded backup rates</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <RefreshCw className="h-4 w-4" /> Latest Fetch
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{latestDate?.date ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">
                            {latestDate ? `${latestDate.currency_count} currencies` : "No data fetched yet"}
                        </p>
                    </CardContent>
                </Card>
            </div>

            <Tabs defaultValue="database" className="space-y-4">
                <TabsList>
                    <TabsTrigger value="database">
                        <Database className="h-4 w-4 mr-1.5" /> Database Rates
                    </TabsTrigger>
                    <TabsTrigger value="fallback">
                        <Globe className="h-4 w-4 mr-1.5" /> Fallback Rates
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="database" className="space-y-4">
                    {(data?.dates?.length ?? 0) === 0 ? (
                        <Card>
                            <CardContent className="py-8 text-center text-muted-foreground">
                                No exchange rates stored in database yet. They will be fetched automatically when currency conversion is needed.
                            </CardContent>
                        </Card>
                    ) : (
                        <>
                            {/* Date selector */}
                            <div className="flex flex-wrap gap-2">
                                {data?.dates?.map(d => (
                                    <Badge
                                        key={d.date}
                                        variant={d.date === activeDate ? "default" : "outline"}
                                        className="cursor-pointer"
                                        onClick={() => setSelectedDate(d.date)}
                                    >
                                        {d.date}
                                        {d.rates.some(r => r.is_latest) && (
                                            <span className="ml-1 text-[10px] opacity-70">latest</span>
                                        )}
                                    </Badge>
                                ))}
                            </div>

                            {/* Rates table for selected date */}
                            {activeDateData && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle className="text-lg">Rates for {activeDate}</CardTitle>
                                        <CardDescription>
                                            {activeDateData.currency_count} currencies •
                                            Fetched {activeDateData.rates[0]?.fetched_at
                                                ? new Date(activeDateData.rates[0].fetched_at).toLocaleString()
                                                : "—"}
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="border-b text-muted-foreground">
                                                        <th className="text-left py-2 px-3 font-medium">Currency</th>
                                                        <th className="text-right py-2 px-3 font-medium">1 unit → EUR</th>
                                                        <th className="text-right py-2 px-3 font-medium">1 EUR →</th>
                                                        <th className="text-right py-2 px-3 font-medium">100 units in EUR</th>
                                                        <th className="text-center py-2 px-3 font-medium">Latest</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {activeDateData.rates.map(r => (
                                                        <tr key={r.currency} className="border-b border-border/50 hover:bg-muted/50">
                                                            <td className="py-2 px-3 font-mono font-medium">{r.currency}</td>
                                                            <td className="py-2 px-3 text-right font-mono">
                                                                {r.rate_to_eur.toFixed(6)}
                                                            </td>
                                                            <td className="py-2 px-3 text-right font-mono">
                                                                {(1 / r.rate_to_eur).toFixed(4)}
                                                            </td>
                                                            <td className="py-2 px-3 text-right">
                                                                {formatCurrency(100 * r.rate_to_eur, "EUR")}
                                                            </td>
                                                            <td className="py-2 px-3 text-center">
                                                                {r.is_latest && <Badge variant="secondary" className="text-[10px]">✓</Badge>}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </CardContent>
                                </Card>
                            )}
                        </>
                    )}
                </TabsContent>

                <TabsContent value="fallback">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg">Hardcoded Fallback Rates</CardTitle>
                            <CardDescription>
                                Used when ECB API and database cache are both unavailable
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b text-muted-foreground">
                                            <th className="text-left py-2 px-3 font-medium">Currency</th>
                                            <th className="text-right py-2 px-3 font-medium">1 unit → EUR</th>
                                            <th className="text-right py-2 px-3 font-medium">1 EUR →</th>
                                            <th className="text-right py-2 px-3 font-medium">100 units in EUR</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {fallbackEntries.map(([currency, rate]) => (
                                            <tr key={currency} className="border-b border-border/50 hover:bg-muted/50">
                                                <td className="py-2 px-3 font-mono font-medium">{currency}</td>
                                                <td className="py-2 px-3 text-right font-mono">
                                                    {(rate as number).toFixed(6)}
                                                </td>
                                                <td className="py-2 px-3 text-right font-mono">
                                                    {(1 / (rate as number)).toFixed(4)}
                                                </td>
                                                <td className="py-2 px-3 text-right">
                                                    {formatCurrency(100 * (rate as number), "EUR")}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    );
}
