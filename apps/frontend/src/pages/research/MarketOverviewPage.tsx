import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { PAGE_ICONS } from "@/lib/pageIcons";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Star } from "lucide-react";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useMarketQuotesQuery } from "@/hooks/useMarketQuotesQuery";
import { useInvestmentsQuery } from "@/hooks/portfolio/useInvestments";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import {
    REGION_OPTIONS,
    REGION_VIEWS,
    SECTOR_OPTIONS,
    SECTOR_VIEWS,
    type Region,
    type SymbolEntry,
    type ViewGroup,
} from "./marketViews";
import { marketChangeHeatStyle } from "./marketHeat";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageShell } from "@/components/shared/PageShell";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";

interface OverviewQuote {
    symbol: string;
    changePercent: number;
}

export default function MarketOverviewPage() {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const { data: investmentsData } = useInvestmentsQuery();
    const [region, setRegion] = useState<Region>("worldwide");
    const [sector, setSector] = useState<string>("overview");

    // Symbols the user actually holds, so their tiles get an accent frame + star.
    // Match the investment's symbol and (for Yahoo-priced holdings) its provider
    // id, both upper-cased. Crypto tiles use Yahoo pairs (e.g. BTC-USD) while a
    // holding usually stores the bare base ticker, so we also fold off "-USD".
    const heldSymbols = useMemo(() => {
        const set = new Set<string>();
        for (const inv of investmentsData?.items ?? []) {
            if (inv.symbol) set.add(inv.symbol.toUpperCase());
            if (inv.price_provider === "yahoo" && inv.price_provider_id) {
                set.add(inv.price_provider_id.toUpperCase());
            }
        }
        return set;
    }, [investmentsData]);

    const isHeld = (symbol: string): boolean => {
        const s = symbol.toUpperCase();
        return (
            heldSymbols.has(s) ||
            (s.endsWith("-USD") && heldSymbols.has(s.slice(0, -4)))
        );
    };

    // Region is the global axis. With "Overview" selected we show that region's
    // Indices + Top stocks; with a sector selected we show its basket filtered to
    // the region (Worldwide keeps every member; a region keeps only its tagged
    // members). Filtering is by tag, not a second fetch, so the basket stays one
    // curated config.
    const groups = useMemo<ReadonlyArray<ViewGroup>>(() => {
        if (sector === "overview") {
            const rv =
                REGION_VIEWS.find((v) => v.key === region) ?? REGION_VIEWS[0];
            return rv.groups;
        }
        const sv =
            SECTOR_VIEWS.find((v) => v.key === sector) ?? SECTOR_VIEWS[0];
        const all = sv.groups[0]?.entries ?? [];
        const entries =
            region === "worldwide"
                ? all
                : all.filter((e) => e.region === region);
        return [{ entries }];
    }, [region, sector]);

    // One batch quote per active selection. Same cadence/guards as the home
    // benchmark strip: 60s poll, online-gated, price-only (we only read
    // changePercent).
    const symbols = useMemo(
        () =>
            Array.from(
                new Set(
                    groups.flatMap((grp) => grp.entries.map((e) => e.symbol)),
                ),
            ).join(","),
        [groups],
    );

    const { data } = useMarketQuotesQuery<OverviewQuote>(
        ["market-overview", region, sector],
        symbols,
        { staleTime: QUERY_STALE_TIME_MS.STANDARD },
    );

    const pctMap = useMemo(
        () => new Map((data ?? []).map((q) => [q.symbol, q.changePercent])),
        [data],
    );

    const showHeadings = groups.length > 1;

    const renderGrid = (entries: ReadonlyArray<SymbolEntry>) => (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {entries.map((entry) => {
                const pct = pctMap.get(entry.symbol);
                const up = (pct ?? 0) >= 0;
                const held = isHeld(entry.symbol);
                return (
                    <Link
                        key={entry.symbol}
                        to={`/research/market?symbol=${encodeURIComponent(entry.symbol)}`}
                        style={marketChangeHeatStyle(pct)}
                        aria-label={
                            held
                                ? `${entry.label}, ${t("research.markets.held")}`
                                : entry.label
                        }
                        className={cn(
                            "relative flex flex-col gap-1 rounded-card corner-continuous border border-border/40 p-3.5 text-left",
                            // Transition list composed via --press-compose (press-feedback owns
                            // the `transition` shorthand — see index.css); the transform entry is
                            // the press curve AND micro-lift's hover ride, both at 90ms as before.
                            "micro-lift press-feedback [--press-compose:color_var(--default-transition-duration)_var(--default-transition-timing-function),background-color_var(--default-transition-duration)_var(--default-transition-timing-function),border-color_var(--default-transition-duration)_var(--default-transition-timing-function),transform_var(--duration-press)_ease-out] hover:border-primary/40 focus-ring",
                            pct == null && "bg-foreground/[0.03]",
                            held &&
                                "border-accent/70 shadow-[0_0_14px_-2px_hsl(var(--accent)/0.55)]",
                        )}
                    >
                        {held && (
                            <Star
                                aria-hidden
                                className="absolute right-2 top-2 h-3.5 w-3.5 fill-accent text-accent"
                            />
                        )}
                        <span
                            className={cn(
                                "truncate type-caption text-foreground/70",
                                held && "pr-4",
                            )}
                        >
                            {entry.label}
                        </span>
                        {pct != null ? (
                            <span className="type-title-1 tabular-nums text-foreground">
                                {up ? "+" : "−"}
                                {formatPercent(Math.abs(pct), { digits: 2 })}
                            </span>
                        ) : (
                            <span className="type-title-1 tabular-nums text-label-tertiary">
                                —
                            </span>
                        )}
                        <span className="truncate font-mono type-caption text-foreground/50">
                            {entry.symbol}
                        </span>
                    </Link>
                );
            })}
        </div>
    );

    return (
        <PageShell className="">
            <PageHeader
                title={t("research.markets.title")}
                subtitle={t("research.markets.subtitle")}
                icon={PAGE_ICONS["/research/markets"]}
            />

            <div className="flex flex-wrap items-center gap-3">
                <SegmentedControl
                    size="sm"
                    value={region}
                    onValueChange={(v) => setRegion(v as Region)}
                    aria-label={t("research.markets.regions")}
                    className="max-w-full overflow-x-auto"
                >
                    {REGION_OPTIONS.map((o) => (
                        <SegmentedControlItem
                            key={o.key}
                            value={o.key}
                            className="px-2.5 type-footnote"
                        >
                            {t(o.labelKey)}
                        </SegmentedControlItem>
                    ))}
                </SegmentedControl>
                <Select value={sector} onValueChange={setSector}>
                    <SelectTrigger
                        className="h-8 w-48"
                        aria-label={t("research.markets.sectors")}
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {SECTOR_OPTIONS.map((o) => (
                            <SelectItem key={o.key} value={o.key}>
                                {t(o.labelKey)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {groups.map((group, i) => (
                <section key={group.titleKey ?? i} className="space-y-3">
                    {showHeadings && group.titleKey && (
                        <h2 className="type-headline text-label-secondary">
                            {t(group.titleKey)}
                        </h2>
                    )}
                    {group.entries.length > 0 ? (
                        renderGrid(group.entries)
                    ) : (
                        <Card>
                            <CardContent variant="state">
                                <EmptyState
                                    size="compact"
                                    icon={PAGE_ICONS["/research/markets"]}
                                    title={t("research.markets.empty")}
                                />
                            </CardContent>
                        </Card>
                    )}
                </section>
            ))}
        </PageShell>
    );
}
