import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "@/components/ui/card";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Database, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { toast } from "sonner";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    formatDateStringWithAppSettings,
    formatDateTimeStringWithAppSettings,
} from "@/lib/dateUtils";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { EmptyState } from "@/components/shared/EmptyState";
import { exchangeRateKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useTabParam } from "@/hooks/useTabParam";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    Table,
    TableBody,
    TableCaption,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { PageShell } from "@/components/shared/PageShell";
import { useExchangeRatesQuery } from "@/features/admin/useAdminQueries";

const EXCHANGE_RATE_TABS = ["live", "fallback"] as const;

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

    return (
        <Table>
            {showFallbackNote && (
                <TableCaption className="px-4 pb-4 text-left type-footnote text-label-secondary">
                    {t("exchangeRates.fallbackNote")}
                </TableCaption>
            )}
            <TableHeader>
                <TableRow className="hover:bg-transparent">
                    <TableHead scope="col">
                        {t("exchangeRates.col.currency")}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                        {t("exchangeRates.col.unitToEur")}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                        {t("exchangeRates.col.eurToUnit")}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                        {t("exchangeRates.col.hundredInEur")}
                    </TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map(({ currency, rate }) => (
                    <TableRow key={currency}>
                        <TableCell className="font-mono font-medium">
                            {currency}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                            {rate.toLocaleString(locale, {
                                minimumFractionDigits: 6,
                                maximumFractionDigits: 6,
                            })}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                            {(1 / rate).toLocaleString(locale, {
                                minimumFractionDigits: 4,
                                maximumFractionDigits: 4,
                            })}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                            {formatCurrency(
                                100 * rate,
                                "EUR",
                                locale,
                                appSettings.showDecimalPlaces ?? 2,
                            )}
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

export default function ExchangeRatesPage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const queryClient = useQueryClient();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const [activeTab, setActiveTab] = useTabParam(EXCHANGE_RATE_TABS, "live");

    // Share the one exchange-rates cache entry: same flat key, queryFn, and
    // staleTime as useExchangeRates/useCurrencyConverter, so this page reads
    // the copy every other consumer already fetched instead of a third
    // duplicate. "Refresh" below invalidates the shared namespace for everyone.
    const { data, isLoading, error, isFetching, refetch } =
        useExchangeRatesQuery();

    const refreshMutation = useMutation({
        mutationFn: () => apiClient.refreshExchangeRates(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: exchangeRateKeys.all });
            toast.success(t("exchangeRates.refreshSuccess"));
        },
        onError: () => {
            toast.error(t("exchangeRates.refreshError"));
        },
    });

    const isRefreshing = refreshMutation.isPending || isFetching;

    const header = (
        <PageHeader
            title={t("exchangeRates.title")}
            subtitle={t("exchangeRates.subtitle")}
            icon={PAGE_ICONS["/admin/exchange-rates"]}
            actions={
                <Button
                    variant="outline"
                    onClick={() => refreshMutation.mutate()}
                    disabled={isRefreshing || isLoading}
                >
                    <RefreshCw
                        aria-hidden="true"
                        className={cn(isRefreshing && "animate-spin")}
                    />
                    {t("exchangeRates.refresh")}
                </Button>
            }
        />
    );

    if (isLoading) {
        return (
            <PageShell {...loadingSurfaceProps}>
                {header}
                <div className="grid gap-4 xl:grid-cols-3">
                    {Array.from({ length: 3 }).map((_, index) => (
                        <Card key={index} className="min-w-0">
                            <CardContent
                                variant="headerless"
                                className="space-y-3"
                            >
                                <Skeleton className="h-4 w-28" />
                                <Skeleton className="h-7 w-20" />
                                <Skeleton className="h-3 w-36" />
                            </CardContent>
                        </Card>
                    ))}
                </div>
                <Skeleton className="h-9 w-56 rounded-control" />
                <Skeleton className="h-72 w-full rounded-card" />
            </PageShell>
        );
    }

    if (error) {
        return (
            <PageShell>
                {header}
                <PageError
                    message={t("exchangeRates.failedToLoad")}
                    onRetry={() => void refetch()}
                />
            </PageShell>
        );
    }

    const liveRates = data?.rates ?? [];
    const rateDate = liveRates[0]?.rate_date ?? null;
    const fetchedAt = liveRates[0]?.fetched_at ?? null;
    const formattedRateDate = rateDate
        ? formatDateStringWithAppSettings(rateDate, appSettings.dateFormat)
        : "—";

    const fallbackEntries = Object.entries(data?.fallback_rates ?? {})
        .filter(([k]) => k !== "EUR")
        .sort(([a], [b]) => a.localeCompare(b));

    // The three summary cards differ only in icon/title/value/subtext.
    const summaryCards = [
        {
            icon: Database,
            title: t("exchangeRates.storedRates"),
            value: (data?.total_rates ?? 0).toLocaleString(locale),
            sub: t("exchangeRates.storedRatesDesc"),
        },
        {
            icon: Globe,
            title: t("exchangeRates.fallbackCurrencies"),
            value: fallbackEntries.length.toLocaleString(locale),
            sub: t("exchangeRates.fallbackCurrenciesDesc"),
        },
        {
            icon: RefreshCw,
            title: t("exchangeRates.latestFetch"),
            value: formattedRateDate,
            sub: fetchedAt
                ? t("exchangeRates.fetchedAt", {
                      date: formatDateTimeStringWithAppSettings(
                          fetchedAt,
                          appSettings.dateFormat,
                          locale,
                      ),
                  })
                : t("exchangeRates.noDataFetched"),
        },
    ];

    return (
        <PageShell>
            {header}

            <div className="grid gap-4 xl:grid-cols-3">
                {summaryCards.map(({ icon: Icon, title, value, sub }) => (
                    <Card key={title} className="min-w-0">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle variant="label">{title}</CardTitle>
                            <Icon
                                aria-hidden="true"
                                className="h-4 w-4 text-label-tertiary"
                            />
                        </CardHeader>
                        <CardContent>
                            <p className="type-title-1 tabular-nums text-foreground">
                                {value}
                            </p>
                            <p className="mt-1 type-footnote text-label-secondary">
                                {sub}
                            </p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <SegmentedControl
                value={activeTab}
                onValueChange={setActiveTab}
                aria-label={t("exchangeRates.viewLabel")}
                className="w-full sm:w-auto"
            >
                <SegmentedControlItem value="live">
                    <Database className="h-4 w-4" aria-hidden="true" />
                    {t("exchangeRates.liveRates")}
                </SegmentedControlItem>
                <SegmentedControlItem value="fallback">
                    <Globe className="h-4 w-4" aria-hidden="true" />
                    {t("exchangeRates.fallbackRates")}
                </SegmentedControlItem>
            </SegmentedControl>

            {activeTab === "live" ? (
                liveRates.length === 0 ? (
                    <Card>
                        <CardContent variant="state">
                            <EmptyState
                                size="compact"
                                icon={Database}
                                title={t("exchangeRates.latestEcbRates")}
                                description={t("exchangeRates.noRates")}
                                action={
                                    <Button
                                        variant="outline"
                                        onClick={() => refreshMutation.mutate()}
                                        disabled={isRefreshing}
                                    >
                                        <RefreshCw
                                            aria-hidden="true"
                                            className={cn(
                                                isRefreshing && "animate-spin",
                                            )}
                                        />
                                        {t("exchangeRates.refresh")}
                                    </Button>
                                }
                            />
                        </CardContent>
                    </Card>
                ) : (
                    <Card>
                        <CardHeader>
                            <CardTitle variant="sm">
                                {t("exchangeRates.latestEcbRates")}
                            </CardTitle>
                            <CardDescription>
                                {t("exchangeRates.latestEcbDesc", {
                                    count: liveRates.length,
                                    date: formattedRateDate,
                                    fetchedAt: fetchedAt
                                        ? formatDateTimeStringWithAppSettings(
                                              fetchedAt,
                                              appSettings.dateFormat,
                                              locale,
                                          )
                                        : "",
                                })}
                            </CardDescription>
                        </CardHeader>
                        <CardContent variant="flush">
                            <RatesTable
                                rows={liveRates.map((r) => ({
                                    currency: r.currency,
                                    rate: r.rate_to_eur,
                                }))}
                            />
                        </CardContent>
                    </Card>
                )
            ) : (
                <Card>
                    <CardHeader>
                        <CardTitle variant="sm">
                            {t("exchangeRates.fallbackRates")}
                        </CardTitle>
                        <CardDescription>
                            {t("exchangeRates.fallbackDesc")}
                        </CardDescription>
                    </CardHeader>
                    <CardContent variant="flush">
                        <RatesTable
                            rows={fallbackEntries.map(([currency, rate]) => ({
                                currency,
                                rate: rate as number,
                            }))}
                            showFallbackNote
                        />
                    </CardContent>
                </Card>
            )}
        </PageShell>
    );
}
