import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { LucideIcon } from "lucide-react";
import {
    Archive,
    Eye,
    FileDown,
    Info,
    LayoutGrid,
    Loader2,
    Plus,
    RefreshCw,
    Trash2,
} from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import {
    useWidgetVisibility,
    type WidgetDefinition,
} from "@/hooks/useWidgetVisibility";
import {
    booleanSearchParamCodec,
    enumSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import {
    appLanguageToLocale,
    CHART_DATE_PATTERNS,
    formatDate,
    formatDateStringWithAppSettings,
    parseISO,
} from "@/lib/dateUtils";
import { accountLabel } from "@/features/accounts/groupAccounts";
import { addAll, toNumber } from "@vision/shared-utils/money";
import {
    getAssetClassGroups,
    getAssetClassLabel,
    type AssetClass,
    type InvestmentSummary,
} from "@/types/portfolio";
import {
    AreaChart,
    ChartCard,
    CHART_NEUTRAL,
    filterByPeriod,
    getChartColor,
    type ChartPeriod,
} from "@/components/charts";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { List, ListRow } from "@/components/ui/list";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { PageShell } from "@/components/shared/PageShell";
import { PageHeader } from "@/components/shared/PageHeader";
import { RowMenu } from "@/components/shared/RowMenu";
import { PageError } from "@/components/shared/PageError";
import { EmptyState } from "@/components/shared/EmptyState";
import { Money } from "@/components/shared/Money";
import { TouchDisclosure } from "@/components/shared/TouchDisclosure";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { ExportDialog } from "@/features/reports/ExportDialog";
import { AddInvestmentDialog } from "@/features/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/features/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/features/portfolio/InvestmentDetailDialog";
import { ArchivedInvestmentsCard } from "@/features/portfolio/ArchivedInvestmentsCard";
import PerformanceBreakdown from "@/features/portfolio/PerformanceBreakdown";
import { PortfolioExposureCard } from "@/features/portfolio/PortfolioExposureCard";
import { PortfolioNewsFeed } from "@/features/portfolio/PortfolioNewsFeed";
import { PortfolioOversoldBadge } from "@/features/portfolio/PortfolioOversoldBadge";
import { PortfolioTicker } from "@/features/portfolio/PortfolioTicker";
import { usePriceFreshnessLabel } from "@/features/portfolio/PriceFreshnessCaption";
import { StalePricesBanner } from "@/features/portfolio/StalePricesBanner";
import { UnassignedLotsNudge } from "@/features/portfolio/UnassignedLotsNudge";
import { usePerformanceQueries } from "@/features/portfolio/usePortfolioQueries";

/** `?period=` keeps deep links from the former Performance page working. */
const PERIOD_CODEC = enumSearchParamCodec<ChartPeriod>(
    ["1m", "3m", "6m", "1y", "3y", "all"],
    "all",
);
const PERIODS: ReadonlyArray<ChartPeriod> = [
    "1m",
    "3m",
    "6m",
    "1y",
    "3y",
    "all",
];

type HoldingsSort = "value" | "return";

const ImportIcon = PAGE_ICONS["/portfolio/import"];

const ASSET_CLASS_ICON: Record<AssetClass, LucideIcon> = {
    stock: PAGE_ICONS["/portfolio/stocks"],
    etf: PAGE_ICONS["/portfolio/stocks"],
    crypto: PAGE_ICONS["/portfolio/crypto"],
    metals: PAGE_ICONS["/portfolio/metals"],
    real_estate: PAGE_ICONS["/portfolio/real-estate"],
    savings: PAGE_ICONS["/portfolio/savings"],
    bond: PAGE_ICONS["/portfolio/savings"],
};

/* Series colours: the allocation bar and the class chart share one index per
   asset group so a colour means the same thing on every widget. */
const SERIES_COLOR = {
    stocksEtfs: getChartColor(0),
    crypto: getChartColor(1),
    metals: getChartColor(2),
    realEstate: getChartColor(3),
    savingsBonds: getChartColor(4),
    inflationAdjusted: getChartColor(5),
    fxNeutral: getChartColor(6),
    value: CHART_NEUTRAL.primary,
    invested: CHART_NEUTRAL.label,
} as const;

/* Persisted widget ids: `ticker`, `investments`, `allocation`, `performance`
   and `news` predate this page and keep their meaning, so saved preferences
   carry over. */
function getPortfolioWidgets(t: (key: string) => string): WidgetDefinition[] {
    return [
        { id: "ticker", label: t("portfolio.widget.ticker") },
        { id: "investments", label: t("portfolio.widget.holdings") },
        { id: "allocation", label: t("portfolio.widget.allocation") },
        { id: "performance", label: t("portfolio.gainsIncomeAndCosts") },
        { id: "exposure", label: t("portfolio.exposure.title") },
        { id: "valueChart", label: t("performance.valueOverTime") },
        { id: "brokerChart", label: t("performance.byBrokerTitle") },
        { id: "relativeChart", label: t("performance.relativeTitle") },
        { id: "breakdown", label: t("portfolio.widget.breakdown") },
        { id: "news", label: t("portfolio.widget.news") },
        { id: "archived", label: t("portfolio.archivedInvestments") },
    ];
}

function toneClass(value: number): string {
    return value >= 0 ? "text-gain" : "text-loss";
}

interface FigureProps {
    label: string;
    value: string | undefined;
    /** Secondary line under the value (an amount, a date, or a reason). */
    detail?: ReactNode;
    hint: string;
    tone?: string;
}

/** One of the four return figures: label, ⓘ disclosure, value, detail. */
function Figure({ label, value, detail, hint, tone }: FigureProps) {
    const { t } = useLanguage();
    return (
        <div className="min-w-0">
            <div className="flex items-center gap-1">
                <span className="truncate type-caption text-label-tertiary">
                    {label}
                </span>
                <TouchDisclosure
                    label={t("portfolio.figure.about", { label })}
                    content={hint}
                    className="text-label-tertiary hover:text-foreground"
                >
                    <Info className="h-3.5 w-3.5" aria-hidden="true" />
                </TouchDisclosure>
            </div>
            <p
                className={cn(
                    "truncate type-title-3 tabular-nums",
                    value === undefined ? "text-label-tertiary" : tone,
                )}
            >
                {value ?? "—"}
            </p>
            {detail && (
                <p className="truncate type-footnote tabular-nums text-label-secondary">
                    {detail}
                </p>
            )}
        </div>
    );
}

export default function PortfolioPage() {
    const { t, tc, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const navigate = useNavigate();
    const targetCurrency = appSettings.defaultCurrency || "EUR";
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const formatPercent = usePercentFormatter();
    const fmt = useCurrencyFormatter(targetCurrency);
    const isOnline = useOnlineStatus();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const {
        summaries,
        inactiveSummaries,
        transactions,
        deleteInvestment,
        updateInvestment,
        refreshPrices,
        isRefreshingPrices,
        isLoading,
        isError,
        error,
        refetch,
    } = usePortfolio();
    const portfolioSummaryQuery = usePortfolioSummaryQuery(targetCurrency);
    const portfolioSummary = portfolioSummaryQuery.data;
    const totals = portfolioSummary?.totals;
    const { data: accountsData } = useAccounts({ active: "all" });
    const { convertToTarget } = useCurrencyConverter(targetCurrency);
    const priceLabel = usePriceFreshnessLabel(summaries);

    const [period, setPeriod] = useSearchParamState("period", PERIOD_CODEC);
    const [showFxNeutral, setShowFxNeutral] = useSearchParamState(
        "fx_neutral",
        booleanSearchParamCodec,
    );
    const { performance, brokerPerformance } = usePerformanceQueries(
        targetCurrency,
        period,
    );

    const [brokerFilter, setBrokerFilter] = useState("all");
    const [sortBy, setSortBy] = useState<HoldingsSort>("value");
    const [exportOpen, setExportOpen] = useState(false);
    const [customizeOpen, setCustomizeOpen] = useState(false);
    const [detailId, setDetailId] = useState<number>();
    const [detailOpen, setDetailOpen] = useState(false);
    const [txnId, setTxnId] = useState<number>();
    const [txnOpen, setTxnOpen] = useState(false);

    const widgetDefs = useMemo(() => getPortfolioWidgets(t), [t]);
    const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults } =
        useWidgetVisibility("portfolio", widgetDefs);

    const assetClassGroups = useMemo(() => getAssetClassGroups(t), [t]);
    const monthLabelLocale = useMemo(
        () => appLanguageToLocale(language),
        [language],
    );
    const periodLabels: Record<ChartPeriod, string> = {
        "1m": t("performance.period.1m"),
        "3m": t("performance.period.3m"),
        "6m": t("performance.period.6m"),
        "1y": t("performance.period.1y"),
        "3y": t("performance.period.3y"),
        all: t("performance.period.all"),
    };
    const xTickPattern =
        period === "1m" || period === "3m" || period === "6m"
            ? CHART_DATE_PATTERNS.dayTick
            : CHART_DATE_PATTERNS.monthTick;
    const formatTickDate = (value: Date | number) =>
        formatDate(value as Date, xTickPattern, monthLabelLocale);
    const formatPointDate = (day: string) =>
        formatDate(parseISO(day), CHART_DATE_PATTERNS.detail, monthLabelLocale);

    // ── Totals (live, from /api/info/portfolio-summary) ─────────────────────
    const totalValue = totals?.totalPortfolioValue ?? 0;
    const totalGainLoss = totals?.totalGainLoss ?? 0;
    const totalReturnPct = totals?.totalReturnPct ?? 0;
    const totalRealizedGain = totals?.totalRealizedGain ?? 0;
    const brokerageCashFees = portfolioSummary?.brokerageCashFees;
    const fxRateFellBack = totals?.usedFallbackRate === true;
    const hasFxExposure = (portfolioSummary?.summaries ?? []).some(
        (s) =>
            s.originalCurrency &&
            s.originalCurrency !== portfolioSummary?.currency,
    );

    // ── Performance series (period-scoped snapshots; metrics are all-time) ──
    const snapshots = useMemo(
        () => performance.data?.snapshots ?? [],
        [performance.data],
    );
    const metrics = performance.data?.metrics ?? null;
    const heatmapData = performance.data?.heatmap ?? {
        years: [] as number[],
        data: {} as Record<number, (number | null)[]>,
        maxAbsPct: 0,
    };
    const breakdownSummary = performance.data?.breakdownSummary ?? [];
    const hasHistory = snapshots.length > 0;
    const lastSnapshot = snapshots.at(-1);

    const chartData = useMemo(
        () =>
            snapshots.map((s) => ({
                day: s.date,
                chartDate: parseISO(s.date),
                invested: Math.round(s.invested * 100) / 100,
                value: Math.round(s.value * 100) / 100,
                inflationAdjusted:
                    Math.round(s.inflation_adjusted_value * 100) / 100,
                fxNeutral:
                    typeof s.value_fx_neutral === "number"
                        ? Math.round(s.value_fx_neutral * 100) / 100
                        : undefined,
                stocksEtfs: Math.round(s.stocks_etfs_value * 100) / 100,
                crypto: Math.round(s.crypto_value * 100) / 100,
                metals: Math.round(s.metals_value * 100) / 100,
            })),
        [snapshots],
    );
    const hasFxNeutralSeries = useMemo(
        () =>
            snapshots.some(
                (s) =>
                    typeof s.value_fx_neutral === "number" &&
                    Math.abs((s.value_fx_neutral ?? 0) - s.value) > 0.01,
            ),
        [snapshots],
    );

    // Period gain = value change minus the capital added in the window. "All"
    // uses the live totals so the hero and the figures agree to the cent.
    const periodGain = useMemo(() => {
        if (period === "all") {
            return {
                amount: totalGainLoss,
                pct: totalReturnPct as number | undefined,
            };
        }
        if (snapshots.length < 2) return undefined;
        const first = snapshots[0];
        const last = snapshots[snapshots.length - 1];
        const contributions = last.invested - first.invested;
        const amount = last.value - first.value - contributions;
        const base = first.value + Math.max(contributions, 0);
        return { amount, pct: base > 0 ? (amount / base) * 100 : undefined };
    }, [period, snapshots, totalGainLoss, totalReturnPct]);

    const relativeData = useMemo(() => {
        if (snapshots.length < 2) return [];
        const cumulative = (value: number, invested: number) =>
            invested > 0 ? Math.round((value / invested - 1) * 10000) / 100 : 0;
        return snapshots.map((s) => ({
            day: s.date,
            chartDate: parseISO(s.date),
            portfolio: cumulative(s.value, s.invested),
            stocksEtfs: cumulative(s.stocks_etfs_value, s.stocks_etfs_invested),
            crypto: cumulative(s.crypto_value, s.crypto_invested),
            metals: cumulative(s.metals_value, s.metals_invested),
            inflationAdjusted: cumulative(
                s.inflation_adjusted_value,
                s.invested,
            ),
        }));
    }, [snapshots]);

    const brokerChart = useMemo(() => {
        const rows = brokerPerformance.data?.rows ?? [];
        const series = brokerPerformance.data?.series ?? [];
        const byDate = new Map<
            string,
            Record<string, number | string | Date>
        >();
        for (const row of rows) {
            const point = byDate.get(row.date) ?? {
                day: row.date,
                chartDate: parseISO(row.date),
            };
            point[row.accountKey] = row.value;
            byDate.set(row.date, point);
        }
        const sorted = [...byDate.values()].sort((a, b) =>
            String(a.day).localeCompare(String(b.day)),
        );
        return {
            // The by-broker endpoint is not period-scoped; the window is applied
            // here so every chart on the page answers to the same picker.
            data: filterByPeriod(sorted, (point) => String(point.day), period),
            series: series.map((entry, index) => ({
                ...entry,
                label:
                    entry.assignment === "unassigned"
                        ? t("portfolio.brokerFilter.unassigned")
                        : entry.accountName,
                color: getChartColor(index),
            })),
        };
    }, [brokerPerformance.data, period, t]);

    const firstInvestmentDate = useMemo(() => {
        let earliest: string | undefined;
        for (const txn of transactions) {
            if (!earliest || txn.date < earliest) earliest = txn.date;
        }
        return earliest ?? snapshots[0]?.date;
    }, [transactions, snapshots]);

    // ── Allocation and news symbols ─────────────────────────────────────────
    const { allocation, newsSymbols } = useMemo(() => {
        const classToGroup = new Map<string, string>();
        for (const [group, classes] of Object.entries(assetClassGroups)) {
            for (const cls of classes) classToGroup.set(cls, group);
        }
        const byGroup = new Map<string, number>();
        const symbols: string[] = [];
        for (const summary of summaries) {
            const value = convertToTarget(
                summary.currentValue,
                summary.currency,
            );
            const group = classToGroup.get(summary.assetClass);
            if (group) byGroup.set(group, (byGroup.get(group) ?? 0) + value);
            if (summary.symbol && symbols.length < 10)
                symbols.push(summary.symbol);
        }
        const groups = Object.keys(assetClassGroups);
        const slices = groups
            .map((name, index) => ({
                name,
                value: byGroup.get(name) ?? 0,
                color: getChartColor(index),
            }))
            .filter((slice) => slice.value > 0);
        const total = slices.reduce((sum, slice) => sum + slice.value, 0);
        return {
            allocation: slices.map((slice) => ({
                ...slice,
                pct: total > 0 ? (slice.value / total) * 100 : 0,
            })),
            newsSymbols: symbols,
        };
    }, [summaries, convertToTarget, assetClassGroups]);

    // ── Holdings: broker filter, per-row figures, sort, subtotals ───────────
    const brokerFilterOptions = useMemo(() => {
        const accountIds = new Set<number>();
        let hasUnassigned = false;
        for (const summary of portfolioSummary?.summaries ?? []) {
            for (const row of summary.byAccount ?? []) {
                if (row.account_id == null) hasUnassigned = true;
                else accountIds.add(row.account_id);
            }
        }
        const accounts = new Map(
            (accountsData?.items ?? []).map((account) => [account.id, account]),
        );
        return {
            accounts: [...accountIds]
                .map((id) => ({
                    id,
                    label: accounts.has(id)
                        ? accountLabel(accounts.get(id)!)
                        : `#${id}`,
                }))
                .sort((a, b) =>
                    a.label.localeCompare(b.label, undefined, {
                        sensitivity: "base",
                        numeric: true,
                    }),
                ),
            hasUnassigned,
        };
    }, [accountsData?.items, portfolioSummary?.summaries]);

    const filteredBrokerMetrics = useMemo(() => {
        if (brokerFilter === "all") return undefined;
        const accountId =
            brokerFilter === "unassigned" ? null : Number(brokerFilter);
        const byInvestment = new Map<
            number,
            {
                currentValue: number;
                totalInvested: number;
                gainLoss: number;
                oversold: boolean;
            }
        >();
        for (const summary of portfolioSummary?.summaries ?? []) {
            const rows = (summary.byAccount ?? []).filter(
                (row) => row.account_id === accountId,
            );
            if (rows.length === 0) continue;
            byInvestment.set(summary.id, {
                currentValue: toNumber(
                    addAll(rows.map((row) => row.currentValue)),
                ),
                totalInvested: toNumber(
                    addAll(rows.map((row) => row.totalInvested)),
                ),
                gainLoss: toNumber(addAll(rows.map((row) => row.gainLoss))),
                oversold: rows.some((row) => row.oversold === true),
            });
        }
        return byInvestment;
    }, [brokerFilter, portfolioSummary?.summaries]);

    const serverSummariesById = useMemo(
        () =>
            new Map(
                (portfolioSummary?.summaries ?? []).map((summary) => [
                    summary.id,
                    summary,
                ]),
            ),
        [portfolioSummary?.summaries],
    );

    const holdings = useMemo(() => {
        const rows = summaries
            .filter(
                (inv) =>
                    !filteredBrokerMetrics || filteredBrokerMetrics.has(inv.id),
            )
            .map((inv) => {
                const selected = filteredBrokerMetrics?.get(inv.id);
                const server = serverSummariesById.get(inv.id);
                const value =
                    selected?.currentValue ??
                    server?.currentValue ??
                    convertToTarget(inv.currentValue, inv.currency);
                const gain =
                    selected?.gainLoss ??
                    server?.gainLoss ??
                    convertToTarget(inv.gainLoss, inv.currency);
                const gainPct = selected
                    ? selected.totalInvested !== 0
                        ? (selected.gainLoss /
                              Math.abs(selected.totalInvested)) *
                          100
                        : 0
                    : (server?.gainLossPercent ?? inv.gainLossPercent);
                const oversold =
                    selected?.oversold ?? server?.oversold ?? inv.oversold;
                return { inv, value, gain, gainPct, oversold };
            });
        rows.sort((a, b) =>
            sortBy === "value" ? b.value - a.value : b.gainPct - a.gainPct,
        );
        return rows;
    }, [
        summaries,
        filteredBrokerMetrics,
        serverSummariesById,
        convertToTarget,
        sortBy,
    ]);

    const brokerSubtotal = useMemo(() => {
        if (!filteredBrokerMetrics) {
            return { currentValue: totalValue, gainLoss: totalGainLoss };
        }
        const rows = [...filteredBrokerMetrics.values()];
        return {
            currentValue: toNumber(addAll(rows.map((row) => row.currentValue))),
            gainLoss: toNumber(addAll(rows.map((row) => row.gainLoss))),
        };
    }, [filteredBrokerMetrics, totalValue, totalGainLoss]);

    const detailInvestment = summaries.find((inv) => inv.id === detailId);
    const txnInvestment = summaries.find((inv) => inv.id === txnId);

    const openDetail = (inv: InvestmentSummary) => {
        setDetailId(inv.id);
        setDetailOpen(true);
    };
    const openAddTransaction = (inv: InvestmentSummary) => {
        setTxnId(inv.id);
        setTxnOpen(true);
    };
    const archiveInvestment = async (inv: InvestmentSummary) => {
        const ok = await confirm({
            title: t("portfolio.archiveInvestment"),
            description: t("portfolio.archiveInvestmentDesc", {
                name: inv.name,
            }),
            confirmLabel: t("portfolio.archiveInvestment"),
        });
        if (ok) await updateInvestment(inv.id, { is_active: false });
    };
    const removeInvestment = async (inv: InvestmentSummary) => {
        const ok = await confirm({
            title: t("portfolio.deleteInvestment"),
            description: t("portfolio.deleteInvestmentDesc", {
                name: inv.name,
            }),
            confirmLabel: t("common.delete"),
            variant: "destructive",
        });
        if (ok) deleteInvestment(inv.id);
    };
    // ── Page states ─────────────────────────────────────────────────────────
    const title = t("nav.portfolio");
    const subtitle = [tc("portfolio.investments", summaries.length), priceLabel]
        .filter(Boolean)
        .join(" · ");

    if (isLoading) {
        return (
            <PageShell {...loadingSurfaceProps}>
                <PageHeader title={title} icon={PAGE_ICONS["/portfolio"]} />
                <Skeleton className="h-64 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-64 w-full" />
            </PageShell>
        );
    }
    if (isError) {
        return (
            <PageShell>
                <PageHeader title={title} icon={PAGE_ICONS["/portfolio"]} />
                <PageError
                    title={t("stocks.pageErrorTitle")}
                    message={error?.message ?? t("common.error")}
                    onRetry={() => refetch()}
                />
            </PageShell>
        );
    }

    const isEmpty = summaries.length === 0;
    const refreshDisabled = isRefreshingPrices || !isOnline;
    const refreshButton = (
        <Button
            size="sm"
            variant="outline"
            onClick={refreshPrices}
            disabled={refreshDisabled}
            title={!isOnline ? t("portfolio.refreshPricesOffline") : undefined}
        >
            <RefreshCw className={cn(isRefreshingPrices && "animate-spin")} />
            {t("portfolio.refreshPrices")}
        </Button>
    );

    const gainsRows: Array<{
        key: string;
        label: string;
        value: number;
        tone: string;
        signed?: boolean;
        warning?: string;
    }> = [
        {
            key: "invested",
            label: t("portfolio.totalInvested"),
            value: totals?.totalInvested ?? 0,
            tone: "text-foreground",
        },
        {
            key: "value",
            label: t("portfolio.currentValue"),
            value: totalValue,
            tone: "text-foreground",
        },
        {
            key: "realized",
            label: t("portfolio.realizedGains"),
            value: totalRealizedGain,
            tone: toneClass(totalRealizedGain),
            signed: true,
        },
        {
            key: "unrealized",
            label: t("portfolio.unrealizedGains"),
            value: totals?.totalUnrealizedGain ?? 0,
            tone: toneClass(totals?.totalUnrealizedGain ?? 0),
            signed: true,
        },
        ...(hasFxExposure
            ? [
                  {
                      key: "assetGain",
                      label: t("portfolio.assetGain"),
                      value: totals?.totalAssetGain ?? 0,
                      tone: toneClass(totals?.totalAssetGain ?? 0),
                      signed: true,
                  },
                  {
                      key: "fxGain",
                      label: t("portfolio.fxEffect"),
                      value: totals?.totalFxGain ?? 0,
                      tone: toneClass(totals?.totalFxGain ?? 0),
                      signed: true,
                      warning: fxRateFellBack
                          ? t("portfolio.fxFallbackNote")
                          : undefined,
                  },
              ]
            : []),
        {
            key: "income",
            label: t("portfolio.totalIncome"),
            value: totals?.totalIncome ?? 0,
            tone: "text-gain",
            signed: true,
        },
        {
            key: "fees",
            label: t("portfolio.totalFees"),
            // `0 - x` rather than `-x` so a zero never renders as "-0,00".
            value: 0 - (totals?.totalFees ?? 0),
            tone: "text-loss",
        },
        {
            key: "taxes",
            label: t("portfolio.totalTaxes"),
            value: 0 - (totals?.totalTaxes ?? 0),
            tone: "text-loss",
        },
        ...(brokerageCashFees && brokerageCashFees.total > 0
            ? [
                  {
                      key: "accountFees",
                      label: t("portfolio.brokerAccountFees"),
                      value: 0 - brokerageCashFees.total,
                      tone: "text-loss",
                      warning: brokerageCashFees.usedFallbackRate
                          ? t("portfolio.fxFallbackNote")
                          : undefined,
                  },
                  {
                      key: "gainAfterAccountFees",
                      label: t("portfolio.gainAfterAccountFees"),
                      value: brokerageCashFees.gainAfterFees,
                      tone: toneClass(brokerageCashFees.gainAfterFees),
                      signed: true,
                      warning: fxRateFellBack || brokerageCashFees.usedFallbackRate
                          ? t("portfolio.fxFallbackNote")
                          : undefined,
                  },
              ]
            : []),
    ];

    return (
        <PageShell className="">
            <PageHeader
                title={title}
                subtitle={isEmpty ? undefined : subtitle}
                icon={PAGE_ICONS["/portfolio"]}
                actions={
                    <>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="icon"
                                    aria-label={t("portfolio.refreshPrices")}
                                    onClick={refreshPrices}
                                    disabled={refreshDisabled}
                                >
                                    {isRefreshingPrices ? (
                                        <Loader2 className="animate-spin" />
                                    ) : (
                                        <RefreshCw />
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                {isOnline
                                    ? t("portfolio.refreshPrices")
                                    : t("portfolio.refreshPricesOffline")}
                            </TooltipContent>
                        </Tooltip>
                        <RowMenu
                            variant="outline"
                            size="icon"
                            label={t("portfolio.menu")}
                        >
                            <DropdownMenuItem
                                onSelect={() => setExportOpen(true)}
                            >
                                <FileDown className="mr-2 h-4 w-4 text-label-secondary" />
                                {t("portfolio.menu.exportPdf")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => setCustomizeOpen(true)}
                            >
                                <LayoutGrid className="mr-2 h-4 w-4 text-label-secondary" />
                                {t("portfolio.menu.customize")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onSelect={() => navigate("/portfolio/import")}
                            >
                                <ImportIcon className="mr-2 h-4 w-4 text-label-secondary" />
                                {t("nav.portfolioImport")}
                            </DropdownMenuItem>
                        </RowMenu>
                        <ExportDialog
                            defaultType="portfolio"
                            trigger={null}
                            open={exportOpen}
                            onOpenChange={setExportOpen}
                        />
                        <WidgetVisibilityDialog
                            open={customizeOpen}
                            onOpenChange={setCustomizeOpen}
                            widgets={widgetDefs}
                            isVisible={isVisible}
                            setWidgetVisible={setWidgetVisible}
                            setAllVisible={setAllVisible}
                            resetToDefaults={resetToDefaults}
                        />
                        <AddInvestmentDialog
                            trigger={
                                <Button>
                                    <Plus />
                                    {t("addInv.title")}
                                </Button>
                            }
                        />
                    </>
                }
            />

            {isEmpty ? (
                <Card>
                    <CardContent variant="state">
                        <EmptyState
                            icon={PAGE_ICONS["/portfolio"]}
                            title={t("portfolio.noInvestments")}
                            description={t("portfolio.noInvestmentsDesc")}
                            action={<AddInvestmentDialog />}
                        />
                    </CardContent>
                </Card>
            ) : (
                <>
                    <StalePricesBanner
                        investments={summaries}
                        onRefresh={refreshPrices}
                        isRefreshing={isRefreshingPrices}
                    />

                    {isVisible("ticker") && (
                        <PortfolioTicker items={summaries} />
                    )}

                    {/* Hero: value, period gain, period picker, value chart */}
                    <Card className="overflow-hidden">
                        <CardContent
                            variant="headerless"
                            className="grid gap-6 lg:grid-cols-5"
                        >
                            <div className="space-y-3 lg:col-span-2">
                                <p className="eyebrow">
                                    {t("portfolio.hero.value")}
                                </p>
                                <p className="type-large-title tabular-nums text-foreground">
                                    <Money
                                        amount={totalValue}
                                        currency={targetCurrency}
                                    />
                                </p>
                                {periodGain ? (
                                    <p
                                        className={cn(
                                            "type-callout tabular-nums",
                                            toneClass(periodGain.amount),
                                        )}
                                    >
                                        <Money
                                            amount={periodGain.amount}
                                            currency={targetCurrency}
                                            signed
                                        />
                                        {periodGain.pct !== undefined && (
                                            <>
                                                {" "}
                                                (
                                                {formatPercent(periodGain.pct, {
                                                    digits: 1,
                                                    signed: true,
                                                })}
                                                )
                                            </>
                                        )}{" "}
                                        <span className="text-label-secondary">
                                            {period === "all"
                                                ? t("networth.allTime")
                                                : t("portfolio.hero.inPeriod", {
                                                      period: periodLabels[
                                                          period
                                                      ],
                                                  })}
                                        </span>
                                    </p>
                                ) : performance.isLoading ? (
                                    <Skeleton className="h-5 w-40" />
                                ) : (
                                    <p className="type-callout text-label-secondary">
                                        {t("performance.emptyTitle")}
                                    </p>
                                )}
                                <SegmentedControl
                                    size="sm"
                                    value={period}
                                    onValueChange={(next) =>
                                        setPeriod(next as ChartPeriod)
                                    }
                                    aria-label={t("portfolio.period.label")}
                                    className="w-fit"
                                >
                                    {PERIODS.map((p) => (
                                        <SegmentedControlItem
                                            key={p}
                                            value={p}
                                            className="px-2.5 type-footnote"
                                            aria-label={periodLabels[p]}
                                        >
                                            {t(`portfolio.period.${p}`)}
                                        </SegmentedControlItem>
                                    ))}
                                </SegmentedControl>
                            </div>
                            <div className="flex min-h-48 flex-col gap-2 lg:col-span-3">
                                {performance.isLoading ? (
                                    <Skeleton className="h-48 w-full" />
                                ) : performance.isError ? (
                                    <p className="type-footnote text-destructive">
                                        {t("common.loadError", {
                                            msg: apiErrorToMessage(
                                                performance.error,
                                                t,
                                            ),
                                        })}
                                    </p>
                                ) : !hasHistory ? (
                                    <div className="flex h-full flex-col items-start justify-center gap-2">
                                        <h3 className="type-headline text-foreground">
                                            {t("performance.emptyTitle")}
                                        </h3>
                                        <p className="max-w-prose type-footnote text-label-secondary">
                                            {t("performance.emptyDescription")}
                                        </p>
                                        {refreshButton}
                                    </div>
                                ) : (
                                    <>
                                        <AreaChart
                                            scrubbable
                                            data={chartData}
                                            xAccessor={(d) => d.chartDate}
                                            series={[
                                                {
                                                    key: "invested",
                                                    label: t(
                                                        "portfolio.hero.invested",
                                                    ),
                                                    accessor: (d) => d.invested,
                                                    color: SERIES_COLOR.invested,
                                                    dashed: true,
                                                    strokeWidth: 1.5,
                                                    fillOpacity: 0,
                                                },
                                                {
                                                    key: "value",
                                                    label: t(
                                                        "portfolio.hero.value",
                                                    ),
                                                    accessor: (d) => d.value,
                                                    color: SERIES_COLOR.value,
                                                    strokeWidth: 2.5,
                                                },
                                            ]}
                                            xIsDate
                                            xTickFormat={formatTickDate}
                                            yTickFormat={(v) =>
                                                fmt(v, { decimals: 0 })
                                            }
                                            tooltipTitle={(d) =>
                                                formatPointDate(d.day)
                                            }
                                            tooltipValueFormat={(v) => fmt(v)}
                                            height={200}
                                            margin={{
                                                top: 8,
                                                right: 8,
                                                bottom: 24,
                                                left: 72,
                                            }}
                                            ariaLabel={t(
                                                "portfolio.hero.chartAria",
                                            )}
                                        />
                                        <div className="flex flex-wrap items-center gap-4 type-caption text-label-secondary">
                                            <span className="flex items-center gap-1.5">
                                                <span
                                                    aria-hidden="true"
                                                    className="h-0.5 w-4 rounded-full bg-primary"
                                                />
                                                {t("portfolio.hero.value")}
                                            </span>
                                            <span className="flex items-center gap-1.5">
                                                <span
                                                    aria-hidden="true"
                                                    className="h-0 w-4 border-t border-dashed border-muted-foreground"
                                                />
                                                {t("portfolio.hero.invested")}
                                            </span>
                                        </div>
                                        {lastSnapshot?.is_provisional && (
                                            <p
                                                role="note"
                                                className="flex items-start gap-1.5 type-footnote text-label-secondary"
                                            >
                                                <Info
                                                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                                    aria-hidden="true"
                                                />
                                                <span>
                                                    <span className="text-foreground">
                                                        {t(
                                                            "performance.latestSnapshotProvisional",
                                                        )}
                                                    </span>{" "}
                                                    {t(
                                                        "performance.latestSnapshotProvisionalDescription",
                                                    )}
                                                </span>
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    {/* Four return figures (all-time) */}
                    <Card>
                        <CardContent
                            variant="headerless"
                            className="grid grid-cols-2 gap-4 lg:grid-cols-4"
                        >
                            <Figure
                                label={t("portfolio.investmentReturn")}
                                value={formatPercent(totalReturnPct, {
                                    digits: 1,
                                    signed: true,
                                })}
                                tone={toneClass(totalGainLoss)}
                                detail={
                                    <Money
                                        amount={totalGainLoss}
                                        currency={targetCurrency}
                                        signed
                                    />
                                }
                                hint={t("portfolio.figure.totalReturnHint")}
                            />
                            <Figure
                                label={t("portfolio.figure.perYear")}
                                value={
                                    metrics
                                        ? formatPercent(
                                              metrics.annualizedReturn,
                                              {
                                                  digits: 1,
                                                  signed: true,
                                              },
                                          )
                                        : undefined
                                }
                                tone={toneClass(metrics?.annualizedReturn ?? 0)}
                                detail={
                                    metrics && firstInvestmentDate
                                        ? t("portfolio.figure.perYearHint", {
                                              date: formatDateStringWithAppSettings(
                                                  firstInvestmentDate,
                                                  appSettings.dateFormat,
                                              ),
                                          }).replace(/\.$/, "")
                                        : undefined
                                }
                                hint={
                                    metrics && firstInvestmentDate
                                        ? t("portfolio.figure.perYearHint", {
                                              date: formatDateStringWithAppSettings(
                                                  firstInvestmentDate,
                                                  appSettings.dateFormat,
                                              ),
                                          })
                                        : t("performance.emptyTitle")
                                }
                            />
                            <Figure
                                label={t("performance.inflationAdjusted")}
                                value={
                                    metrics && metrics.cumulativeInflation
                                        ? formatPercent(metrics.realReturnPct, {
                                              digits: 1,
                                              signed: true,
                                          })
                                        : undefined
                                }
                                tone={toneClass(metrics?.realReturnPct ?? 0)}
                                detail={
                                    metrics && metrics.cumulativeInflation
                                        ? t("performance.cumulativeInflation", {
                                              n: formatPercent(
                                                  metrics.cumulativeInflation,
                                                  { digits: 1 },
                                              ),
                                          })
                                        : t("portfolio.figure.inflationMissing")
                                }
                                hint={
                                    metrics && metrics.cumulativeInflation
                                        ? t(
                                              "portfolio.figure.afterInflationHint",
                                          )
                                        : t("portfolio.figure.inflationMissing")
                                }
                            />
                            <Figure
                                label={t("portfolio.figure.realized")}
                                value={
                                    totalRealizedGain !== 0
                                        ? fmt(totalRealizedGain, {
                                              signed: true,
                                          })
                                        : undefined
                                }
                                tone={toneClass(totalRealizedGain)}
                                detail={
                                    totalRealizedGain === 0
                                        ? t("portfolio.figure.noSales")
                                        : undefined
                                }
                                hint={
                                    totalRealizedGain === 0
                                        ? t("portfolio.figure.noSales")
                                        : t("portfolio.figure.realizedHint")
                                }
                            />
                        </CardContent>
                    </Card>

                    {/* Holdings and allocation */}
                    <div className="grid gap-6 lg:grid-cols-3 lg:[&>*:only-child]:col-span-3">
                        {isVisible("investments") && (
                            <Card className="lg:col-span-2">
                                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-4">
                                    <CardTitle variant="sm">
                                        {t("portfolio.widget.holdings")}
                                    </CardTitle>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <SegmentedControl
                                            size="sm"
                                            value={sortBy}
                                            onValueChange={(next) =>
                                                setSortBy(next as HoldingsSort)
                                            }
                                            aria-label={t(
                                                "portfolio.sort.label",
                                            )}
                                        >
                                            <SegmentedControlItem
                                                value="value"
                                                className="px-2.5 type-footnote"
                                            >
                                                {t("portfolio.sort.value")}
                                            </SegmentedControlItem>
                                            <SegmentedControlItem
                                                value="return"
                                                className="px-2.5 type-footnote"
                                            >
                                                {t("portfolio.sort.return")}
                                            </SegmentedControlItem>
                                        </SegmentedControl>
                                        <Select
                                            value={brokerFilter}
                                            onValueChange={setBrokerFilter}
                                            disabled={
                                                portfolioSummaryQuery.isLoading ||
                                                portfolioSummaryQuery.isError
                                            }
                                        >
                                            <SelectTrigger
                                                className="h-8 w-44"
                                                aria-label={t(
                                                    "portfolio.brokerFilter.label",
                                                )}
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="all">
                                                    {t(
                                                        "portfolio.brokerFilter.all",
                                                    )}
                                                </SelectItem>
                                                {brokerFilterOptions.accounts.map(
                                                    (account) => (
                                                        <SelectItem
                                                            key={account.id}
                                                            value={String(
                                                                account.id,
                                                            )}
                                                        >
                                                            {account.label}
                                                        </SelectItem>
                                                    ),
                                                )}
                                                {brokerFilterOptions.hasUnassigned && (
                                                    <SelectItem value="unassigned">
                                                        {t(
                                                            "portfolio.brokerFilter.unassigned",
                                                        )}
                                                    </SelectItem>
                                                )}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    {holdings.length === 0 ? (
                                        <p className="py-6 text-center type-callout text-label-secondary">
                                            {t("portfolio.brokerFilter.empty")}
                                        </p>
                                    ) : (
                                        <List>
                                            {holdings.map(
                                                ({
                                                    inv,
                                                    value,
                                                    gain,
                                                    gainPct,
                                                    oversold,
                                                }) => {
                                                    const Icon =
                                                        ASSET_CLASS_ICON[
                                                            inv.assetClass
                                                        ];
                                                    const classLabel =
                                                        getAssetClassLabel(
                                                            t,
                                                            inv.assetClass,
                                                        );
                                                    return [
                                                        <ListRow
                                                            key={inv.id}
                                                            asChild
                                                            leading={
                                                                Icon ? (
                                                                    <Icon />
                                                                ) : undefined
                                                            }
                                                            title={
                                                                <span className="inline-flex max-w-full items-center gap-2">
                                                                    <span className="truncate">
                                                                        {
                                                                            inv.name
                                                                        }
                                                                    </span>
                                                                    <PortfolioOversoldBadge
                                                                        oversold={
                                                                            oversold
                                                                        }
                                                                    />
                                                                </span>
                                                            }
                                                            subtitle={
                                                                inv.symbol
                                                                    ? `${classLabel} · ${inv.symbol}`
                                                                    : classLabel
                                                            }
                                                            trailing={
                                                                <>
                                                                    <span className="flex flex-col items-end">
                                                                        <span className="text-foreground">
                                                                            <Money
                                                                                amount={
                                                                                    value
                                                                                }
                                                                                currency={
                                                                                    targetCurrency
                                                                                }
                                                                            />
                                                                        </span>
                                                                        <span
                                                                            className={cn(
                                                                                "type-footnote",
                                                                                toneClass(
                                                                                    gain,
                                                                                ),
                                                                            )}
                                                                        >
                                                                            <Money
                                                                                amount={
                                                                                    gain
                                                                                }
                                                                                currency={
                                                                                    targetCurrency
                                                                                }
                                                                                signed
                                                                            />{" "}
                                                                            (
                                                                            {formatPercent(
                                                                                gainPct,
                                                                                {
                                                                                    digits: 1,
                                                                                    signed: true,
                                                                                },
                                                                            )}
                                                                            )
                                                                        </span>
                                                                    </span>
                                                                </>
                                                            }
                                                            actions={
                                                                <RowMenu
                                                                    label={t(
                                                                        "portfolio.row.menu",
                                                                        {
                                                                            name: inv.name,
                                                                        },
                                                                    )}
                                                                >
                                                                    <DropdownMenuItem
                                                                        onSelect={() =>
                                                                            openDetail(
                                                                                inv,
                                                                            )
                                                                        }
                                                                    >
                                                                        <Eye className="mr-2 h-4 w-4 text-label-secondary" />
                                                                        {t(
                                                                            "invDetail.trigger",
                                                                        )}
                                                                    </DropdownMenuItem>
                                                                    <DropdownMenuItem
                                                                        onSelect={() =>
                                                                            openAddTransaction(
                                                                                inv,
                                                                            )
                                                                        }
                                                                    >
                                                                        <Plus className="mr-2 h-4 w-4 text-label-secondary" />
                                                                        {t(
                                                                            "portfolio.addTransaction",
                                                                        )}
                                                                    </DropdownMenuItem>
                                                                    <DropdownMenuSeparator />
                                                                    <DropdownMenuItem
                                                                        onSelect={() =>
                                                                            void archiveInvestment(
                                                                                inv,
                                                                            )
                                                                        }
                                                                    >
                                                                        <Archive className="mr-2 h-4 w-4 text-label-secondary" />
                                                                        {t(
                                                                            "portfolio.archiveInvestment",
                                                                        )}
                                                                    </DropdownMenuItem>
                                                                    <DropdownMenuItem
                                                                        variant="destructive"
                                                                        onSelect={() =>
                                                                            void removeInvestment(
                                                                                inv,
                                                                            )
                                                                        }
                                                                    >
                                                                        <Trash2 className="mr-2 h-4 w-4" />
                                                                        {t(
                                                                            "portfolio.deleteInvestment",
                                                                        )}
                                                                    </DropdownMenuItem>
                                                                </RowMenu>
                                                            }
                                                        >
                                                            <div
                                                                role="button"
                                                                tabIndex={0}
                                                                aria-label={`${t("invDetail.trigger")}: ${inv.name}`}
                                                                onClick={() =>
                                                                    openDetail(
                                                                        inv,
                                                                    )
                                                                }
                                                                onKeyDown={(
                                                                    event,
                                                                ) => {
                                                                    if (
                                                                        event.key ===
                                                                            "Enter" ||
                                                                        event.key ===
                                                                            " "
                                                                    ) {
                                                                        event.preventDefault();
                                                                        openDetail(
                                                                            inv,
                                                                        );
                                                                    }
                                                                }}
                                                            />
                                                        </ListRow>,
                                                        !inv.fullyAssigned ? (
                                                            <li
                                                                key={`${inv.id}-lots`}
                                                                className="px-4 pb-3"
                                                            >
                                                                <UnassignedLotsNudge
                                                                    investmentId={
                                                                        inv.id
                                                                    }
                                                                    investmentName={
                                                                        inv.name
                                                                    }
                                                                    transactions={
                                                                        transactions
                                                                    }
                                                                />
                                                            </li>
                                                        ) : null,
                                                    ];
                                                },
                                            )}
                                        </List>
                                    )}
                                    <p className="mt-3 flex flex-wrap justify-end gap-x-4 gap-y-1 type-footnote tabular-nums text-label-secondary">
                                        {portfolioSummaryQuery.isLoading ? (
                                            t("portfolio.brokerFilter.loading")
                                        ) : portfolioSummaryQuery.isError ? (
                                            <span className="text-warning">
                                                {t(
                                                    "portfolio.brokerFilter.unavailable",
                                                )}
                                            </span>
                                        ) : (
                                            <>
                                                <span>
                                                    {t(
                                                        "portfolio.brokerFilter.holdingsSubtotal",
                                                    )}{" "}
                                                    <span className="text-foreground">
                                                        <Money
                                                            amount={
                                                                brokerSubtotal.currentValue
                                                            }
                                                            currency={
                                                                targetCurrency
                                                            }
                                                        />
                                                    </span>
                                                </span>
                                                <span>
                                                    {t(
                                                        "portfolio.brokerFilter.pnlSubtotal",
                                                    )}{" "}
                                                    <span
                                                        className={toneClass(
                                                            brokerSubtotal.gainLoss,
                                                        )}
                                                    >
                                                        <Money
                                                            amount={
                                                                brokerSubtotal.gainLoss
                                                            }
                                                            currency={
                                                                targetCurrency
                                                            }
                                                            signed
                                                        />
                                                    </span>
                                                </span>
                                            </>
                                        )}
                                    </p>
                                </CardContent>
                            </Card>
                        )}

                        {isVisible("allocation") && allocation.length > 0 && (
                            <Card>
                                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-4">
                                    <div className="min-w-0">
                                        <CardTitle variant="sm">
                                            {t("portfolio.widget.allocation")}
                                        </CardTitle>
                                        <CardDescription className="mt-0.5">
                                            {t("portfolio.allocationByClass")}
                                        </CardDescription>
                                    </div>
                                    <Button
                                        asChild
                                        variant="link"
                                        size="sm"
                                        className="h-auto p-0"
                                    >
                                        <Link to="/portfolio/rebalance">
                                            {t("nav.rebalance")}
                                        </Link>
                                    </Button>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div
                                        role="img"
                                        aria-label={t(
                                            "portfolio.allocation.legendAria",
                                        )}
                                        className="flex h-2.5 w-full gap-px overflow-hidden rounded-chip bg-foreground/[0.06]"
                                    >
                                        {allocation.map((slice) => (
                                            <div
                                                key={slice.name}
                                                className="h-full"
                                                style={{
                                                    width: `${slice.pct}%`,
                                                    backgroundColor:
                                                        slice.color,
                                                }}
                                            />
                                        ))}
                                    </div>
                                    <ul className="m-0 list-none space-y-2 p-0">
                                        {allocation.map((slice) => (
                                            <li
                                                key={slice.name}
                                                className="flex items-center gap-2 type-footnote"
                                            >
                                                <span
                                                    aria-hidden="true"
                                                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                                                    style={{
                                                        backgroundColor:
                                                            slice.color,
                                                    }}
                                                />
                                                <span className="min-w-0 flex-1 truncate text-label-secondary">
                                                    {slice.name}
                                                </span>
                                                <span className="tabular-nums text-foreground">
                                                    <Money
                                                        amount={slice.value}
                                                        currency={
                                                            targetCurrency
                                                        }
                                                    />
                                                </span>
                                                <span className="w-12 text-right tabular-nums text-label-secondary">
                                                    {formatPercent(slice.pct, {
                                                        digits: 0,
                                                    })}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </CardContent>
                            </Card>
                        )}
                    </div>

                    {/* Gains breakdown and exposure */}
                    <div className="grid items-start gap-6 lg:grid-cols-2 lg:[&>*:only-child]:col-span-2">
                        {isVisible("performance") && (
                            <Card>
                                <CardHeader className="pb-4">
                                    <CardTitle variant="sm">
                                        {t("portfolio.gainsIncomeAndCosts")}
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <dl className="divide-y divide-border/50">
                                        {gainsRows.map((row) => (
                                            <div
                                                key={row.key}
                                                className="flex items-center justify-between gap-3 py-2"
                                            >
                                                <dt className="type-footnote text-label-secondary">
                                                    {row.label}
                                                    {row.warning && (
                                                        <TouchDisclosure
                                                            label={row.warning}
                                                            content={
                                                                row.warning
                                                            }
                                                            className="ml-1 align-middle text-warning"
                                                        >
                                                            <Info
                                                                className="h-3.5 w-3.5"
                                                                aria-hidden="true"
                                                            />
                                                        </TouchDisclosure>
                                                    )}
                                                </dt>
                                                <dd
                                                    className={cn(
                                                        "type-body font-medium tabular-nums",
                                                        row.tone,
                                                    )}
                                                >
                                                    <Money
                                                        amount={row.value}
                                                        currency={
                                                            targetCurrency
                                                        }
                                                        signed={row.signed}
                                                    />
                                                </dd>
                                            </div>
                                        ))}
                                    </dl>
                                </CardContent>
                            </Card>
                        )}
                        {isVisible("exposure") && (
                            <PortfolioExposureCard currency={targetCurrency} />
                        )}
                    </div>

                    {/* Period-scoped performance charts */}
                    {isVisible("valueChart") && chartData.length > 1 && (
                        <ChartCard
                            title={t("performance.valueOverTime")}
                            description={t("performance.chartDesc", {
                                period: periodLabels[period],
                            })}
                            actions={
                                hasFxNeutralSeries ? (
                                    <div className="flex items-center gap-2">
                                        <Switch
                                            id="portfolio-fx-neutral"
                                            checked={showFxNeutral}
                                            onCheckedChange={(checked) =>
                                                setShowFxNeutral(checked)
                                            }
                                        />
                                        <Label
                                            htmlFor="portfolio-fx-neutral"
                                            className="type-footnote text-label-secondary"
                                        >
                                            {t("performance.fxNeutral")}
                                        </Label>
                                        <TouchDisclosure
                                            label={t("performance.fxNeutral")}
                                            content={t(
                                                "performance.fxNeutralDesc",
                                            )}
                                            className="text-label-tertiary"
                                        >
                                            <Info
                                                className="h-3.5 w-3.5"
                                                aria-hidden="true"
                                            />
                                        </TouchDisclosure>
                                    </div>
                                ) : undefined
                            }
                            legend={[
                                {
                                    label: t("performance.relativeStocksEtfs"),
                                    color: SERIES_COLOR.stocksEtfs,
                                },
                                {
                                    label: t("performance.crypto"),
                                    color: SERIES_COLOR.crypto,
                                },
                                {
                                    label: t("performance.metals"),
                                    color: SERIES_COLOR.metals,
                                },
                                {
                                    label: t("performance.inflationAdjusted"),
                                    color: SERIES_COLOR.inflationAdjusted,
                                },
                                ...(showFxNeutral && hasFxNeutralSeries
                                    ? [
                                          {
                                              label: t("performance.fxNeutral"),
                                              color: SERIES_COLOR.fxNeutral,
                                              dashed: true,
                                          },
                                      ]
                                    : []),
                                {
                                    label: t("portfolio.portfolioValue"),
                                    color: SERIES_COLOR.value,
                                },
                            ]}
                        >
                            <AreaChart
                                scrubbable
                                data={chartData}
                                xAccessor={(d) => d.chartDate}
                                series={[
                                    {
                                        key: "stocksEtfs",
                                        label: t(
                                            "performance.relativeStocksEtfs",
                                        ),
                                        accessor: (d) => d.stocksEtfs,
                                        color: SERIES_COLOR.stocksEtfs,
                                        fillOpacity: 0,
                                        strokeWidth: 2,
                                    },
                                    {
                                        key: "crypto",
                                        label: t("performance.crypto"),
                                        accessor: (d) => d.crypto,
                                        color: SERIES_COLOR.crypto,
                                        fillOpacity: 0,
                                        strokeWidth: 2,
                                    },
                                    {
                                        key: "metals",
                                        label: t("performance.metals"),
                                        accessor: (d) => d.metals,
                                        color: SERIES_COLOR.metals,
                                        fillOpacity: 0,
                                        strokeWidth: 2,
                                    },
                                    {
                                        key: "inflationAdjusted",
                                        label: t(
                                            "performance.inflationAdjusted",
                                        ),
                                        accessor: (d) => d.inflationAdjusted,
                                        color: SERIES_COLOR.inflationAdjusted,
                                        fillOpacity: 0,
                                        strokeWidth: 2,
                                    },
                                    ...(showFxNeutral && hasFxNeutralSeries
                                        ? [
                                              {
                                                  key: "fxNeutral",
                                                  label: t(
                                                      "performance.fxNeutral",
                                                  ),
                                                  accessor: (
                                                      d: (typeof chartData)[number],
                                                  ) => d.fxNeutral,
                                                  color: SERIES_COLOR.fxNeutral,
                                                  fillOpacity: 0,
                                                  dashed: true,
                                                  strokeWidth: 2,
                                              },
                                          ]
                                        : []),
                                    {
                                        key: "value",
                                        label: t("portfolio.portfolioValue"),
                                        accessor: (d) => d.value,
                                        color: SERIES_COLOR.value,
                                        strokeWidth: 2.5,
                                    },
                                ]}
                                xIsDate
                                xTickFormat={formatTickDate}
                                yTickFormat={(v) => fmt(v, { decimals: 0 })}
                                tooltipTitle={(d) => formatPointDate(d.day)}
                                tooltipValueFormat={(v) => fmt(v)}
                                height={320}
                                margin={{
                                    top: 16,
                                    right: 24,
                                    bottom: 28,
                                    left: 90,
                                }}
                            />
                        </ChartCard>
                    )}

                    {isVisible("brokerChart") &&
                        brokerChart.data.length > 1 &&
                        brokerChart.series.length > 0 && (
                            <ChartCard
                                title={t("performance.byBrokerTitle")}
                                description={t(
                                    "performance.byBrokerDescription",
                                )}
                                legend={brokerChart.series.map((entry) => ({
                                    label: entry.label,
                                    color: entry.color,
                                }))}
                            >
                                <AreaChart
                                    scrubbable
                                    data={brokerChart.data}
                                    xAccessor={(d) => d.chartDate as Date}
                                    series={brokerChart.series.map((entry) => ({
                                        key: entry.accountKey,
                                        label: entry.label,
                                        accessor: (
                                            d: Record<
                                                string,
                                                number | string | Date
                                            >,
                                        ) => Number(d[entry.accountKey] ?? 0),
                                        color: entry.color,
                                        fillOpacity: 0.08,
                                        strokeWidth: 2,
                                    }))}
                                    xIsDate
                                    xTickFormat={formatTickDate}
                                    yTickFormat={(v) => fmt(v, { decimals: 0 })}
                                    tooltipTitle={(point) =>
                                        formatPointDate(String(point.day))
                                    }
                                    tooltipValueFormat={(v) => fmt(v)}
                                    height={280}
                                    margin={{
                                        top: 16,
                                        right: 24,
                                        bottom: 28,
                                        left: 90,
                                    }}
                                />
                            </ChartCard>
                        )}

                    {isVisible("relativeChart") && relativeData.length > 1 && (
                        <ChartCard
                            title={t("performance.relativeTitle")}
                            description={t("performance.relativeDesc", {
                                period: periodLabels[period],
                            })}
                            legend={[
                                {
                                    label: t("performance.relativePortfolio"),
                                    color: SERIES_COLOR.value,
                                },
                                {
                                    label: t("performance.relativeStocksEtfs"),
                                    color: SERIES_COLOR.stocksEtfs,
                                },
                                {
                                    label: t("performance.crypto"),
                                    color: SERIES_COLOR.crypto,
                                },
                                {
                                    label: t("performance.metals"),
                                    color: SERIES_COLOR.metals,
                                },
                                {
                                    label: t("performance.inflationAdjusted"),
                                    color: SERIES_COLOR.inflationAdjusted,
                                    dashed: true,
                                },
                            ]}
                        >
                            <AreaChart
                                scrubbable
                                data={relativeData}
                                xAccessor={(d) => d.chartDate}
                                series={[
                                    {
                                        key: "portfolio",
                                        label: t(
                                            "performance.relativePortfolio",
                                        ),
                                        accessor: (d) => d.portfolio,
                                        color: SERIES_COLOR.value,
                                        strokeWidth: 2.5,
                                    },
                                    {
                                        key: "stocksEtfs",
                                        label: t(
                                            "performance.relativeStocksEtfs",
                                        ),
                                        accessor: (d) => d.stocksEtfs,
                                        color: SERIES_COLOR.stocksEtfs,
                                        fillOpacity: 0,
                                        strokeWidth: 2,
                                    },
                                    {
                                        key: "crypto",
                                        label: t("performance.crypto"),
                                        accessor: (d) => d.crypto,
                                        color: SERIES_COLOR.crypto,
                                        fillOpacity: 0,
                                        strokeWidth: 2,
                                    },
                                    {
                                        key: "metals",
                                        label: t("performance.metals"),
                                        accessor: (d) => d.metals,
                                        color: SERIES_COLOR.metals,
                                        fillOpacity: 0,
                                        strokeWidth: 2,
                                    },
                                    {
                                        key: "inflationAdjusted",
                                        label: t(
                                            "performance.inflationAdjusted",
                                        ),
                                        accessor: (d) => d.inflationAdjusted,
                                        color: SERIES_COLOR.inflationAdjusted,
                                        fillOpacity: 0,
                                        dashed: true,
                                        strokeWidth: 2,
                                    },
                                ]}
                                xIsDate
                                xTickFormat={formatTickDate}
                                yTickFormat={(v) =>
                                    formatPercent(v, {
                                        digits: 0,
                                        signed: true,
                                    })
                                }
                                tooltipTitle={(d) => formatPointDate(d.day)}
                                tooltipValueFormat={(v) =>
                                    formatPercent(v, {
                                        digits: 2,
                                        signed: true,
                                    })
                                }
                                height={300}
                                margin={{
                                    top: 16,
                                    right: 24,
                                    bottom: 28,
                                    left: 72,
                                }}
                            />
                        </ChartCard>
                    )}

                    {isVisible("breakdown") && hasHistory && (
                        <PerformanceBreakdown
                            heatmapData={heatmapData}
                            breakdownSummary={breakdownSummary}
                        />
                    )}

                    {isVisible("news") && newsSymbols.length > 0 && (
                        <PortfolioNewsFeed symbols={newsSymbols} />
                    )}
                </>
            )}

            {isVisible("archived") && (
                <ArchivedInvestmentsCard
                    investments={inactiveSummaries}
                    onRestore={(id) =>
                        updateInvestment(id, { is_active: true })
                    }
                    t={t}
                />
            )}

            {detailInvestment && (
                <InvestmentDetailDialog
                    investment={detailInvestment}
                    open={detailOpen}
                    onOpenChange={setDetailOpen}
                />
            )}
            {txnInvestment && (
                <AddPortfolioTxnDialog
                    investment={txnInvestment}
                    open={txnOpen}
                    onOpenChange={setTxnOpen}
                />
            )}
            <ConfirmDialog />
        </PageShell>
    );
}
