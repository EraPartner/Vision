import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { Landmark, Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AreaChart, type AreaSeries, ChartLegend, type ChartLegendItem } from "@/components/charts";
import { format, parseISO } from "date-fns";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";

const ACCOUNT_COLORS = [
    "hsl(var(--chart-1))",
    "hsl(var(--chart-2))",
    "hsl(var(--chart-3))",
    "hsl(var(--chart-4))",
    "hsl(var(--chart-5))",
    "hsl(var(--chart-6))",
    "hsl(var(--chart-7))",
    "hsl(var(--chart-8))",
];

interface BankChartDatum {
    month: string;
    date: Date;
    values: Record<string, number>;
    total: number;
}

function shortAccountName(account: string): string {
    // If it's a long IBAN-style account, show last 8 chars
    if (account.length > 12) {
        return `···${account.slice(-8)}`;
    }
    return account;
}

export function BankBalancesWidget() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const integerLocaleFormatter = new Intl.NumberFormat(locale);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const { data, isLoading, error } = useQuery({
        queryKey: ["bankBalances", defaultCurrency],
        queryFn: () => apiClient.getBankBalances({ currency: defaultCurrency }),
        staleTime: 60_000,
    });

    if (isLoading) {
        return (
            <Card>
                <CardHeader className="flex flex-row items-center gap-2 pb-3">
                    <Landmark className="h-5 w-5 text-primary" />
                    <CardTitle>{t('bankWidget.title')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <Skeleton className="h-24 w-full rounded-xl" />
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {[...Array(3)].map((_, i) => (
                            <Skeleton key={i} className="h-20 w-full rounded-xl" />
                        ))}
                    </div>
                    <Skeleton className="h-48 w-full rounded-xl" />
                </CardContent>
            </Card>
        );
    }

    if (error || !data) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Landmark className="h-5 w-5 text-primary" />
                        {t('bankWidget.title')}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">{t('bankWidget.unableToLoad')}</p>
                </CardContent>
            </Card>
        );
    }

    const { accounts, total_net_position, history, total_history } = data;

    // Do not present accounts with a zero balance on the dashboard.
    const visibleAccounts = accounts.filter((acct) => Math.abs(acct.balance) > 0.000001);

    // Build chart data from total_history
    const chartData: BankChartDatum[] = total_history.map((entry) => {
        const values: Record<string, number> = {};
        for (const acct of visibleAccounts) {
            const acctHistory = history[acct.bank_account] || [];
            const match = acctHistory.find((h) => h.month === entry.month);
            values[acct.bank_account] = match?.balance ?? 0;
        }
        return {
            month: entry.month,
            date: parseISO(entry.month + "-01"),
            values,
            total: entry.balance,
        };
    });

    const accountSeries: AreaSeries<BankChartDatum>[] = visibleAccounts.map((acct, idx) => ({
        key: acct.bank_account,
        label: shortAccountName(acct.bank_account),
        accessor: (d) => d.values[acct.bank_account] ?? 0,
        color: ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length],
        strokeWidth: 2,
    }));

    const legendItems: ChartLegendItem[] = accountSeries.map((s) => ({
        label: s.label ?? s.key,
        color: s.color ?? "hsl(var(--chart-1))",
    }));

    const isPositive = total_net_position >= 0;

    return (
        <div className="space-y-4">
            {/* Total Net Position Card */}
            <Card className="premium-frame micro-lift group relative overflow-hidden border shadow-lg bg-gradient-to-br from-primary/10 to-primary/5">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/10 to-transparent rounded-full -mr-16 -mt-16" />
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="text-sm font-semibold text-muted-foreground">
                        {t('bankWidget.netPosition')}
                    </CardTitle>
                    <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/10 shadow-sm">
                        <Wallet className="h-5 w-5 text-primary" />
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="text-3xl font-bold tabular-nums bg-gradient-to-br from-foreground to-muted-foreground bg-clip-text text-transparent">
                        {formatCurrency(total_net_position, defaultCurrency, locale)}
                    </div>
                    <p className={`text-xs font-medium mt-2 flex items-center gap-1 ${isPositive ? "text-accent" : "text-destructive"}`}>
                        {isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {t('bankWidget.acrossAccounts', { n: visibleAccounts.length.toString() })}
                    </p>
                </CardContent>
            </Card>

            {/* Per-Account Balance Cards */}
            {visibleAccounts.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleAccounts.map((acct, idx) => {
                        const color = ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length];
                        const acctPositive = acct.balance >= 0;
                        return (
                            <Card key={acct.bank_account} className="premium-frame group">
                                <CardContent className="pt-4 pb-4 px-4">
                                    <div className="flex items-start justify-between mb-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <div
                                                className="h-3 w-3 rounded-full shrink-0 ring-2 ring-offset-1 ring-offset-card transition-transform duration-300 group-hover:scale-125"
                                                style={{ backgroundColor: color, ringColor: color }}
                                            />
                                            <span className="text-xs font-mono text-muted-foreground truncate" title={acct.bank_account}>
                                                {shortAccountName(acct.bank_account)}
                                            </span>
                                        </div>
                                        <Landmark className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                                    </div>
                                    <div className={`text-xl font-bold tabular-nums ${acctPositive ? "text-foreground" : "text-destructive"}`}>
                                        {formatCurrency(acct.balance, defaultCurrency, locale)}
                                    </div>
                                    <div className="text-xs text-muted-foreground mt-1">
                                        {t('bankWidget.transactions', { n: integerLocaleFormatter.format(acct.transaction_count) })}
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}

            {/* Historical Balance Chart */}
            {visibleAccounts.length > 0 && chartData.length > 1 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Landmark className="h-5 w-5 text-primary" />
                            {t('bankWidget.balanceHistory')}
                        </CardTitle>
                        <CardDescription>{t('bankWidget.balanceHistoryDesc')}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <AreaChart<BankChartDatum>
                            data={chartData}
                            xAccessor={(d) => d.date}
                            series={accountSeries}
                            stacked
                            height={320}
                            xTickFormat={(v) => format(v as Date, "MMM yy")}
                            yTickFormat={(v) => formatCurrency(v, defaultCurrency, locale)}
                            tooltipTitle={(d) => format(d.date, "MMM yy")}
                            tooltipValueFormat={(v) => formatCurrency(v, defaultCurrency, locale)}
                        />
                        <ChartLegend items={legendItems} align="center" />
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
