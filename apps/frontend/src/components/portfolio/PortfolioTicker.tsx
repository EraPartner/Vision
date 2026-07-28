import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import { portfolioKeys } from "@/lib/queryKeys";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { InvestmentsListResponse } from "@/types/api";
import type { InvestmentSummary } from "@/types/portfolio";

interface PortfolioTickerProps {
  /** Holdings to surface — only those with a ticker symbol Yahoo can quote appear. */
  items: InvestmentSummary[];
}

interface TickerQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string;
}

// Pre-formatted display row — all string/colour work is done once when quotes
// change, so re-renders (e.g. the visibility toggle) never re-run Intl/format.
interface TickerEntry {
  key: string;
  symbol: string;
  name: string;
  up: boolean;
  priceLabel: string;
  pctLabel: string;
}

// Steady pixel speed regardless of how many holdings: scale the loop duration
// with the number of tiles, floored so a one-stock portfolio still drifts.
const SECONDS_PER_ITEM = 4.5;
const MIN_DURATION_S = 24;

// The Yahoo symbol to quote: prefer the explicit provider id (e.g. a holding
// stored as "Apple" but priced via "AAPL"), else the bare ticker.
function quoteSymbolFor(inv: InvestmentSummary): string {
  if (inv.price_provider === "yahoo" && inv.price_provider_id) {
    return inv.price_provider_id.toUpperCase();
  }
  return (inv.symbol ?? "").toUpperCase();
}

const isIncluded = (inv: InvestmentSummary): boolean => inv.show_in_ticker !== false;

/**
 * Wall-Street-style scrolling ticker tape for the portfolio's owned stocks.
 * Pulls live day-change quotes (price, absolute + percent change) from the same
 * batch Yahoo endpoint the research Market Overview uses, then marquees them.
 * Each holding can be hidden via the manage popover (persisted on the investment);
 * hidden holdings aren't even quoted. Pauses on hover/off-screen; honours
 * prefers-reduced-motion (see .ticker-track in index.css).
 */
