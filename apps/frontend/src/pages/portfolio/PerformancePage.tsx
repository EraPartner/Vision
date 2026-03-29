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
import { format, parseISO, differenceInMonths, differenceInDays, startOfMonth, endOfMonth, isAfter, isValid, subMonths, subYears } from "date-fns";
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

type Period = "1m" | "3m" | "6m" | "1y" | "3y" | "all";

interface MonthlySnapshot {
    month: string; // YYYY-MM
    day: string; // YYYY-MM-DD
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

const CHART_KEYS = {
    invested: 'invested',
    inflationAdjusted: 'inflationAdjusted',
    value: 'value',
    stocksEtfs: 'stocksEtfs',
    crypto: 'crypto',
    metals: 'metals',
    relativePortfolio: 'relativePortfolio',
    relativeStocksEtfs: 'relativeStocksEtfs',
    relativeCrypto: 'relativeCrypto',
    relativeMetals: 'relativeMetals',
} as const;

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

    const historyRange = useMemo(() => {
        let earliestTimestamp = Number.POSITIVE_INFINITY;

        for (const transaction of transactions) {
            const parsed = Date.parse(transaction.date);
            if (!Number.isFinite(parsed)) continue;
            if (parsed < earliestTimestamp) earliestTimestamp = parsed;
        }

        if (!Number.isFinite(earliestTimestamp)) return undefined;

        const from = new Date(earliestTimestamp);
        from.setHours(0, 0, 0, 0);

        const to = new Date();
        to.setHours(23, 59, 59, 999);

        return {
            fromMs: from.getTime(),
            toMs: to.getTime(),
        };
    }, [transactions]);

    const historicalPriceInvestments = useMemo(
        () => summaries
            .filter((s) => ['stock', 'etf', 'crypto', 'metals'].includes(s.assetClass))
            .map((s) => s.id)
            .sort((a, b) => a - b),
        [summaries]
    );

