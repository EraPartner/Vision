import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { Landmark, Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { format, parseISO } from "date-fns";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";

const ACCOUNT_COLORS = [
    "hsl(var(--primary))",
    "hsl(var(--accent))",
    "hsl(210, 70%, 55%)",
    "hsl(280, 60%, 55%)",
    "hsl(30, 80%, 55%)",
    "hsl(170, 60%, 45%)",
];

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
    const chartData = total_history.map((entry) => {
        const point: Record<string, any> = {
            month: format(parseISO(entry.month + "-01"), "MMM yy"),
        };
        // Add per-account data
        for (const acct of visibleAccounts) {
            const acctHistory = history[acct.bank_account] || [];
            const match = acctHistory.find((h) => h.month === entry.month);
            point[acct.bank_account] = match?.balance ?? 0;
        }
        point.total = entry.balance;
        return point;
    });

    const isPositive = total_net_position >= 0;

    return (
        <div className="space-y-4">
            {/* Total Net Position Card */}
            <Card className="relative overflow-hidden border-none shadow-lg bg-gradient-to-br from-primary/10 to-primary/5 backdrop-blur-sm">
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
                    <div className="text-3xl font-bold bg-gradient-to-br from-foreground to-muted-foreground bg-clip-text text-transparent">
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
                            <Card key={acct.bank_account} className="border shadow-sm hover:shadow-md transition-shadow">
                                <CardContent className="pt-4 pb-4 px-4">
                                    <div className="flex items-start justify-between mb-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <div
                                                className="h-3 w-3 rounded-full shrink-0"
                                                style={{ backgroundColor: color }}
                                            />
                                            <span className="text-xs font-mono text-muted-foreground truncate" title={acct.bank_account}>
                                                {shortAccountName(acct.bank_account)}
                                            </span>
                                        </div>
                                        <Landmark className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                                    </div>
                                    <div className={`text-xl font-bold ${acctPositive ? "text-foreground" : "text-destructive"}`}>
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
                    <CardContent>
                        <ResponsiveContainer width="100%" height={320}>
                            <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                                <defs>
                                    {visibleAccounts.map((acct, idx) => (
                                        <linearGradient key={acct.bank_account} id={`gradient-${idx}`} x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor={ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length]} stopOpacity={0.3} />
                                            <stop offset="95%" stopColor={ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length]} stopOpacity={0} />
                                        </linearGradient>
                                    ))}
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                                <XAxis dataKey="month" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
                                <YAxis
                                    tick={{ fontSize: 12 }}
                                    className="fill-muted-foreground"
                                    tickFormatter={(v) => formatCurrency(v, defaultCurrency, locale)}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "8px",
                                        fontSize: "12px",
                                    }}
                                    formatter={(value: number, name: string) => [
                                        formatCurrency(value, defaultCurrency, locale),
                                        name.length > 12 ? shortAccountName(name) : name,
                                    ]}
                                />
                                <Legend
                                    formatter={(value: string) => (
                                        <span className="text-xs text-muted-foreground">
                                            {value.length > 12 ? shortAccountName(value) : value}
                                        </span>
                                    )}
                                />
                                {visibleAccounts.map((acct, idx) => (
                                    <Area
                                        key={acct.bank_account}
                                        type="monotone"
                                        dataKey={acct.bank_account}
                                        stackId="1"
                                        stroke={ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length]}
                                        fill={`url(#gradient-${idx})`}
                                        strokeWidth={2}
                                    />
                                ))}
                            </AreaChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