export function PortfolioTicker({ items }: PortfolioTickerProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();
  const isOnline = useOnlineStatus();

  // "Active" only while the tape is on-screen AND the tab is visible. We use it
  // to freeze the marquee (no idle compositor work) and stop the 60s poll when
  // nobody's looking — both resume seamlessly when it scrolls back into view.
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(true);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let inView = true;
    const sync = () => setActive(inView && !document.hidden);
    const io = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        sync();
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  // The manageable universe: every market-priced holding (those with a ticker).
  const quotable = useMemo(
    () => items.filter((inv) => quoteSymbolFor(inv).length > 0),
    [items],
  );
  // Only holdings the user hasn't hidden are quoted + shown.
  const included = useMemo(() => quotable.filter(isIncluded), [quotable]);

  const symbolList = useMemo(
    () => Array.from(new Set(included.map(quoteSymbolFor))).sort(),
    [included],
  );
  const symbols = symbolList.join(",");

  // Same cadence/guards as the home benchmark strip and Market Overview: 60s
  // poll, online-gated, price-only (detail=basic skips fundamentals).
  const { data } = useQuery({
    queryKey: ["portfolio-ticker", symbols],
    queryFn: () => apiClient.getMarketQuotes<TickerQuote>(symbols, { detail: "basic" }),
    enabled: isOnline && symbolList.length > 0,
    staleTime: 60_000,
    // Poll only while visible; a stale tape refreshes the moment it reappears.
    refetchInterval: active && isOnline ? 60_000 : false,
    refetchOnWindowFocus: false,
    retry: isOnline ? 1 : false,
  });

  const entries = useMemo<TickerEntry[]>(() => {
    const bySymbol = new Map<string, TickerQuote>();
    for (const q of data ?? []) {
      if (q.symbol) bySymbol.set(q.symbol.toUpperCase(), q);
    }
    if (bySymbol.size === 0) return [];

    const out: TickerEntry[] = [];
    for (const inv of included) {
      const qs = quoteSymbolFor(inv);
      // Fall back to the bare ticker, or a crypto pair's base (BTC-USD → BTC),
      // mirroring how Market Overview reconciles held vs. quoted symbols.
      const quote =
        bySymbol.get(qs) ??
        bySymbol.get((inv.symbol ?? "").toUpperCase()) ??
        (qs.endsWith("-USD") ? bySymbol.get(qs.slice(0, -4)) : undefined);
      if (!quote || quote.price == null) continue;
      const changePercent = quote.changePercent ?? 0;
      const up = changePercent >= 0;
      out.push({
        key: `${inv.id}`,
        symbol: inv.symbol || quote.symbol,
        name: inv.name,
        up,
        priceLabel: fmt(quote.price, quote.currency || "USD"),
        pctLabel: `${up ? "+" : ""}${changePercent.toFixed(2)}%`,
      });
    }
    return out;
  }, [data, included, fmt]);

  // Build the duplicated tile track once per quote change. Decoupling it from
  // the `active` state means scrolling the tape in/out of view only flips a data
  // attribute — it never re-renders the (potentially dozens of) tiles.
  const track = useMemo(() => {
    if (entries.length === 0) return undefined;
    const durationS = Math.max(MIN_DURATION_S, entries.length * SECONDS_PER_ITEM);
    const tiles = entries.map((e) => (
      <div
        key={e.key}
        className="flex items-center gap-2 whitespace-nowrap border-r border-border/40 px-5 py-2.5"
        title={e.name}
      >
        <span className="font-mono text-sm font-bold tracking-tight">{e.symbol}</span>
        <span className="text-sm tabular-nums text-muted-foreground">{e.priceLabel}</span>
        <span
          className={cn(
            "flex items-center gap-0.5 text-sm font-semibold tabular-nums",
            e.up ? "text-gain" : "text-loss",
          )}
        >
          {e.up ? (
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {e.pctLabel}
        </span>
      </div>
    ));
    return (
      <div
        className="ticker-track flex w-max items-stretch"
        style={{ "--ticker-duration": `${durationS}s` } as React.CSSProperties}
      >
        <div className="flex shrink-0 items-stretch">{tiles}</div>
        <div className="flex shrink-0 items-stretch" aria-hidden="true">
          {tiles}
        </div>
      </div>
    );
  }, [entries]);

  // No holdings can ever appear in the tape → render nothing at all.
  if (quotable.length === 0) return null;

  // Tape is empty for a reason worth surfacing: everything hidden (actionable via
  // the manage menu) or offline. Otherwise (transient load) keep the bar quiet.
  const placeholder = track
    ? undefined
    : included.length === 0
      ? t("portfolio.ticker.allHidden")
      : !isOnline
        ? t("portfolio.ticker.offline")
        : undefined;

  return (
    <div className="relative flex w-full items-stretch overflow-hidden rounded-xl border border-border/60 liquid-glass">
      <div
        ref={containerRef}
        data-active={active}
        className="ticker-mask relative flex min-h-[2.625rem] min-w-0 flex-1 items-center overflow-hidden"
        role="region"
        aria-label={t("portfolio.ticker.aria")}
      >
        {track ?? (
          <span className="px-5 text-sm text-muted-foreground">{placeholder}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center border-l border-border/40 px-1">
        <TickerManager holdings={quotable} />
      </div>
    </div>
  );
}

/** Popover on the tape's right edge: per-holding switches to opt in/out of the ticker. */
function TickerManager({ holdings }: { holdings: InvestmentSummary[] }) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const toggle = useMutation({
    mutationFn: ({ id, show }: { id: number; show: boolean }) =>
      apiClient.updateInvestment(id, { show_in_ticker: show }),
    // Optimistic: flip the cached investment so the switch and tape react
    // instantly; reconcile (or roll back) once the server responds.
    onMutate: async ({ id, show }) => {
      await queryClient.cancelQueries({ queryKey: portfolioKeys.investments });
      const prev = queryClient.getQueryData<InvestmentsListResponse>(portfolioKeys.investments);
      if (prev) {
        queryClient.setQueryData<InvestmentsListResponse>(portfolioKeys.investments, {
          ...prev,
          items: prev.items.map((it) => (it.id === id ? { ...it, show_in_ticker: show } : it)),
        });
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(portfolioKeys.investments, ctx.prev);
      toast.error(t("portfolio.updateInvestmentFailedTitle"), {
        description: apiErrorToMessage(err, t),
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: portfolioKeys.investments });
      queryClient.invalidateQueries({ queryKey: portfolioKeys.summaryAll });
    },
  });

  const shownCount = holdings.filter(isIncluded).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          aria-label={t("portfolio.ticker.manage")}
          title={t("portfolio.ticker.manage")}
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-border/60 px-3 py-2.5">
          <p className="text-sm font-medium">{t("portfolio.ticker.manageTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t("portfolio.ticker.manageCount", {
              shown: String(shownCount),
              total: String(holdings.length),
            })}
          </p>
        </div>
        {/* Plain scroll container: overscroll-contain keeps the wheel from
            chaining to the page once the list hits its top/bottom. */}
        <div className="max-h-72 overflow-y-auto overscroll-contain p-1.5">
          {holdings.map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
            >
              <span className="flex min-w-0 items-center gap-2">
                {h.symbol && (
                  <span className="font-mono text-xs font-bold">{h.symbol}</span>
                )}
                <span className="truncate text-sm text-muted-foreground">{h.name}</span>
              </span>
              <Switch
                checked={isIncluded(h)}
                onCheckedChange={(checked) => toggle.mutate({ id: h.id, show: checked })}
                aria-label={h.name}
              />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