    const { data: customHistoryData } = useQuery({
        queryKey: [
            'investment-price-history',
            historicalPriceInvestments.join(','),
            historyRange?.fromMs ?? null,
            historyRange?.toMs ?? null,
        ],
        queryFn: async () => {
            const entries = await Promise.all(
                historicalPriceInvestments.map(async (id) => {
                    try {
                        const res = await apiClient.getInvestmentPriceHistory(id, historyRange
                            ? {
                                from_ms: historyRange.fromMs,
                                to_ms: historyRange.toMs,
                                db_only: true,
                            }
                            : undefined);
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
        enabled: historicalPriceInvestments.length > 0 && Boolean(historyRange),
        staleTime: 5 * 60_000,
    });

    const ratesToEur: Record<string, number> = useMemo(() => ({
        EUR: 1,
        ...Object.fromEntries(
            (exchangeData?.rates || []).map((r: { currency: string; rate_to_eur: number }) => [r.currency, Number(r.rate_to_eur)])
        ),
        ...(exchangeData?.fallback_rates || {}),
    }), [exchangeData]);

    const convertToTarget = useCallback((amount: number, fromCurrency?: string, fxRateToEur?: number) => {
        const from = (fromCurrency || 'EUR').toUpperCase();
        const to = defaultCurrency.toUpperCase();
        if (from === to) return amount;
        const rateTo = ratesToEur[to];

        const txRateToEur = Number(fxRateToEur);
        if (from !== 'EUR' && Number.isFinite(txRateToEur) && txRateToEur > 0 && Number.isFinite(rateTo) && rateTo > 0) {
            return (amount * txRateToEur) / rateTo;
        }

        const rateFrom = ratesToEur[from];
        if (!rateFrom || !rateTo) return amount;
        return (amount * rateFrom) / rateTo;
    }, [defaultCurrency, ratesToEur]);

    const convertTransactionAmountToTarget = useCallback((transaction: ParsedPortfolioTransaction) => {
        return convertToTarget(Number(transaction.amount), transaction.currency, transaction.fx_rate_to_eur);
    }, [convertToTarget]);
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

    const inflationStartMonth = useMemo(() => {
        const firstDate = parsedTransactions[0]?._parsedDate;
        return firstDate ? format(firstDate, "yyyy-MM") : undefined;
    }, [parsedTransactions]);

    const { data: inflationRatesData } = useQuery({
        queryKey: ['belgian-inflation-rates', inflationStartMonth],
        queryFn: () => apiClient.getBelgianInflationRates({
            start_month: inflationStartMonth,
            db_only: true,
        }),
        enabled: Boolean(inflationStartMonth),
        staleTime: 24 * 60 * 60 * 1000,
    });

    const inflationByMonth = useMemo(() => {
        const map = new Map<string, number>();
        for (const rate of inflationRatesData?.rates ?? []) {
            if (!rate?.month || !Number.isFinite(rate.monthly_rate)) continue;
            map.set(rate.month, Number(rate.monthly_rate));
        }
        return map;
    }, [inflationRatesData?.rates]);

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

            const convertedAmount = convertTransactionAmountToTarget(transaction);
            const signedFlow = transaction.type === "sell"
                ? -convertedAmount
                : convertedAmount;

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
    }, [parsedTransactions, convertTransactionAmountToTarget, investmentAssetClassById]);

    const dailyNetFlows = useMemo(() => {
        const byDay = new Map<string, RelativeFlowBucket>();

        const ensure = (day: string) => {
            const existing = byDay.get(day);
            if (existing) return existing;
            const created: RelativeFlowBucket = {
                portfolio: 0,
                stocksEtfs: 0,
                crypto: 0,
                metals: 0,
            };
            byDay.set(day, created);
            return created;
        };

        for (const transaction of parsedTransactions) {
            if (transaction.type !== "buy" && transaction.type !== "gift" && transaction.type !== "sell") {
                continue;
            }

            const rawAmount = Number(transaction.amount);
            if (!Number.isFinite(rawAmount) || rawAmount === 0) continue;

            const convertedAmount = convertTransactionAmountToTarget(transaction);
            const signedFlow = transaction.type === "sell"
                ? -convertedAmount
                : convertedAmount;

            if (!Number.isFinite(signedFlow) || signedFlow === 0) continue;

            const dayKey = format(transaction._parsedDate, "yyyy-MM-dd");
            const bucket = ensure(dayKey);
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

        return byDay;
    }, [parsedTransactions, convertTransactionAmountToTarget, investmentAssetClassById]);

    const netWorthInvestmentsByMonth = useMemo(() => {
        const map = new Map<string, number>();
        for (const snapshot of netWorthData?.snapshots ?? []) {
            if (!snapshot?.date || !Number.isFinite(snapshot.investments)) continue;
            map.set(snapshot.date.slice(0, 7), snapshot.investments);
        }
        return map;
    }, [netWorthData?.snapshots]);

    const netWorthInvestmentsByDay = useMemo(() => {
        const map = new Map<string, number>();
        for (const snapshot of netWorthData?.snapshots ?? []) {
            if (!snapshot?.date || !Number.isFinite(snapshot.investments)) continue;
            map.set(snapshot.date, snapshot.investments);
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
        const sourceTransactions = parsedTransactions.filter((t) => !isAfter(t._parsedDate, now));
        let txIndex = 0;
        const txCount = sourceTransactions.length;
        let invested = 0;
        const unitsByInvestment: Record<number, number> = {};
        const lastTxPriceByInvestment: Record<number, number> = {};
        const nonMarketByInvestment: Record<number, { buys: number; sells: number; income: number; appreciation: number; feesTaxes: number }> = {};

        for (let i = 0; i < totalMonths; i++) {
            const monthStart = startOfMonth(new Date(firstDate.getFullYear(), firstDate.getMonth() + i, 1));
            const monthEnd = endOfMonth(monthStart);
            const monthKey = format(monthStart, "yyyy-MM");

            if (isAfter(monthStart, now)) break;

            while (txIndex < txCount && !isAfter(sourceTransactions[txIndex]._parsedDate, monthEnd)) {
                const t = sourceTransactions[txIndex];
                const convertedAmount = convertTransactionAmountToTarget(t);
                const nonMarketAgg = nonMarketByInvestment[t.investment_id]
                    || { buys: 0, sells: 0, income: 0, appreciation: 0, feesTaxes: 0 };

                if (t.type === "buy") {
                    invested += convertedAmount;
                    unitsByInvestment[t.investment_id] = (unitsByInvestment[t.investment_id] || 0) + (Number(t.units) || 0);
                    nonMarketAgg.buys += convertedAmount;
                    const rawUnits = Number(t.units) || 0;
                    const rawAmount = Number(t.amount) || 0;
                    if (rawUnits > 0 && rawAmount > 0) {
                        lastTxPriceByInvestment[t.investment_id] = rawAmount / rawUnits;
                    }
                } else if (t.type === "gift") {
                    invested += convertedAmount;
                    unitsByInvestment[t.investment_id] = (unitsByInvestment[t.investment_id] || 0) + (Number(t.units) || 0);
                    nonMarketAgg.buys += convertedAmount;
                } else if (t.type === "sell") {
                    invested -= convertedAmount;
                    unitsByInvestment[t.investment_id] = (unitsByInvestment[t.investment_id] || 0) - (Number(t.units) || 0);
                    nonMarketAgg.sells += convertedAmount;
                    const rawUnits = Number(t.units) || 0;
                    const rawAmount = Number(t.amount) || 0;
                    if (rawUnits > 0 && rawAmount > 0) {
                        lastTxPriceByInvestment[t.investment_id] = rawAmount / rawUnits;
                    }
                } else if (t.type === "interest" || t.type === "dividend" || t.type === "rent_income") {
                    nonMarketAgg.income += convertedAmount;
                } else if (t.type === "appreciation") {
                    nonMarketAgg.appreciation += convertedAmount;
                } else if (t.type === "fee" || t.type === "tax") {
                    nonMarketAgg.feesTaxes += convertedAmount;
                }

                nonMarketByInvestment[t.investment_id] = nonMarketAgg;
                txIndex += 1;
            }

            // Estimate value at end of month
            // For current month, use current prices; for past months, use linear interpolation
            let value = 0;
            let stocksEtfsValue = 0;
            let cryptoValue = 0;
            let metalsValue = 0;
            for (const inv of summaries) {
                const units = unitsByInvestment[inv.id] || 0;

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

                if (["stock", "etf", "crypto", "metals"].includes(inv.assetClass)) {
                    if (units <= 0) continue;
                    const historyPoints = customHistoryData?.[inv.id] || [];
                    let historicalPrice = getPriceFromHistory(historyPoints, monthEnd);
                    
                    if (!Number.isFinite(historicalPrice) || historicalPrice! <= 0) {
                        historicalPrice = lastTxPriceByInvestment[inv.id];
                    }
                    if (!Number.isFinite(historicalPrice) || historicalPrice! <= 0) {
                        if (historyPoints.length > 0) {
                            historicalPrice = historyPoints[0].price;
                        }
                    }
                    if (!Number.isFinite(historicalPrice) || historicalPrice! <= 0) {
                        historicalPrice = Number(inv.currentPrice || inv.current_price) || 0;
                    }
                    
                    if (!Number.isFinite(historicalPrice) || historicalPrice! <= 0) continue;
                    const classValue = convertToTarget(units * historicalPrice!, inv.currency);
                    value += classValue;
                    addClassValue(classValue);
                } else if (["real_estate", "savings", "bond"].includes(inv.assetClass)) {
                    // Fixed income: value stored directly in current_price (not units-based)
                    const fixedValue = Number(inv.currentPrice || inv.current_price) || 0;
                    if (fixedValue > 0) {
                        const classValue = convertToTarget(fixedValue, inv.currency);
                        value += classValue;
                    }
                } else {
                    // For other non-market assets, use accumulated non-market flows
                    const agg = nonMarketByInvestment[inv.id] || { buys: 0, sells: 0, income: 0, appreciation: 0, feesTaxes: 0 };
                    const classValue = agg.buys - agg.sells + agg.income + agg.appreciation - agg.feesTaxes;
                    value += classValue;
                    addClassValue(classValue);
                }
            }

            // Belgian monthly inflation from backend (Statbel-backed cache)
            const monthlyInfl = inflationByMonth.get(monthKey) ?? 0;
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
                day: `${monthKey}-01`,
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
    }, [summaries, parsedTransactions, customHistoryData, convertToTarget, convertTransactionAmountToTarget, netWorthInvestmentsByMonth, inflationByMonth]);

    const dailyFilteredSnapshots = useMemo(() => {
        if (parsedTransactions.length === 0) return [];

        const firstDate = parsedTransactions[0]._parsedDate;
        const now = new Date();
        let cutoff: Date;
        switch (selectedPeriod) {
            case "1m": cutoff = subMonths(now, 1); break;
            case "3m": cutoff = subMonths(now, 3); break;
            case "6m": cutoff = subMonths(now, 6); break;
            case "1y": cutoff = subYears(now, 1); break;
            case "3y": cutoff = subYears(now, 3); break;
            default: cutoff = firstDate; break;
        }

        const timelineStart = isAfter(cutoff, firstDate) ? cutoff : firstDate;
        const start = new Date(timelineStart);
        start.setHours(0, 0, 0, 0);

        const end = new Date();
        end.setHours(0, 0, 0, 0);

        const snapshots: MonthlySnapshot[] = [];
        let cumulativeInflation = 1;
        let currentInflationMonth = '';

        let invested = 0;
        const unitsByInvestment: Record<number, number> = {};
        const nonMarketByInvestment: Record<number, { buys: number; sells: number; interest: number; appreciation: number }> = {};
        const lastTxPriceByInvestment: Record<number, number> = {};

        const sourceTransactions = parsedTransactions.filter((t) => !isAfter(t._parsedDate, end));
        let txIndex = 0;
        const txCount = sourceTransactions.length;

        for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
            const dayEnd = new Date(day);
            dayEnd.setHours(23, 59, 59, 999);
            const dayKey = format(day, "yyyy-MM-dd");
            const monthKey = format(day, "yyyy-MM");

            while (txIndex < txCount && !isAfter(sourceTransactions[txIndex]._parsedDate, dayEnd)) {
                const tx = sourceTransactions[txIndex];
                const amount = convertTransactionAmountToTarget(tx);
                const units = Number(tx.units) || 0;

                if (tx.type === "buy") {
                    invested += amount;
                    unitsByInvestment[tx.investment_id] = (unitsByInvestment[tx.investment_id] || 0) + units;
                    const agg = nonMarketByInvestment[tx.investment_id] || { buys: 0, sells: 0, interest: 0, appreciation: 0 };
                    agg.buys += amount;
                    nonMarketByInvestment[tx.investment_id] = agg;
                    const rawUnits = Number(tx.units) || 0;
                    const rawAmount = Number(tx.amount) || 0;
                    if (rawUnits > 0 && rawAmount > 0) {
                        lastTxPriceByInvestment[tx.investment_id] = rawAmount / rawUnits;
                    }
                } else if (tx.type === "gift") {
                    invested += amount;
                    unitsByInvestment[tx.investment_id] = (unitsByInvestment[tx.investment_id] || 0) + units;
                    const agg = nonMarketByInvestment[tx.investment_id] || { buys: 0, sells: 0, interest: 0, appreciation: 0 };
                    agg.buys += amount;
                    nonMarketByInvestment[tx.investment_id] = agg;
                } else if (tx.type === "sell") {
                    invested -= amount;
                    unitsByInvestment[tx.investment_id] = (unitsByInvestment[tx.investment_id] || 0) - units;
                    const agg = nonMarketByInvestment[tx.investment_id] || { buys: 0, sells: 0, interest: 0, appreciation: 0 };
                    agg.sells += amount;
                    nonMarketByInvestment[tx.investment_id] = agg;
                    const rawUnits = Number(tx.units) || 0;
                    const rawAmount = Number(tx.amount) || 0;
                    if (rawUnits > 0 && rawAmount > 0) {
                        lastTxPriceByInvestment[tx.investment_id] = rawAmount / rawUnits;
                    }
                } else if (tx.type === "interest") {
                    const agg = nonMarketByInvestment[tx.investment_id] || { buys: 0, sells: 0, interest: 0, appreciation: 0 };
                    agg.interest += amount;
                    nonMarketByInvestment[tx.investment_id] = agg;
                } else if (tx.type === "appreciation") {
                    const agg = nonMarketByInvestment[tx.investment_id] || { buys: 0, sells: 0, interest: 0, appreciation: 0 };
                    agg.appreciation += amount;
                    nonMarketByInvestment[tx.investment_id] = agg;
                }

                txIndex += 1;
            }

            let value = 0;
            let stocksEtfsValue = 0;
            let cryptoValue = 0;
            let metalsValue = 0;

            const addClassValue = (assetClass: AssetClass, amount: number) => {
                if (!Number.isFinite(amount)) return;
                if (assetClass === "stock" || assetClass === "etf") {
                    stocksEtfsValue += amount;
                } else if (assetClass === "crypto") {
                    cryptoValue += amount;
                } else if (assetClass === "metals") {
                    metalsValue += amount;
                }
            };

            for (const inv of summaries) {
                const units = unitsByInvestment[inv.id] || 0;
                if (["stock", "etf", "crypto", "metals"].includes(inv.assetClass)) {
                    if (units <= 0) continue;
                    const historyPoints = customHistoryData?.[inv.id] || [];
                    let historicalPrice = getPriceFromHistory(historyPoints, dayEnd);
                    
                    if (!Number.isFinite(historicalPrice) || historicalPrice! <= 0) {
                        historicalPrice = lastTxPriceByInvestment[inv.id];
                    }
                    if (!Number.isFinite(historicalPrice) || historicalPrice! <= 0) {
                        if (historyPoints.length > 0) {
                            historicalPrice = historyPoints[0].price;
                        }
                    }
                    if (!Number.isFinite(historicalPrice) || historicalPrice! <= 0) {
                        historicalPrice = Number(inv.currentPrice || inv.current_price) || 0;
                    }

                    if (!Number.isFinite(historicalPrice) || historicalPrice! <= 0) continue;
                    const classValue = convertToTarget(units * historicalPrice!, inv.currency);
                    value += classValue;
                    addClassValue(inv.assetClass, classValue);
                } else if (["real_estate", "savings", "bond"].includes(inv.assetClass)) {
                    const fixedValue = Number(inv.currentPrice || inv.current_price) || 0;
                    if (fixedValue > 0) {
                        const classValue = convertToTarget(fixedValue, inv.currency);
                        value += classValue;
                    }
                } else {
                    const agg = nonMarketByInvestment[inv.id] || { buys: 0, sells: 0, interest: 0, appreciation: 0 };
                    const classValue = agg.buys - agg.sells + agg.interest + agg.appreciation;
                    value += classValue;
                    addClassValue(inv.assetClass, classValue);
                }
            }

            if (monthKey !== currentInflationMonth) {
                cumulativeInflation *= 1 + (inflationByMonth.get(monthKey) ?? 0);
                currentInflationMonth = monthKey;
            }

            const netWorthValue = netWorthInvestmentsByDay.get(dayKey);
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
                day: dayKey,
                date: new Date(day),
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
    }, [
        parsedTransactions,
        selectedPeriod,
        summaries,
        customHistoryData,
        convertToTarget,
        convertTransactionAmountToTarget,
        inflationByMonth,
        netWorthInvestmentsByDay,
    ]);

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

            let monthlyReturnPct: number | null;
            if (!prev) {
                monthlyReturnPct = null;
            } else {
                const baseValue = prev.value;
                const netContribution = monthlyNetFlows.get(curr.month)?.portfolio ?? 0;
                const modifiedDietzBase = baseValue + (netContribution / 2);
                const denominator = modifiedDietzBase > 0 ? modifiedDietzBase : baseValue;
                monthlyReturnPct = denominator > 0
                    ? ((curr.value - prev.value - netContribution) / denominator) * 100
                    : 0;
            }

            const roundedReturnPct = monthlyReturnPct === null
                ? null
                : Math.round(monthlyReturnPct * 100) / 100;
            data[year][monthIdx] = roundedReturnPct;
            if (roundedReturnPct !== null) {
                monthlyReturns.push(Math.abs(roundedReturnPct));
            }
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
    const chartData = useMemo(() => dailyFilteredSnapshots.map((s) => ({
        day: s.day,
        [CHART_KEYS.invested]: s.invested,
        [CHART_KEYS.inflationAdjusted]: s.inflationAdjustedValue,
        [CHART_KEYS.value]: s.value,
        [CHART_KEYS.stocksEtfs]: s.stocksEtfsValue,
        [CHART_KEYS.crypto]: s.cryptoValue,
        [CHART_KEYS.metals]: s.metalsValue,
    })), [dailyFilteredSnapshots]);

    const relativePerformanceData = useMemo(() => {
        if (dailyFilteredSnapshots.length === 0) return [];

        const buildRelativeSeries = (
            valueSelector: (snapshot: MonthlySnapshot) => number,
            flowSelector: (flow: RelativeFlowBucket) => number,
        ) => {
            const results: number[] = [];
            let index = 1;

            for (let i = 0; i < dailyFilteredSnapshots.length; i++) {
                if (i === 0) {
                    results.push(0);
                    continue;
                }

                const prev = dailyFilteredSnapshots[i - 1];
                const curr = dailyFilteredSnapshots[i];
                if (!prev || !curr) {
                    results.push(Math.round((index - 1) * 10000) / 100);
                    continue;
                }

                const prevValue = valueSelector(prev);
                const currValue = valueSelector(curr);
                const monthlyFlow = flowSelector(dailyNetFlows.get(curr.day) ?? {
                    portfolio: 0,
                    stocksEtfs: 0,
                    crypto: 0,
                    metals: 0,
                });

                const modifiedDietzBase = prevValue + (monthlyFlow / 2);
                const denominator = modifiedDietzBase > 0 ? modifiedDietzBase : prevValue;

                const rawReturn = denominator > 0
                    ? (currValue - prevValue - monthlyFlow) / denominator
                    : 0;

                const boundedReturn = Number.isFinite(rawReturn)
                    ? Math.max(rawReturn, -0.9999)
                    : 0;

                index *= 1 + boundedReturn;
                results.push(Math.round((index - 1) * 10000) / 100);
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

        return dailyFilteredSnapshots.map((snapshot, idx) => ({
            day: snapshot.day,
            [CHART_KEYS.relativePortfolio]: portfolioSeries[idx] ?? 0,
            [CHART_KEYS.relativeStocksEtfs]: stocksEtfsSeries[idx] ?? 0,
            [CHART_KEYS.relativeCrypto]: cryptoSeries[idx] ?? 0,
            [CHART_KEYS.relativeMetals]: metalsSeries[idx] ?? 0,
        }));
    }, [dailyFilteredSnapshots, dailyNetFlows]);

    const assetClassBreakdown = useMemo(() => {
        const grouped = new Map<AssetClass, { count: number; value: number; invested: number; gain: number }>();
        for (const summary of summaries) {
            const existing = grouped.get(summary.assetClass) || { count: 0, value: 0, invested: 0, gain: 0 };
            existing.count += 1;
            existing.value += convertToTarget(summary.currentValue, summary.currency);
            existing.invested += convertToTarget(summary.totalInvested, summary.currency);
            existing.gain += convertToTarget(summary.gainLoss, summary.currency);
            grouped.set(summary.assetClass, existing);
        }

        return Array.from(grouped.entries()).map(([assetClass, data]) => {
            const pct = data.invested > 0 ? (data.gain / data.invested) * 100 : 0;
            return {
                assetClass,
                label: t(`performance.${assetClass}` as `performance.${AssetClass}`) || assetClass,
                count: data.count,
                classValue: data.value,
                classInvested: data.invested,
                classGain: data.gain,
                classPct: pct,
            };
        });
    }, [summaries, convertToTarget, t]);

    const { topPerformers, bottomPerformers } = useMemo(() => {
        const sorted = [...summaries].sort((a, b) => a.gainLossPercent - b.gainLossPercent);
        return {
            topPerformers: sorted.slice(-5).reverse(),
            bottomPerformers: sorted.slice(0, 5),
        };
    }, [summaries]);

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
                                <XAxis
                                    dataKey="day"
                                    tick={{ fontSize: 12 }}
                                    className="fill-muted-foreground"
                                    interval="preserveStartEnd"
                                    minTickGap={20}
                                    tickFormatter={(value) => monthTickFormatter.format(parseISO(String(value)))}
                                />
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
                                    dataKey={CHART_KEYS.invested}
                                    name={t('portfolio.totalInvested')}
                                    stroke="hsl(var(--muted-foreground))"
                                    fill="url(#gradInvested)"
                                    strokeWidth={1.5}
                                    strokeDasharray="4 4"
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.inflationAdjusted}
                                    name={t('performance.inflationAdjusted')}
                                    stroke="hsl(30, 80%, 55%)"
                                    fill="url(#gradInflAdj)"
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.stocksEtfs}
                                    name={t('performance.relativeStocksEtfs') || t('nav.stocksEtfs')}
                                    stroke="hsl(0, 72%, 51%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.crypto}
                                    name={t('performance.crypto')}
                                    stroke="hsl(142, 76%, 36%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.metals}
                                    name={t('performance.metals')}
                                    stroke="hsl(45, 93%, 47%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.value}
                                    name={t('portfolio.portfolioValue')}
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
                                <XAxis
                                    dataKey="day"
                                    tick={{ fontSize: 12 }}
                                    className="fill-muted-foreground"
                                    interval="preserveStartEnd"
                                    minTickGap={20}
                                    tickFormatter={(value) => monthTickFormatter.format(parseISO(String(value)))}
                                />
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
                                    dataKey={CHART_KEYS.relativePortfolio}
                                    name={t('performance.relativePortfolio')}
                                    stroke="hsl(var(--primary))"
                                    fill="url(#gradRelPortfolio)"
                                    strokeWidth={2.5}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.relativeStocksEtfs}
                                    name={t('performance.relativeStocksEtfs')}
                                    stroke="hsl(0, 72%, 51%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.relativeCrypto}
                                    name={t('performance.crypto')}
                                    stroke="hsl(142, 76%, 36%)"
                                    fillOpacity={0}
                                    strokeWidth={2}
                                />
                                <Area
                                    type="monotone"
                                    dataKey={CHART_KEYS.relativeMetals}
                                    name={t('performance.metals')}
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
                {assetClassBreakdown.map(({ assetClass, label, count, classValue, classInvested, classGain, classPct }) => (
                    <Card key={assetClass} className="border shadow-sm">
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
                ))}
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
                            {topPerformers.map((inv) => (
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
                            {bottomPerformers.map((inv) => (
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
