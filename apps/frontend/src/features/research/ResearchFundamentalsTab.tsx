import { useCallback } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { List, ListRow } from "@/components/ui/list";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    useCurrencyFormatter,
    useCurrencyFormatSettings,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { ProvenanceBadge } from "@/features/research/ProvenanceBadge";
import { ResearchUnavailableNote } from "@/features/research/ResearchUnavailableNote";
import { ScorecardPanel } from "@/features/research/ResearchScorecard";
import type { ResearchFundamentals } from "@/types/research";
import { useResearchScorecardQuery } from "./useResearchQueries";

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
    const { locale, decimals } = useCurrencyFormatSettings();

    const { data: result, isFetching } = useResearchScorecardQuery(
        symbol,
        enabled,
    );

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
            val == null || isNaN(val)
                ? "—"
                : val.toLocaleString(locale, {
                      maximumFractionDigits: decimals,
                  }),
        [locale, decimals],
    );
    const fmtPrice = useCallback(
        (val: number | null | undefined) =>
            // Shared cached currency formatter; fundamentals pin 2 decimals (unchanged).
            val == null || isNaN(val)
                ? "—"
                : fmtCurrency(val, { currency, decimals: 2 }),
        [fmtCurrency, currency],
    );

    const fmt = (format: MetricFormat, val: number | null | undefined) => {
        if (format === "pct") return fmtPct(val);
        if (format === "largeNum")
            return val == null || isNaN(val)
                ? "—"
                : new Intl.NumberFormat(locale, {
                      notation: "compact",
                      maximumFractionDigits: decimals,
                  }).format(val);
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
            <p className="py-4 text-center type-callout text-label-secondary">
                {t("research.fundamentals.none")}
            </p>
        );
    }

    const scorecard = result.data.scorecard;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-2">
                {f.sector ? (
                    <span className="type-footnote text-label-secondary">
                        {f.sector}
                    </span>
                ) : (
                    <span />
                )}
                <ProvenanceBadge meta={result.meta} />
            </div>

            {/* Heuristic scorecard */}
            <section className="space-y-3">
                <h3 className="type-headline text-foreground">
                    {t("research.scorecard.title")}
                </h3>
                <ScorecardPanel scorecard={scorecard} currency={currency} />
            </section>

            {/* Grouped metrics */}
            <div className="grid gap-6 lg:grid-cols-2">
                {METRIC_GROUPS.map((group) => {
                    const visible = group.metrics.filter((m) => {
                        const v = f[m.key];
                        return (
                            v != null && !(typeof v === "number" && isNaN(v))
                        );
                    });
                    if (visible.length === 0) return null;
                    return (
                        <section key={group.titleKey} className="space-y-2">
                            <h3 className="type-headline text-foreground">
                                {t(group.titleKey)}
                            </h3>
                            <List>
                                {visible.map((m) => (
                                    <ListRow
                                        key={String(m.key)}
                                        className="min-h-10"
                                        title={
                                            <span className="text-label-secondary">
                                                {t(m.labelKey)}
                                            </span>
                                        }
                                        trailing={
                                            <span className="text-foreground">
                                                {fmt(
                                                    m.format,
                                                    f[m.key] as
                                                        | number
                                                        | null
                                                        | undefined,
                                                )}
                                            </span>
                                        }
                                    />
                                ))}
                            </List>
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
