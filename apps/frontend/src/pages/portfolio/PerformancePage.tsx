import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { usePortfolio } from "@/hooks/usePortfolio";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Legend,
} from "recharts";
import {
    TrendingUp, TrendingDown, BarChart3, Loader2, Percent,
    Calendar, DollarSign, Activity,
} from "lucide-react";
import { format, parseISO, differenceInMonths, differenceInDays, startOfMonth, endOfMonth, isAfter, isBefore, isValid, subMonths, subYears } from "date-fns";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatMonthLabelWithLocale } from "@/components/shared/dateUtils";
import type { AssetClass, PortfolioTransaction } from "@/types/api";

type HistoryPoint = { timestampMs: number; price: number };

function getPriceFromHistory(points: HistoryPoint[], date: Date): number | undefined {
    if (!Array.isArray(points) || points.length === 0) return undefined;
    const target = date.getTime();
    let left = 0;
    let right = points.length - 1;
    let best: HistoryPoint | undefined;
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const p = points[mid];
        if (!p) break;
        if (p.timestampMs <= target) {
            best = p;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return best?.price;
}

// ─── EU Inflation (Eurostat HICP annual avg, hardcoded for simplicity) ───
const EU_ANNUAL_INFLATION: Record<number, number> = {
    2018: 1.8, 2019: 1.2, 2020: 0.3, 2021: 2.6,
    2022: 8.4, 2023: 5.4, 2024: 2.4, 2025: 2.1, 2026: 2.0,
};

function getMonthlyInflation(year: number): number {
    const annual = EU_ANNUAL_INFLATION[year] ?? 2.0;
    return annual / 12 / 100; // monthly rate
}

type Period = "1m" | "3m" | "6m" | "1y" | "3y" | "all";

interface MonthlySnapshot {
    month: string; // YYYY-MM
    date: Date;
    invested: number;
    value: number;
    stocksEtfsValue: number;
    cryptoValue: number;
    metalsValue: number;
    gainLoss: number;
    returnPct: number;
    inflationAdjustedValue: number;
    realReturnPct: number;
    cumulativeInflation: number;
}

interface HistoryPointResponse {
    timestampMs: number | string;
    price: number | string;
}

interface ParsedPortfolioTransaction extends PortfolioTransaction {
    _parsedDate: Date;
}

interface RelativeFlowBucket {
    portfolio: number;
    stocksEtfs: number;
    crypto: number;
    metals: number;
}

const PERIOD_KEYS = ["1m", "3m", "6m", "1y", "3y", "all"] as const;

export default function PerformancePage() {
    const { t, language } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";
    const { summaries, transactions } = usePortfolio();

    const { data: exchangeData } = useQuery({
        queryKey: ['exchange-rates', defaultCurrency],
        queryFn: () => apiClient.request('/api/info/exchange-rates'),
        staleTime: 60_000,
    });

    const { data: netWorthData } = useQuery({
        queryKey: ["net-worth", defaultCurrency],
        queryFn: () => apiClient.getNetWorth({ currency: defaultCurrency }),
        staleTime: 60_000,
    });

    const historicalPriceInvestments = useMemo(
        () => summaries
            .filter((s) => ['stock', 'etf', 'crypto', 'metals'].includes(s.assetClass))
            .map((s) => s.id),
        [summaries]
    );

    const { data: customHistoryData } = useQuery({
        queryKey: ['investment-price-history', historicalPriceInvestments],
        queryFn: async () => {
            const entries = await Promise.all(
                historicalPriceInvestments.map(async (id) => {
                    try {
                        const res = await apiClient.getInvestmentPriceHistory(id);
                        const points = ((res?.points || []) as HistoryPointResponse[])
                            .map((p) => ({ timestampMs: Number(p.timestampMs), price: Number(p.price) }))
                            .filter((p: HistoryPoint) => Number.isFinite(p.timestampMs) && Number.isFinite(p.price) && p.price > 0)
                            .sort((a: HistoryPoint, b: HistoryPoint) => a.timestampMs - b.timestampMs);
                        return [id, points] as const;
                    } catch {
                        return [id, []] as const;
                    }
                })
            );
            return Object.fromEntries(entries) as Record<number, HistoryPoint[]>;
        },
        enabled: historicalPriceInvestments.length > 0,
        staleTime: 5 * 60_000,
    });

    const ratesToEur: Record<string, number> = useMemo(() => ({
        EUR: 1,
        ...Object.fromEntries(
            (exchangeData?.rates || []).map((r: { currency: string; rate_to_eur: number }) => [r.currency, Number(r.rate_to_eur)])
        ),
        ...(exchangeData?.fallback_rates || {}),
    }), [exchangeData]);

    const convertToTarget = useCallback((amount: number, fromCurrency?: string) => {
        const from = (fromCurrency || 'EUR').toUpperCase();
        const to = defaultCurrency.toUpperCase();
        if (from === to) return amount;
        const rateFrom = ratesToEur[from];
        const rateTo = ratesToEur[to];
        if (!rateFrom || !rateTo) return amount;
        return (amount * rateFrom) / rateTo;
    }, [defaultCurrency, ratesToEur]);
    const [selectedPeriod, setSelectedPeriod] = useState<Period>("all");

    const PERIOD_LABELS: Record<Period, string> = {
        "1m": t('performance.period.1m'),
        "3m": t('performance.period.3m'),
        "6m": t('performance.period.6m'),
        "1y": t('performance.period.1y'),
        "3y": t('performance.period.3y'),
        "all": t('performance.period.all'),
    };

    const parsedTransactions: ParsedPortfolioTransaction[] = useMemo(
        () => transactions
            .map((t) => {
                const parsedDate = parseISO(t.date);
                return { ...t, _parsedDate: parsedDate };
            })
            .filter((t) => isValid(t._parsedDate))
            .sort((a, b) => a._parsedDate.getTime() - b._parsedDate.getTime()),
        [transactions],
    );

    const investmentAssetClassById = useMemo(() => {
        const map = new Map<number, AssetClass>();
        for (const investment of summaries) {
            map.set(investment.id, investment.assetClass);
        }
        return map;
    }, [summaries]);

    const monthlyNetFlows = useMemo(() => {
        const byMonth = new Map<string, RelativeFlowBucket>();

        const ensure = (month: string) => {
            const existing = byMonth.get(month);
            if (existing) return existing;
            const created: RelativeFlowBucket = {
                portfolio: 0,
                stocksEtfs: 0,
                crypto: 0,
                metals: 0,
            };
            byMonth.set(month, created);
            return created;
        };

        for (const transaction of parsedTransactions) {
            if (transaction.type !== "buy" && transaction.type !== "gift" && transaction.type !== "sell") {
                continue;
            }

            const rawAmount = Number(transaction.amount);
            if (!Number.isFinite(rawAmount) || rawAmount === 0) continue;

            const signedFlow = transaction.type === "sell"
                ? -convertToTarget(rawAmount, transaction.currency)
                : convertToTarget(rawAmount, transaction.currency);

            if (!Number.isFinite(signedFlow) || signedFlow === 0) continue;

            const monthKey = format(transaction._parsedDate, "yyyy-MM");
            const bucket = ensure(monthKey);
            bucket.portfolio += signedFlow;

            const assetClass = investmentAssetClassById.get(transaction.investment_id);
            if (assetClass === "stock" || assetClass === "etf") {
                bucket.stocksEtfs += signedFlow;
            } else if (assetClass === "crypto") {
                bucket.crypto += signedFlow;
            } else if (assetClass === "metals") {
                bucket.metals += signedFlow;
            }
        }

        return byMonth;
    }, [parsedTransactions, convertToTarget, investmentAssetClassById]);

    const netWorthInvestmentsByMonth = useMemo(() => {
        const map = new Map<string, number>();
        for (const snapshot of netWorthData?.snapshots ?? []) {
            if (!snapshot?.date || !Number.isFinite(snapshot.investments)) continue;
            map.set(snapshot.date.slice(0, 7), snapshot.investments);
        }
        return map;
    }, [netWorthData?.snapshots]);

    // ─── Compute monthly snapshots ───
    const allSnapshots: MonthlySnapshot[] = useMemo(() => {
        if (summaries.length === 0 || parsedTransactions.length === 0) return [];

        const firstDate = parsedTransactions[0]._parsedDate;
        const now = new Date();
        const totalMonths = differenceInMonths(now, firstDate) + 1;
        if (!Number.isFinite(totalMonths) || totalMonths <= 0) return [];

        const snapshots: MonthlySnapshot[] = [];
        let cumulativeInflation = 1;

        for (let i = 0; i < totalMonths; i++) {
            const monthStart = startOfMonth(new Date(firstDate.getFullYear(), firstDate.getMonth() + i, 1));
            const monthEnd = endOfMonth(monthStart);
            const monthKey = format(monthStart, "yyyy-MM");

            if (isAfter(monthStart, now)) break;

            // Calculate invested amount up to this month
            const txnsUpToMonth = parsedTransactions.filter(
                (t) => !isAfter(t._parsedDate, monthEnd)
            );

            let invested = 0;
            const unitsByInvestment: Record<number, number> = {};

            for (const t of txnsUpToMonth) {
                if (t.type === "buy") {
                    invested += convertToTarget(Number(t.amount), t.currency);
                    unitsByInvestment[t.investment_id] = (unitsByInvestment[t.investment_id] || 0) + (Number(t.units) || 0);
                } else if (t.type === "gift") {
                    invested += convertToTarget(Number(t.amount), t.currency);
                    unitsByInvestment[t.investment_id] = (unitsByInvestment[t.investment_id] || 0) + (Number(t.units) || 0);
                } else if (t.type === "sell") {
                    unitsByInvestment[t.investment_id] = (unitsByInvestment[t.investment_id] || 0) - (Number(t.units) || 0);
                }
            }

            // Estimate value at end of month
            // For current month, use current prices; for past months, use linear interpolation
            let value = 0;
            let stocksEtfsValue = 0;
            let cryptoValue = 0;
            let metalsValue = 0;
            for (const inv of summaries) {
                const units = unitsByInvestment[inv.id] || 0;
                if (units <= 0) continue;

                const addClassValue = (amount: number) => {
                    if (!Number.isFinite(amount)) return;
                    if (inv.assetClass === "stock" || inv.assetClass === "etf") {
                        stocksEtfsValue += amount;
                    } else if (inv.assetClass === "crypto") {
                        cryptoValue += amount;
                    } else if (inv.assetClass === "metals") {
                        metalsValue += amount;
                    }
                };

                if (["stock", "etf", "crypto", "metals"].includes(inv.assetClass) && inv.currentPrice) {
                    const historyPoints = customHistoryData?.[inv.id] || [];
                    const historicalPrice = getPriceFromHistory(historyPoints, monthEnd);
                    const effectivePrice = historicalPrice ?? inv.currentPrice;
                    const classValue = convertToTarget(units * effectivePrice, inv.currency);
                    value += classValue;
                    addClassValue(classValue);
                } else {
                    // For real estate, savings etc., use proportional value
                    const invTxns = txnsUpToMonth.filter((t) => t.investment_id === inv.id);
                    const invBuys = invTxns.filter((t) => t.type === "buy").reduce((s, t) => s + convertToTarget(Number(t.amount), t.currency), 0);
                    const invSells = invTxns.filter((t) => t.type === "sell").reduce((s, t) => s + convertToTarget(Number(t.amount), t.currency), 0);
                    const invInterest = invTxns.filter((t) => t.type === "interest").reduce((s, t) => s + convertToTarget(Number(t.amount), t.currency), 0);
                    const invAppreciation = invTxns.filter((t) => t.type === "appreciation").reduce((s, t) => s + convertToTarget(Number(t.amount), t.currency), 0);
                    const classValue = invBuys - invSells + invInterest + invAppreciation;
                    value += classValue;
                    addClassValue(classValue);
                }
            }

            // Inflation
            const monthlyInfl = getMonthlyInflation(monthStart.getFullYear());
            cumulativeInflation *= 1 + monthlyInfl;

            const netWorthValue = netWorthInvestmentsByMonth.get(monthKey);
            const effectiveValue = Number.isFinite(netWorthValue) ? Number(netWorthValue) : value;

            if (Number.isFinite(effectiveValue) && value > 0) {
                const scale = effectiveValue / value;
                stocksEtfsValue *= scale;
                cryptoValue *= scale;
                metalsValue *= scale;
            }

            const gainLoss = effectiveValue - invested;
            const returnPct = invested > 0 ? (gainLoss / invested) * 100 : 0;
            const inflationAdjustedValue = effectiveValue / cumulativeInflation;
            const realReturnPct = invested > 0 ? ((inflationAdjustedValue - invested) / invested) * 100 : 0;

            snapshots.push({
                month: monthKey,
                date: monthStart,
                invested: Math.round(invested * 100) / 100,
                value: Math.round(effectiveValue * 100) / 100,
                stocksEtfsValue: Math.round(stocksEtfsValue * 100) / 100,
                cryptoValue: Math.round(cryptoValue * 100) / 100,
                metalsValue: Math.round(metalsValue * 100) / 100,
                gainLoss: Math.round(gainLoss * 100) / 100,
                returnPct: Math.round(returnPct * 100) / 100,
                inflationAdjustedValue: Math.round(inflationAdjustedValue * 100) / 100,
                realReturnPct: Math.round(realReturnPct * 100) / 100,
                cumulativeInflation: Math.round((cumulativeInflation - 1) * 10000) / 100,
            });
        }

        return snapshots;
    }, [summaries, parsedTransactions, customHistoryData, convertToTarget, netWorthInvestmentsByMonth]);

    // ─── Filter by period ───
    const filteredSnapshots = useMemo(() => {
        if (allSnapshots.length === 0) return [];
        const now = new Date();
        let cutoff: Date;
        switch (selectedPeriod) {
            case "1m": cutoff = subMonths(now, 1); break;
            case "3m": cutoff = subMonths(now, 3); break;
            case "6m": cutoff = subMonths(now, 6); break;
            case "1y": cutoff = subYears(now, 1); break;
            case "3y": cutoff = subYears(now, 3); break;
            default: return allSnapshots;
        }
        return allSnapshots.filter((s) => !isBefore(s.date, cutoff));
    }, [allSnapshots, selectedPeriod]);

    // ─── Overall portfolio metrics (independent of selected period) ───
    const overallMetrics = useMemo(() => {
        if (allSnapshots.length < 1) return null;

        const first = allSnapshots[0];
        const last = allSnapshots[allSnapshots.length - 1];
        const days = differenceInDays(last.date, first.date) || 1;

        const totalInvested = summaries.reduce((sum, inv) => sum + convertToTarget(inv.totalBuyCost, inv.currency), 0);
        const currentValue = summaries.reduce((sum, inv) => sum + convertToTarget(inv.currentValue, inv.currency), 0);
        const totalGainLoss = summaries.reduce((sum, inv) => sum + convertToTarget(inv.totalGain, inv.currency), 0);
        const totalReturnPct = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;

        const years = days / 365.25;
        const annualizedReturn = totalInvested > 0 && years > 0 && currentValue > 0
            ? (Math.pow(currentValue / totalInvested, 1 / years) - 1) * 100
            : 0;

        return {
            currentValue: Math.round(currentValue * 100) / 100,
            totalInvested: Math.round(totalInvested * 100) / 100,
            totalGainLoss: Math.round(totalGainLoss * 100) / 100,
            totalReturnPct: Math.round(totalReturnPct * 100) / 100,
            annualizedReturn: Math.round((Number.isFinite(annualizedReturn) ? annualizedReturn : 0) * 100) / 100,
            realReturnPct: Math.round(last.realReturnPct * 100) / 100,
            cumulativeInflation: last.cumulativeInflation,
        };
    }, [allSnapshots, summaries, convertToTarget]);

    // ─── Monthly returns heatmap data ───
    const heatmapData = useMemo(() => {
        if (allSnapshots.length < 1) {
            return { years: [], data: {} as Record<number, (number | null)[]>, maxAbsPct: 0 };
        }

        const years = [...new Set(allSnapshots.map((s) => s.date.getFullYear()))].sort();
        const data: Record<number, (number | null)[]> = {};
        const monthlyReturns: number[] = [];

        for (const year of years) {
            data[year] = Array(12).fill(null);
        }

        for (let i = 0; i < allSnapshots.length; i++) {
            const prev = i > 0 ? allSnapshots[i - 1] : undefined;
            const curr = allSnapshots[i];
            const monthIdx = curr.date.getMonth();
            const year = curr.date.getFullYear();

            let monthlyReturnPct: number;
            if (!prev) {
                monthlyReturnPct = 0;
            } else {
                const baseValue = prev.value;
                const netContribution = monthlyNetFlows.get(curr.month)?.portfolio ?? 0;
                monthlyReturnPct = baseValue > 0
                    ? ((curr.value - prev.value - netContribution) / baseValue) * 100
                    : 0;
            }

            const roundedReturnPct = Math.round(monthlyReturnPct * 100) / 100;
            data[year][monthIdx] = roundedReturnPct;
            monthlyReturns.push(Math.abs(roundedReturnPct));
        }

        const maxAbsPct = monthlyReturns.length > 0 ? Math.max(...monthlyReturns) : 0;

        return { years, data, maxAbsPct };
    }, [allSnapshots, monthlyNetFlows]);

    const monthLabelLocale = useMemo(() => (language === "nl" ? "nl-NL" : "en-US"), [language]);

    // Locale-aware month abbreviations based on app language
    const MONTH_LABELS = useMemo(() => {
        return Array.from({ length: 12 }, (_, i) =>
            formatMonthLabelWithLocale(new Date(2000, i, 1), monthLabelLocale, "short")
        );
    }, [monthLabelLocale]);

    function getHeatColor(val: number | null, maxAbsPct: number): string {
        if (val === null) return "bg-muted/30";
        if (val === 0) return "bg-muted text-muted-foreground";

        const scale = Math.max(maxAbsPct, 1);
        const ratio = Math.abs(val) / scale;
        const absPct = Math.abs(val);

        // Keep tiny monthly moves near-neutral to highlight meaningful months.
        if (absPct < 0.25) return "bg-muted/70 text-muted-foreground";

        const strongMove = absPct >= 2.5 || ratio > 0.72;
        const mediumMove = absPct >= 1.0 || ratio > 0.42;

        if (val > 0 && strongMove) return "bg-emerald-600 text-white";
        if (val > 0 && mediumMove) return "bg-emerald-500 text-white";
        if (val > 0) return "bg-emerald-400/80 text-emerald-950";
        if (strongMove) return "bg-rose-600 text-white";
        if (mediumMove) return "bg-rose-500 text-white";
        return "bg-rose-400/80 text-rose-950";
    }

    const formatPct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

    const monthTickFormatter = useMemo(
        () => new Intl.DateTimeFormat(monthLabelLocale, { month: "short", year: "2-digit" }),
        [monthLabelLocale],
    );

    // ─── Chart data ───
    const chartData = filteredSnapshots.map((s) => ({
        month: monthTickFormatter.format(s.date),
        [t('portfolio.totalInvested')]: s.invested,
        [t('performance.inflationAdjusted')]: s.inflationAdjustedValue,
        [t('portfolio.portfolioValue')]: s.value,
    }));

    const relativePerformanceData = useMemo(() => {
        if (filteredSnapshots.length === 0) return [];

        const buildRelativeSeries = (
            valueSelector: (snapshot: MonthlySnapshot) => number,
            flowSelector: (flow: RelativeFlowBucket) => number,
        ) => {
            const results: number[] = [];
            let index = 100;

            for (let i = 0; i < filteredSnapshots.length; i++) {
                if (i === 0) {
                    results.push(0);
                    continue;
                }

                const prev = filteredSnapshots[i - 1];
                const curr = filteredSnapshots[i];
                if (!prev || !curr) {
                    results.push(Math.round((index - 100) * 100) / 100);
                    continue;
                }

                const prevValue = valueSelector(prev);
                const currValue = valueSelector(curr);
                const monthlyFlow = flowSelector(monthlyNetFlows.get(curr.month) ?? {
                    portfolio: 0,
                    stocksEtfs: 0,
                    crypto: 0,
                    metals: 0,
                });

                const rawReturn = prevValue > 0
                    ? (currValue - prevValue - monthlyFlow) / prevValue
                    : 0;

                const boundedReturn = Number.isFinite(rawReturn)
                    ? Math.max(rawReturn, -0.9999)
                    : 0;

                index *= 1 + boundedReturn;
                results.push(Math.round((index - 100) * 100) / 100);
            }

            return results;
        };

        const portfolioSeries = buildRelativeSeries(
            (snapshot) => snapshot.value,
            (flow) => flow.portfolio,
        );
        const stocksEtfsSeries = buildRelativeSeries(
            (snapshot) => snapshot.stocksEtfsValue,
            (flow) => flow.stocksEtfs,
        );
        const cryptoSeries = buildRelativeSeries(
            (snapshot) => snapshot.cryptoValue,
            (flow) => flow.crypto,
        );
        const metalsSeries = buildRelativeSeries(
            (snapshot) => snapshot.metalsValue,
            (flow) => flow.metals,
        );

        return filteredSnapshots.map((snapshot, idx) => ({
            month: monthTickFormatter.format(snapshot.date),
            [t('performance.relativePortfolio')]: portfolioSeries[idx] ?? 0,
            [t('performance.relativeStocksEtfs')]: stocksEtfsSeries[idx] ?? 0,
            [t('performance.relativeCrypto')]: cryptoSeries[idx] ?? 0,
            [t('performance.relativeMetals')]: metalsSeries[idx] ?? 0,
        }));
    }, [filteredSnapshots, t, monthTickFormatter, monthlyNetFlows]);

    if (summaries.length === 0) {
        return (
            <div className="space-y-6">
                <h1 className="text-3xl font-bold text-foreground">{t('performance.title')}</h1>
                <Card>
                    <CardContent className="flex items-center justify-center h-48">
                        <p className="text-muted-foreground">{t('performance.noData')}</p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (allSnapshots.length === 0) {
        return (
            <div className="space-y-6">
                <h1 className="text-3xl font-bold text-foreground">{t('performance.title')}</h1>
                <Card>
                    <CardContent className="flex items-center justify-center h-48">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">{t('performance.title')}</h1>
                    <p className="text-muted-foreground mt-1">{t('performance.subtitle')}</p>
                </div>
            </div>

            {/* Period selector */}
            <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
                {PERIOD_KEYS.map((p) => (
                    <button
                        key={p}
                        onClick={() => setSelectedPeriod(p)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                            selectedPeriod === p
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {PERIOD_LABELS[p]}
                    </button>
                ))}
            </div>

            {/* Key metrics cards */}
            {overallMetrics && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <MetricCard
                        title={t('portfolio.portfolioValue')}
                        value={formatCurrency(overallMetrics.currentValue, defaultCurrency, locale)}
                        subtitle={t('portfolio.invested', { amount: formatCurrency(overallMetrics.totalInvested, defaultCurrency, locale) })}
                        icon={DollarSign}
                        trend={overallMetrics.totalGainLoss >= 0}
                    />
                    <MetricCard
                        title={t('portfolio.totalReturn')}
                        value={`${overallMetrics.totalReturnPct >= 0 ? "+" : ""}${overallMetrics.totalReturnPct.toFixed(2)}%`}
                        subtitle={formatCurrency(overallMetrics.totalGainLoss, defaultCurrency, locale)}
                        icon={overallMetrics.totalReturnPct >= 0 ? TrendingUp : TrendingDown}
                        trend={overallMetrics.totalReturnPct >= 0}
                    />
                    <MetricCard
                        title={t('portfolio.annualizedReturn')}
                        value={`${overallMetrics.annualizedReturn >= 0 ? "+" : ""}${overallMetrics.annualizedReturn.toFixed(2)}%`}
                        subtitle={t('performance.projectedYearly')}
                        icon={Activity}
                        trend={overallMetrics.annualizedReturn >= 0}
                    />
                    <MetricCard
                        title={t('portfolio.realReturn')}
                        value={`${overallMetrics.realReturnPct >= 0 ? "+" : ""}${overallMetrics.realReturnPct.toFixed(2)}%`}
                        subtitle={t('performance.cumulativeInflation', { n: overallMetrics.cumulativeInflation.toFixed(1) })}
                        icon={Percent}
                        trend={overallMetrics.realReturnPct >= 0}
                    />
                </div>
            )}

            {/* Performance chart */}
            {chartData.length > 1 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <BarChart3 className="h-5 w-5 text-primary" />
                            {t('performance.valueOverTime')}
                        </CardTitle>
                        <CardDescription>
                            {t('performance.chartDesc', { period: PERIOD_LABELS[selectedPeriod] })}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ResponsiveContainer width="100%" height={360}>
                            <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="gradValue" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                                    </linearGradient>
                                    <linearGradient id="gradInvested" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0.15} />
                                        <stop offset="95%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0} />
                                    </linearGradient>
                                    <linearGradient id="gradInflAdj" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(30, 80%, 55%)" stopOpacity={0.2} />
                                        <stop offset="95%" stopColor="hsl(30, 80%, 55%)" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                                <XAxis dataKey="month" tick={{ fontSize: 12 }} className="fill-muted-foreground" interval="preserveStartEnd" minTickGap={20} />
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
                                    formatter={(value: number) => [formatCurrency(value, defaultCurrency, locale)]}
                                />
                                <Legend />
                                <Area
                                    type="monotone"
                                    dataKey={t('portfolio.totalInvested')}
                                    stroke="hsl(var(--muted-foreground))"
                                    fill="url(#gradInvested)"
                                    strokeWidth={1.5}
                                    strokeDasharray="4 4"
                                />
                                <Area
                                    type="monotone"
                                    dataKey={t('performance.inflationAdjusted')}
                                    stroke="hsl(30, 80%, 55%)"
                                    fill="url(#gradInflAdj)"
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={t('portfolio.portfolioValue')}
                                    stroke="hsl(var(--primary))"
                                    fill="url(#gradValue)"
                                    strokeWidth={2.5}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>
            )}

            {/* Relative performance chart */}
            {relativePerformanceData.length > 1 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Activity className="h-5 w-5 text-primary" />
                            {t('performance.relativeTitle')}
                        </CardTitle>
                        <CardDescription>
                            {t('performance.relativeDesc', { period: PERIOD_LABELS[selectedPeriod] })}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ResponsiveContainer width="100%" height={320}>
                            <AreaChart data={relativePerformanceData} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                                <defs>
                                    <linearGradient id="gradRelPortfolio" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                                <XAxis dataKey="month" tick={{ fontSize: 12 }} className="fill-muted-foreground" interval="preserveStartEnd" minTickGap={20} />
                                <YAxis
                                    tick={{ fontSize: 12 }}
                                    className="fill-muted-foreground"
                                    tickFormatter={(v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(0)}%`}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: "hsl(var(--card))",
                                        border: "1px solid hsl(var(--border))",
                                        borderRadius: "8px",
                                        fontSize: "12px",
                                    }}
                                    formatter={(value: number) => [`${value > 0 ? '+' : ''}${value.toFixed(2)}%`]}
                                />
                                <Legend />
                                <Area
                                    type="monotone"
                                    dataKey={t('performance.relativePortfolio')}
                                    stroke="hsl(var(--primary))"
                                    fill="url(#gradRelPortfolio)"
                                    strokeWidth={2.5}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={t('performance.relativeStocksEtfs')}
                                    stroke="hsl(217, 91%, 60%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={t('performance.relativeCrypto')}
                                    stroke="hsl(142, 76%, 36%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={t('performance.relativeMetals')}
                                    stroke="hsl(45, 93%, 47%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>
            )}

            {/* Per-asset class breakdown */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {(() => {
                    const classes = [...new Set(summaries.map((s) => s.assetClass))];
                    return classes.map((cls) => {
                        const items = summaries.filter((s) => s.assetClass === cls);
                        const classValue = items.reduce((s, i) => s + convertToTarget(i.currentValue, i.currency), 0);
                        const classInvested = items.reduce((s, i) => s + convertToTarget(i.totalInvested, i.currency), 0);
                        const classGain = items.reduce((s, i) => s + convertToTarget(i.gainLoss, i.currency), 0);
                        const classPct = classInvested > 0 ? (classGain / classInvested) * 100 : 0;
                        const label = t(`performance.${cls}` as `performance.${AssetClass}`) || cls;
                        const count = items.length;
                        return (
                            <Card key={cls} className="border shadow-sm">
                                <CardContent className="pt-4 pb-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-sm font-semibold text-muted-foreground">
                                            {label}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {count === 1
                                                ? t('performance.holdings', { count: String(count) })
                                                : t('performance.holdingsPlural', { count: String(count) })}
                                        </span>
                                    </div>
                                    <div className="text-xl font-bold text-foreground">
                                        {formatCurrency(classValue, defaultCurrency, locale)}
                                    </div>
                                    <div className={`text-sm font-medium mt-1 ${classGain >= 0 ? "text-accent" : "text-destructive"}`}>
                                        {classGain >= 0 ? "+" : ""}{formatCurrency(classGain, defaultCurrency, locale)} ({classPct >= 0 ? "+" : ""}{classPct.toFixed(1)}%)
                                    </div>
                                    <div className="text-xs text-muted-foreground mt-1">
                                        {t('portfolio.invested', { amount: formatCurrency(classInvested, defaultCurrency, locale) })}
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    });
                })()}
            </div>

            {/* Monthly Returns Heatmap */}
            {heatmapData.years.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Calendar className="h-5 w-5 text-primary" />
                            {t('performance.monthlyHeatmap')}
                        </CardTitle>
                        <CardDescription>{t('performance.heatmapDesc')}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr>
                                        <th className="text-left py-2 px-2 font-semibold text-muted-foreground w-16">{t('performance.year')}</th>
                                        {MONTH_LABELS.map((m) => (
                                            <th key={m} className="text-center py-2 px-1 font-semibold text-muted-foreground min-w-[48px]">
                                                {m}
                                            </th>
                                        ))}
                                         <th className="text-center py-2 px-2 font-semibold text-muted-foreground min-w-[56px]">{t('performance.ytd')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {heatmapData.years.map((year) => {
                                        const months = heatmapData.data[year];
                                        const validMonths = months.filter((v): v is number => v !== null);
                                        const ytd = validMonths.length > 0
                                            ? ((validMonths.reduce((acc, v) => acc * (1 + (v / 100)), 1) - 1) * 100)
                                            : null;

                                        return (
                                            <tr key={year}>
                                                <td className="py-1 px-2 font-bold text-foreground">{year}</td>
                                                {months.map((val, idx) => (
                                                    <td key={idx} className="py-1 px-1">
                                                        <div
                                                            className={`rounded-md py-1.5 px-1 text-center font-mono font-medium transition-colors ${getHeatColor(val, heatmapData.maxAbsPct)}`}
                                                            title={val !== null ? formatPct(val) : t('common.noData2')}
                                                        >
                                                            {val !== null ? formatPct(val) : "–"}
                                                        </div>
                                                    </td>
                                                ))}
                                                <td className="py-1 px-2">
                                                    <div
                                                        className={`rounded-md py-1.5 px-1 text-center font-mono font-bold transition-colors ${getHeatColor(ytd, heatmapData.maxAbsPct)}`}
                                                    >
                                                        {ytd !== null ? formatPct(ytd) : "–"}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                         {/* Legend */}
                        <div className="flex items-center justify-center gap-2 mt-4 text-xs text-muted-foreground">
                             <span>{t('performance.loss')}</span>
                            <div className="flex gap-0.5">
                                <div className="w-6 h-4 rounded-sm bg-rose-600" />
                                <div className="w-6 h-4 rounded-sm bg-rose-500" />
                                <div className="w-6 h-4 rounded-sm bg-rose-400/80" />
                                <div className="w-6 h-4 rounded-sm bg-muted" />
                                <div className="w-6 h-4 rounded-sm bg-emerald-400/80" />
                                <div className="w-6 h-4 rounded-sm bg-emerald-500" />
                                <div className="w-6 h-4 rounded-sm bg-emerald-600" />
                            </div>
                            <span>{t('performance.gain')}</span>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Top/Bottom performers */}
            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-accent">
                            <TrendingUp className="h-5 w-5" />
                            {t('performance.topPerformers')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {[...summaries]
                                .sort((a, b) => b.gainLossPercent - a.gainLossPercent)
                                .slice(0, 5)
                                .map((inv) => (
                                    <div key={inv.id} className="flex items-center justify-between">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-foreground truncate">{inv.name}</p>
                                            <p className="text-xs text-muted-foreground">{inv.symbol || inv.assetClass}</p>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className={`text-sm font-bold ${inv.gainLossPercent >= 0 ? "text-accent" : "text-destructive"}`}>
                                                {inv.gainLossPercent >= 0 ? "+" : ""}{inv.gainLossPercent.toFixed(1)}%
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {formatCurrency(convertToTarget(inv.gainLoss, inv.currency), defaultCurrency, locale)}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-destructive">
                            <TrendingDown className="h-5 w-5" />
                            {t('performance.bottomPerformers')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {[...summaries]
                                .sort((a, b) => a.gainLossPercent - b.gainLossPercent)
                                .slice(0, 5)
                                .map((inv) => (
                                    <div key={inv.id} className="flex items-center justify-between">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-foreground truncate">{inv.name}</p>
                                            <p className="text-xs text-muted-foreground">{inv.symbol || inv.assetClass}</p>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className={`text-sm font-bold ${inv.gainLossPercent >= 0 ? "text-accent" : "text-destructive"}`}>
                                                {inv.gainLossPercent >= 0 ? "+" : ""}{inv.gainLossPercent.toFixed(1)}%
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {formatCurrency(convertToTarget(inv.gainLoss, inv.currency), defaultCurrency, locale)}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

// ─── Reusable metric card ───
function MetricCard({
    title, value, subtitle, icon: Icon, trend,
}: {
    title: string; value: string; subtitle: string;
    icon: React.ComponentType<{ className?: string }>; trend: boolean;
}) {
    const gradient = trend
        ? "from-emerald-500/10 to-green-500/5"
        : "from-rose-500/10 to-red-500/5";
    const iconBg = trend
        ? "bg-gradient-to-br from-emerald-500/20 to-green-500/20 text-emerald-600 dark:text-emerald-400"
        : "bg-gradient-to-br from-rose-500/20 to-red-500/20 text-rose-600 dark:text-rose-300";

    return (
        <Card className={`relative overflow-hidden border-none shadow-lg bg-gradient-to-br ${gradient} backdrop-blur-sm`}>
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16" />
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground">{title}</CardTitle>
                <div className={`h-9 w-9 rounded-xl flex items-center justify-center ${iconBg} shadow-sm`}>
                    <Icon className="h-4 w-4" />
                </div>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold text-foreground">{value}</div>
                <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            </CardContent>
        </Card>
    );
}
