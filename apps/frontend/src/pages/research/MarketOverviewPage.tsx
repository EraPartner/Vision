import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router";
import { Globe, Star } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useLanguage } from "@/contexts/LanguageContext";
import { useMarketQuotesQuery } from "@/hooks/useMarketQuotesQuery";
import { useInvestmentsQuery } from "@/hooks/portfolio/useInvestments";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { formatPercent } from "@/utils/currency";
import {
  REGION_OPTIONS,
  REGION_VIEWS,
  SECTOR_OPTIONS,
  SECTOR_VIEWS,
  type Region,
  type SymbolEntry,
  type ViewGroup,
} from "./marketViews";

interface OverviewQuote {
  symbol: string;
  changePercent: number;
}

// ±3% saturates the tint; the percentage text always stays foreground for
// guaranteed contrast in both themes — the gradient carries the red/green
// signal, the sign carries it for color-blind readers.
const SATURATION_CAP = 3;

function heatStyle(pct: number | undefined): CSSProperties {
  if (pct == null) return {};
  const intensity = Math.min(Math.abs(pct) / SATURATION_CAP, 1);
  const alpha = 0.14 + intensity * 0.52;
  const [r, g, b] = pct >= 0 ? [34, 197, 94] : [239, 68, 68];
  return {
    backgroundImage: `linear-gradient(135deg, rgba(${r},${g},${b},${alpha}) 0%, rgba(${r},${g},${b},${alpha * 0.45}) 100%)`,
  };
}

export default function MarketOverviewPage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { data: investmentsData } = useInvestmentsQuery();
  const [region, setRegion] = useState<Region>("worldwide");
  const [sector, setSector] = useState<string>("overview");

  // Symbols the user actually holds, so their tiles get an accent ring + star.
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
    return heldSymbols.has(s) || (s.endsWith("-USD") && heldSymbols.has(s.slice(0, -4)));
  };

  // Region is the global axis. With "Overview" selected we show that region's
  // Indices + Top stocks; with a sector selected we show its basket filtered to
  // the region (Worldwide keeps every member; a region keeps only its tagged
  // members). Filtering is by tag, not a second fetch, so the basket stays one
  // curated config.
  const groups = useMemo<ReadonlyArray<ViewGroup>>(() => {
    if (sector === "overview") {
      const rv = REGION_VIEWS.find((v) => v.key === region) ?? REGION_VIEWS[0];
      return rv.groups;
    }
    const sv = SECTOR_VIEWS.find((v) => v.key === sector) ?? SECTOR_VIEWS[0];
    const all = sv.groups[0]?.entries ?? [];
    const entries = region === "worldwide" ? all : all.filter((e) => e.region === region);
    return [{ entries }];
  }, [region, sector]);

  // One batch quote per active selection. Same cadence/guards as the home
  // benchmark strip: 60s poll, online-gated, price-only (we only read
  // changePercent).
  const symbols = useMemo(
    () => Array.from(new Set(groups.flatMap((grp) => grp.entries.map((e) => e.symbol)))).join(","),
    [groups],
  );

  const { data } = useMarketQuotesQuery<OverviewQuote>(["market-overview", region, sector], symbols, { staleTime: 60_000 });

  const pctMap = useMemo(
    () => new Map((data ?? []).map((q) => [q.symbol, q.changePercent])),
    [data],
  );

  const goToSymbol = (symbol: string) => {
    navigate(`/research/market?symbol=${encodeURIComponent(symbol)}`);
  };

  const showHeadings = groups.length > 1;

  const renderGrid = (entries: ReadonlyArray<SymbolEntry>) => (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {entries.map((entry) => {
        const pct = pctMap.get(entry.symbol);
        const up = (pct ?? 0) >= 0;
        const held = isHeld(entry.symbol);
        return (
          <button
            key={entry.symbol}
            onClick={() => goToSymbol(entry.symbol)}
            style={heatStyle(pct)}
            title={held ? t("research.markets.held") : undefined}
            className={cn(
              "relative flex flex-col gap-1 rounded-xl border border-border/40 p-3.5 text-left",
              // Transition list composed via --press-compose (press-feedback owns
              // the `transition` shorthand — see index.css); the transform entry is
              // the press curve AND micro-lift's hover ride, both at 90ms as before.
              "micro-lift press-feedback [--press-compose:color_var(--default-transition-duration)_var(--default-transition-timing-function),background-color_var(--default-transition-duration)_var(--default-transition-timing-function),border-color_var(--default-transition-duration)_var(--default-transition-timing-function),transform_90ms_ease-out] hover:border-primary/40 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              pct == null && "bg-muted/20",
              held &&
                "border-accent/60 ring-2 ring-accent ring-offset-1 ring-offset-background shadow-[0_0_14px_-2px_hsl(var(--accent)/0.55)]",
            )}
          >
            {held && (
              <Star
                aria-hidden
                className="absolute right-2 top-2 h-3.5 w-3.5 fill-accent text-accent drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
              />
            )}
            <span className={cn("truncate text-xs font-medium text-foreground/70", held && "pr-4")}>
              {entry.label}
            </span>
            {pct != null ? (
              <span className="text-2xl font-bold tabular-nums text-foreground sm:text-3xl">
                {up ? "+" : "−"}{formatPercent(Math.abs(pct), { digits: 2 })}
              </span>
            ) : (
              <span className="text-2xl font-bold tabular-nums text-muted-foreground/40 sm:text-3xl">—</span>
            )}
            <span className="truncate font-mono text-[10px] text-foreground/50">{entry.symbol}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t("research.markets.title")} subtitle={t("research.markets.subtitle")} icon={Globe} />

      <div className="space-y-3">
        <ToggleCluster
          label={t("research.markets.regions")}
          options={REGION_OPTIONS}
          value={region}
          onChange={(v) => setRegion(v as Region)}
          t={t}
        />
        <ToggleCluster
          label={t("research.markets.sectors")}
          options={SECTOR_OPTIONS}
          value={sector}
          onChange={setSector}
          t={t}
        />
      </div>

      {groups.map((group, i) => (
        <section key={group.titleKey ?? i} className="space-y-3">
          {showHeadings && group.titleKey && (
            <h2 className="text-sm font-semibold text-muted-foreground">{t(group.titleKey)}</h2>
          )}
          {group.entries.length > 0 ? (
            renderGrid(group.entries)
          ) : (
            <p className="rounded-xl border border-dashed border-border/40 px-4 py-8 text-center text-sm text-muted-foreground">
              {t("research.markets.empty")}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

interface ToggleClusterProps {
  label: string;
  options: ReadonlyArray<{ key: string; labelKey: string }>;
  value: string;
  onChange: (key: string) => void;
  t: (key: string) => string;
}

function ToggleCluster({ label, options, value, onChange, t }: ToggleClusterProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => v && onChange(v)}
        variant="outline"
        className="flex-wrap justify-start"
      >
        {options.map((o) => (
          <ToggleGroupItem key={o.key} value={o.key} className="px-3">
            {t(o.labelKey)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
