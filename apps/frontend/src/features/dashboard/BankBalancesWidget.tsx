import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "@/components/ui/card";
import { CardSheen } from "@/components/shared/CardSheen";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { cashflowKeys } from "@/lib/queryKeys";
import {
    formatCurrency,
    formatCurrencyCompact,
    numberFormatToLocale,
} from "@/utils/currency";
import { Landmark, Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    AreaChart,
    type AreaSeries,
    ChartLegend,
    type ChartLegendItem,
} from "@/components/charts";
import {
    appLanguageToLocale,
    CHART_DATE_PATTERNS,
    formatDate,
    parseISO,
} from "@/lib/dateUtils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useAccounts } from "@/hooks/useAccounts";
import { useBalanceProvenance } from "@/features/accounts/balanceProvenance";
import { useDriftBadge } from "@/features/accounts/driftBadge";
import {
    CompactValueDisclosure,
    TouchDisclosure,
} from "@/components/shared/TouchDisclosure";
import { badgeVariants } from "@/components/ui/badge";
import { TextLink } from "@/components/shared/TextLink";

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
    const { t, language } = useLanguage();
    const monthLabelLocale = appLanguageToLocale(language);
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();

    const locale = numberFormatToLocale(appSettings.numberFormat);
    const integerLocaleFormatter = new Intl.NumberFormat(locale);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const { data, isLoading, error } = useQuery({
        queryKey: cashflowKeys.bankBalances(defaultCurrency),
        queryFn: () => apiClient.getBankBalances({ currency: defaultCurrency }),
        staleTime: 60_000,
    });
    // The account entity is the source of truth for the balance CARDS: same
    // accounts, same shared balance source (computed_balance, ADR-094 Phase C)
    // the Accounts hub reads. getBankBalances still backs the history chart +
    // net-position total (both now read that shared source server-side).
    // Load archived entities too: history/net-position aggregation is governed
    // by in_net_worth, so an inactive-but-counted account still needs its
    // display name in the chart. Cards stay active-only below.
    const { data: accountsData, isLoading: accountsLoading } = useAccounts({
        active: "all",
    });
    // Balance provenance subline (WP-B2) — the entity payload carries
    // anchor_date/post_anchor_count, same fields the Accounts hub cards read.
    const balanceProvenance = useBalanceProvenance();
    // Drift chip (§3 F1) — the SAME text + stale-tone rule the Accounts hub
    // badge uses, so the dashboard can't disagree with the hub about a drift.
    const driftBadge = useDriftBadge();

    // The ~365-point × N-accounts chart dataset (and its derived series/legend)
    // is expensive to build and produced a fresh `data`/`series` identity on
    // every dashboard re-render, defeating chart-level memoization. Memoize it
    // on the balance payload and account entities so it rebuilds only when the
    // chart data or its user-facing labels change.
    const chartBundle = useMemo(() => {
        if (!data) return null;
        const { accounts, history, total_history } = data;
        const displayLabelByAccountName = new Map(
            (accountsData?.items ?? []).map((account) => [
                account.name,
                account.display_name || account.name,
            ]),
        );

        // CHART: include any account with a non-zero balance anywhere in history,
        // not just a non-zero current balance — an account closed last month
        // (current 0, large past balances) must still appear in the 12-month chart.
        const chartAccounts = accounts.filter((acct) => {
            if (Math.abs(acct.balance) > 0.000001) return true;
            return (history[acct.bank_account] || []).some(
                (h) => Math.abs(h.balance) > 0.000001,
            );
        });

        // Index each account's history by date first — a per-entry .find() would
        // be O(days²) at ~365 points.
        const balancesByAccount = new Map<string, Map<string, number>>(
            chartAccounts.map((acct) => [
                acct.bank_account,
                new Map(
                    (history[acct.bank_account] || []).map((h) => [
                        h.date,
                        h.balance,
                    ]),
                ),
            ]),
        );
        const chartData: BankChartDatum[] = total_history.map((entry) => {
            const values: Record<string, number> = {};
            for (const acct of chartAccounts) {
                values[acct.bank_account] =
                    balancesByAccount.get(acct.bank_account)?.get(entry.date) ??
                    0;
            }
            return {
                date: parseISO(entry.date),
                values,
                total: entry.balance,
            };
        });

        // visx AreaStack cumulates band edges, which is meaningless/overlapping
        // once a series goes negative (overdraft/credit line). Stack only when
        // every value is ≥ 0; otherwise render truthful unstacked multi-lines.
        const hasNegativeBalances = chartData.some((d) =>
            Object.values(d.values).some((v) => v < 0),
        );

        const accountSeries: AreaSeries<BankChartDatum>[] = chartAccounts.map(
            (acct, idx) => ({
                key: acct.bank_account,
                // Keep the aggregation name as the data key, but label the series
                // from the same account entity source as the cards above it.
                label:
                    displayLabelByAccountName.get(acct.bank_account) ??
                    shortAccountName(acct.bank_account),
                accessor: (d) => d.values[acct.bank_account] ?? 0,
                color: ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length],
                strokeWidth: 2,
            }),
        );

        const legendItems: ChartLegendItem[] = accountSeries.map((s) => ({
            label: s.label ?? s.key,
            color: s.color ?? "hsl(var(--chart-1))",
        }));

        return {
            chartAccounts,
            chartData,
            hasNegativeBalances,
            accountSeries,
            legendItems,
        };
    }, [accountsData, data]);

    if (isLoading || accountsLoading) {
        return (
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle>{t("bankWidget.title")}</CardTitle>
                </CardHeader>
                <CardContent {...loadingSurfaceProps} className="space-y-4">
                    <Skeleton className="h-24 w-full rounded-xl" />
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {[...Array(3)].map((_, i) => (
                            <Skeleton
                                key={i}
                                className="h-20 w-full rounded-xl"
                            />
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
                    <CardTitle>{t("bankWidget.title")}</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">
                        {t("bankWidget.unableToLoad")}
                    </p>
                </CardContent>
            </Card>
        );
    }

    const { accounts, total_net_position } = data;

    // Transaction counts still come from the balances aggregation. Join them
    // to entity-backed cards by canonical account id so a stale or divergent
    // display key cannot silently hide the count.
    const countByAccountId = new Map(
        accounts.map((acct) => [acct.account_id, acct.transaction_count]),
    );

    // Balance CARDS come from the account ENTITY now: only accounts carrying a
    // non-zero computed balance (the shared source), so a card always maps 1:1
    // to a real account that opens in the detail sheet.
    const entityAccounts = accountsData?.items ?? [];
    const balanceCards = entityAccounts.filter(
        (a) =>
            a.is_active &&
            a.computed_balance != null &&
            Math.abs(a.computed_balance) > 0.000001,
    );

    // Memoized above (rebuilds when balance data or account labels change);
    // non-null once past the loading/error guards.
    const {
        chartAccounts,
        chartData,
        hasNegativeBalances,
        accountSeries,
        legendItems,
    } = chartBundle!;

    const isPositive = total_net_position >= 0;

    return (
        <div className="space-y-4">
            {/* Total Net Position Card */}
            <Card
                variant="interactive"
                className="group relative overflow-hidden"
            >
                <CardSheen />
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle variant="label">
                        {t("bankWidget.netPosition")}
                    </CardTitle>
                    <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/10 text-primary icon-tile-glow">
                        <Wallet className="h-5 w-5" />
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="text-3xl font-bold tabular-nums text-foreground">
                        {(() => {
                            const r = formatCurrencyCompact(
                                total_net_position,
                                defaultCurrency,
                                locale,
                            );
                            return (
                                <CompactValueDisclosure
                                    display={r.display}
                                    fullValue={r.isCompact ? r.full : undefined}
                                />
                            );
                        })()}
                    </div>
                    <p
                        className={cn(
                            "text-xs font-medium mt-2 flex items-center gap-1",
                            isPositive ? "text-gain" : "text-loss",
                        )}
                    >
                        {isPositive ? (
                            <TrendingUp className="h-3 w-3" />
                        ) : (
                            <TrendingDown className="h-3 w-3" />
                        )}
                        {/* The count MUST describe the population summed into the
                            total right above it (§3 F3). `total_net_position` is
                            the sum over exactly `data.accounts` (server-side:
                            non-liability, in_net_worth, with ledger activity), so
                            the count is that array's length — NOT the balance
                            cards below, which are a differently gated
                            (active-only, non-zero-balance) entity population. */}
                        {t("bankWidget.acrossAccounts", {
                            n: accounts.length.toString(),
                        })}
                    </p>
                </CardContent>
            </Card>

            {/* Per-Account Balance Cards — driven by the account entity; the
                account-name link opens the shared account detail view. */}
            {balanceCards.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {balanceCards.map((a, idx) => {
                        const color =
                            ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length];
                        const balance = a.computed_balance ?? 0;
                        const acctPositive = balance >= 0;
                        const label = a.display_name || a.name;
                        const txCount = countByAccountId.get(a.id);
                        const provenanceText = balanceProvenance(a);
                        const drift = driftBadge(a);
                        return (
                            <Card
                                key={a.id}
                                className="group transition-shadow hover:shadow-glass-soft"
                            >
                                <CardContent variant="compact">
                                    <div className="flex items-start justify-between mb-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <div
                                                className="h-3 w-3 rounded-full shrink-0 ring-2 ring-offset-1 ring-offset-card transition-transform duration-normal group-hover:scale-125"
                                                style={
                                                    {
                                                        backgroundColor: color,
                                                        ["--tw-ring-color"]:
                                                            color,
                                                    } as React.CSSProperties
                                                }
                                            />
                                            <TextLink
                                                to={`/accounts/${a.id}`}
                                                className="min-w-0 truncate text-xs font-semibold tracking-tight text-muted-foreground"
                                            >
                                                {label}
                                            </TextLink>
                                        </div>
                                        <Landmark className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                                    </div>
                                    <div
                                        className={cn(
                                            "text-xl font-bold tabular-nums",
                                            acctPositive
                                                ? "text-foreground"
                                                : "text-loss",
                                        )}
                                    >
                                        {/* `computed_balance` is denominated in the ACCOUNT's currency
                                            (ADR-094: a multi-currency account's partitions are converted
                                            into `a.currency`, not into the app default), so it must be
                                            labelled with `a.currency` — the same idiom the Accounts hub
                                            card uses (AccountsPage: fmtCur(a.computed_balance, a.currency));
                                            group subtotals there convert first (sumConvertedBalances).
                                            Labelling it `defaultCurrency` put a € sign on a $ figure. The
                                            total/chart above stay in `defaultCurrency` because the server
                                            converts THAT payload for the requested currency. */}
                                        {(() => {
                                            const r = formatCurrencyCompact(
                                                balance,
                                                a.currency,
                                                locale,
                                            );
                                            return (
                                                <CompactValueDisclosure
                                                    display={r.display}
                                                    fullValue={
                                                        r.isCompact
                                                            ? r.full
                                                            : undefined
                                                    }
                                                />
                                            );
                                        })()}
                                    </div>
                                    {provenanceText && (
                                        <div className="mt-1 truncate text-xs text-muted-foreground">
                                            <TouchDisclosure
                                                label={provenanceText}
                                                content={provenanceText}
                                                className="max-w-full truncate"
                                            >
                                                {provenanceText}
                                            </TouchDisclosure>
                                        </div>
                                    )}
                                    {txCount != null && (
                                        <div className="text-xs text-muted-foreground mt-1">
                                            {t("bankWidget.transactions", {
                                                n: integerLocaleFormatter.format(
                                                    txCount,
                                                ),
                                            })}
                                        </div>
                                    )}
                                    {drift && (
                                        // Read-only chip; reconciliation remains on
                                        // the account detail page.
                                        <div className="mt-1.5">
                                            <TouchDisclosure
                                                label={drift.tooltip}
                                                content={drift.tooltip}
                                                className={badgeVariants({
                                                    variant: drift.variant,
                                                })}
                                            >
                                                {drift.label}
                                            </TouchDisclosure>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}

            {/* Historical Balance Chart */}
            {chartAccounts.length > 0 && chartData.length > 1 && (
                <Card>
                    <CardHeader>
                        <CardTitle>{t("bankWidget.balanceHistory")}</CardTitle>
                        <CardDescription>
                            {t("bankWidget.balanceHistoryDesc")}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <AreaChart<BankChartDatum>
                            syncId="dashboard-timeline"
                            scrubbable
                            data={chartData}
                            xAccessor={(d) => d.date}
                            series={accountSeries}
                            stacked={!hasNegativeBalances}
                            height={320}
                            // Daily datapoints (~365) now outnumber the time-scale
                            // auto-ticks, so the width-derived tick spacing is fine —
                            // no more duplicated "MMM yy" labels between sparse points.
                            xTickFormat={(v) =>
                                formatDate(
                                    v as Date,
                                    CHART_DATE_PATTERNS.monthTick,
                                    monthLabelLocale,
                                )
                            }
                            yTickFormat={(v) =>
                                formatCurrency(v, defaultCurrency, locale)
                            }
                            tooltipTitle={(d) =>
                                formatDate(
                                    d.date,
                                    CHART_DATE_PATTERNS.detail,
                                    monthLabelLocale,
                                )
                            }
                            tooltipValueFormat={(v) =>
                                formatCurrency(v, defaultCurrency, locale)
                            }
                        />
                        <ChartLegend items={legendItems} align="center" />
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
