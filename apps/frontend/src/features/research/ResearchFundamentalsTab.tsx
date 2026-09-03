import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { formatCompactNumber } from "@/utils/formatCompactNumber";
import { apiClient } from "@/lib/api";
import { ProvenanceBadge } from "@/features/research/ProvenanceBadge";
import { ResearchUnavailableNote } from "@/features/research/ResearchUnavailableNote";
import { ScorecardPanel } from "@/features/research/ResearchScorecard";
import type { ResearchFundamentals } from "@/types/research";

interface ResearchFundamentalsTabProps {
    symbol: string;
    enabled: boolean;
}

type MetricFormat = "ratio" | "pct" | "largeNum" | "price";

interface MetricDescriptor {
    key: keyof ResearchFundamentals;
    labelKey: string;
    format: MetricFormat;
}

/** Metrics grouped by analytical theme; groups with no data are hidden. */
const METRIC_GROUPS: { titleKey: string; metrics: MetricDescriptor[] }[] = [
    {
        titleKey: "research.fundamentals.groupValuation",
        metrics: [
            { key: "pe", labelKey: "market.pe", format: "ratio" },
            { key: "forwardPE", labelKey: "market.forwardPE", format: "ratio" },
            {
                key: "pegRatio",
                labelKey: "research.metric.pegRatio",
                format: "ratio",
            },
            {
                key: "priceToBook",
                labelKey: "market.priceBook",
                format: "ratio",
            },
        ],
    },
    {
        titleKey: "research.fundamentals.groupProfitability",
        metrics: [
            {
                key: "profitMargin",
                labelKey: "research.fundamentals.profitMargin",
                format: "pct",
            },
            {
                key: "grossMargin",
                labelKey: "research.metric.grossMargin",
                format: "pct",
            },
            {
                key: "operatingMargin",
                labelKey: "research.metric.operatingMargin",
                format: "pct",
            },
            {
                key: "returnOnEquity",
                labelKey: "research.fundamentals.roe",
                format: "pct",
            },
        ],
    },
    {
        titleKey: "research.fundamentals.groupLeverage",
        metrics: [
            {
                key: "debtToEquity",
                labelKey: "research.metric.debtToEquity",
                format: "ratio",
            },
            {
                key: "currentRatio",
                labelKey: "research.metric.currentRatio",
                format: "ratio",
            },
            {
                key: "quickRatio",
                labelKey: "research.metric.quickRatio",
                format: "ratio",
            },
            {
                key: "interestCoverage",
                labelKey: "research.metric.interestCoverage",
                format: "ratio",
            },
        ],
    },
    {
        titleKey: "research.fundamentals.groupCashGrowth",
        metrics: [
            {
                key: "freeCashFlow",
                labelKey: "research.metric.freeCashFlow",
                format: "largeNum",
            },
            {
                key: "fcfYield",
                labelKey: "research.metric.fcfYield",
                format: "pct",
            },
            {
                key: "revenueGrowth",
                labelKey: "research.metric.revenueGrowth",
                format: "pct",
            },
            {
                key: "earningsGrowth",
                labelKey: "research.metric.earningsGrowth",
                format: "pct",
            },
        ],
    },
    {
        titleKey: "research.fundamentals.groupDividendSize",
        metrics: [
            {
                key: "dividendYield",
                labelKey: "market.divYield",
                format: "pct",
            },
            {
                key: "payoutRatio",
                labelKey: "research.metric.payoutRatio",
                format: "pct",
            },
            {
                key: "marketCap",
                labelKey: "market.marketCap",
                format: "largeNum",
            },
            {
                key: "revenue",
                labelKey: "research.fundamentals.revenue",
                format: "largeNum",
            },
            { key: "eps", labelKey: "market.eps", format: "price" },
            { key: "beta", labelKey: "market.beta", format: "ratio" },
        ],
    },
];

export function ResearchFundamentalsTab({
    symbol,
    enabled,
}: ResearchFundamentalsTabProps) {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const fmtCurrency = useCurrencyFormatter();

    const { data: result, isFetching } = useQuery({
        queryKey: ["research-scorecard", symbol],
        queryFn: () => apiClient.getResearchScorecard(symbol),
        enabled: enabled && !!symbol,
        staleTime: 24 * 60 * 60 * 1000,
    });

    const f = result?.data?.fundamentals;
    const currency = f?.currency || "USD";

    const fmtPct = useCallback(
        (val: number | null | undefined) =>
            val == null || isNaN(val)
                ? "—"
                : formatPercent(val * 100, { digits: 2 }),
        [formatPercent],
    );
    const fmtRatio = useCallback(
        (val: number | null | undefined) =>
            val == null || isNaN(val) ? "—" : val.toFixed(2),
        [],
    );
    const fmtPrice = useCallback(
        (val: number | null | undefined) =>
            // Shared cached currency formatter; fundamentals pin 2 decimals (unchanged).
            val == null || isNaN(val) ? "—" : fmtCurrency(val, currency, 2),
        [fmtCurrency, currency],
    );

    const fmt = (format: MetricFormat, val: number | null | undefined) => {
        if (format === "pct") return fmtPct(val);
        if (format === "largeNum") return formatCompactNumber(val);
        if (format === "price") return fmtPrice(val);
        return fmtRatio(val);
    };

    if (isFetching && !result) {
        return (
            <div {...loadingSurfaceProps} className="grid gap-2 sm:grid-cols-2">
                {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                ))}
            </div>
        );
    }

    if (result?.meta.source === "unavailable" || !result?.data) {
        return (
            <ResearchUnavailableNote provider={result?.meta.provider ?? null} />
        );
    }

    if (!f) {
        return (
            <p className="py-4 text-center text-sm text-muted-foreground">
                {t("research.fundamentals.none")}
            </p>
        );
    }

    const scorecard = result.data.scorecard;

    return (
        <div className="space-y-5">
            <div className="flex items-center justify-between gap-2">
                {f.sector ? (
                    <span className="text-xs text-muted-foreground">
                        {f.sector}
                    </span>
                ) : (
                    <span />
                )}
                <ProvenanceBadge meta={result.meta} />
            </div>

            {/* Heuristic scorecard */}
            <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
                <h3 className="mb-3 text-sm font-semibold">
                    {t("research.scorecard.title")}
                </h3>
                <ScorecardPanel scorecard={scorecard} />
            </div>

            {/* Grouped metrics */}
            {METRIC_GROUPS.map((group) => {
                const visible = group.metrics.filter((m) => {
                    const v = f[m.key];
                    return v != null && !(typeof v === "number" && isNaN(v));
                });
                if (visible.length === 0) return null;
                return (
                    <div key={group.titleKey} className="space-y-1">
                        <h4 className="eyebrow">{t(group.titleKey)}</h4>
                        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                            {visible.map((m) => (
                                <div
                                    key={String(m.key)}
                                    className="flex items-center justify-between border-b border-border/50 py-1.5"
                                >
                                    <span className="text-sm text-muted-foreground">
                                        {t(m.labelKey)}
                                    </span>
                                    <span className="text-sm font-medium tabular-nums text-foreground">
                                        {fmt(
                                            m.format,
                                            f[m.key] as
                                                number | null | undefined,
                                        )}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
