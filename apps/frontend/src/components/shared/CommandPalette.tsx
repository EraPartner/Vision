import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
    CommandShortcut,
} from "@/components/ui/command";
import {
    ArrowLeftRight,
    BarChart3,
    Briefcase,
    Building2,
    CalendarClock,
    Coins,
    Gem,
    Globe,
    HandCoins,
    Import,
    Landmark,
    LayoutDashboard,
    LineChart,
    Moon,
    PiggyBank,
    Receipt,
    Settings,
    Sparkles,
    Sun,
    Tags,
    Target,
    Telescope,
    GitCompareArrows,
    CandlestickChart,
    TrendingUp,
    Users,
    Wallet,
    type LucideIcon,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { useDebounce, SEARCH_DEBOUNCE_MS } from "@/hooks/useDebounce";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { GO_TO_ROUTES } from "@/hooks/useGoToShortcuts";
import { Keyboard, Calculator } from "lucide-react";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { numberFormatToLocale } from "@/utils/currency";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface PaletteEntry {
    titleKey: string;
    url: string;
    icon: LucideIcon;
}

interface PaletteQuote {
    symbol: string;
    name: string;
    price: number;
    change: number;
    changePercent: number;
    currency: string;
}

const BUDGETING_PAGES: PaletteEntry[] = [
    { titleKey: "nav.dashboard", url: "/", icon: LayoutDashboard },
    { titleKey: "nav.transactions", url: "/transactions", icon: Receipt },
    { titleKey: "nav.categories", url: "/categories", icon: Tags },
    { titleKey: "nav.recipients", url: "/recipients", icon: Users },
    { titleKey: "nav.statistics", url: "/statistics", icon: BarChart3 },
    { titleKey: "nav.plannedPayments", url: "/planned", icon: CalendarClock },
    { titleKey: "nav.whoOwesYou", url: "/owes", icon: HandCoins },
    { titleKey: "nav.taxOverview", url: "/tax", icon: Landmark },
    { titleKey: "nav.importExport", url: "/import", icon: Import },
    { titleKey: "nav.aiChat", url: "/ai-chat", icon: Sparkles },
];

const PORTFOLIO_PAGES: PaletteEntry[] = [
    { titleKey: "nav.dashboard", url: "/portfolio", icon: Briefcase },
    { titleKey: "nav.netWorth", url: "/portfolio/net-worth", icon: Wallet },
    { titleKey: "nav.performance", url: "/portfolio/performance", icon: BarChart3 },
    { titleKey: "nav.stocksEtfs", url: "/portfolio/stocks", icon: TrendingUp },
    { titleKey: "nav.crypto", url: "/portfolio/crypto", icon: Coins },
    { titleKey: "nav.metals", url: "/portfolio/metals", icon: Gem },
    { titleKey: "nav.realEstate", url: "/portfolio/real-estate", icon: Building2 },
    { titleKey: "nav.savingsBonds", url: "/portfolio/savings", icon: PiggyBank },
    { titleKey: "nav.taxOverview", url: "/portfolio/tax", icon: Landmark },
];

const RESEARCH_PAGES: PaletteEntry[] = [
    { titleKey: "nav.researchHome", url: "/research", icon: Telescope },
    { titleKey: "nav.markets", url: "/research/markets", icon: Globe },
    { titleKey: "nav.marketLookup", url: "/research/market", icon: LineChart },
    { titleKey: "nav.compare", url: "/research/compare", icon: GitCompareArrows },
    { titleKey: "nav.chartBuilder", url: "/research/charts", icon: CandlestickChart },
    { titleKey: "nav.forecast", url: "/research/forecast", icon: TrendingUp },
    { titleKey: "nav.watchlist", url: "/research/watchlist", icon: Target },
];

// url → go-to key, so palette entries display their keyboard sequence.
const GO_TO_BY_URL = new Map(GO_TO_ROUTES.map((r) => [r.url, r.key]));

function GoToHint({ url }: { url: string }) {
    const key = GO_TO_BY_URL.get(url);
    if (!key) return null;
    return <CommandShortcut>G {key.toUpperCase()}</CommandShortcut>;
}

// Spotlight-style inline answers ------------------------------------------

const FX_QUERY = /^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]{3})(?:\s+(?:in|to|naar)\s+([a-zA-Z]{3}))?$/;
// Arithmetic only: digits, operators, parens, separators. No identifiers can
// pass this charset, so evaluation is safe.
const CALC_QUERY = /^[\d\s+\-*/().,]+$/;

function parseFxQuery(q: string): { amount: number; from: string; to?: string } | null {
    const m = q.match(FX_QUERY);
    if (!m) return null;
    const amount = Number(m[1].replace(",", "."));
    if (!Number.isFinite(amount)) return null;
    return { amount, from: m[2].toUpperCase(), to: m[3]?.toUpperCase() };
}

function evaluateArithmetic(q: string): number | null {
    if (!CALC_QUERY.test(q)) return null;
    if (!/[+\-*/]/.test(q) || !/\d/.test(q)) return null;
    if (/^\s*[\d.,]+\s*$/.test(q)) return null;
    try {
        const result = new Function(`"use strict"; return (${q.replace(/,/g, ".")});`)() as unknown;
        return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch {
        return null;
    }
}

// Ticker lookup — a bare ticker (AAPL, BRK-B, ASML.AS, BTC-USD) or an explicit
// $cashtag ($AAPL). The pattern is only a shape filter: the card renders solely
// when a live quote returns, so ordinary words that fit the shape show nothing.
const CASHTAG_QUERY = /^\$([A-Za-z][A-Za-z0-9.-]{0,9})$/;
const BARE_TICKER_QUERY = /^[A-Za-z]{2,5}(?:[.-][A-Za-z0-9]{1,4})?$/;

function parseTickerQuery(q: string): string | null {
    const cash = q.match(CASHTAG_QUERY);
    if (cash) return cash[1].toUpperCase();
    if (BARE_TICKER_QUERY.test(q)) return q.toUpperCase();
    return null;
}

const RECENTS_KEY = LOCAL_STORAGE_KEYS.PALETTE_RECENTS;
const MAX_RECENTS = 5;

function readRecents(): string[] {
    try {
        const raw = localStorage.getItem(RECENTS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}

function pushRecent(url: string): void {
    try {
        const next = [url, ...readRecents().filter((u) => u !== url)].slice(0, MAX_RECENTS);
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch { /* localStorage unavailable */ }
}

interface CommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onOpenSettings: (tab: string) => void;
    onOpenShortcuts: () => void;
}

export function CommandPalette({ open, onOpenChange, onOpenSettings, onOpenShortcuts }: CommandPaletteProps) {
    const navigate = useNavigate();
    const { t } = useLanguage();
    const { setMode } = useTheme();
    const { setWorkspace } = useWorkspace();
    const { appSettings } = useAppSettings();
    const [query, setQuery] = useState("");
    const debouncedQuery = useDebounce(query.trim(), SEARCH_DEBOUNCE_MS);
    const [recents, setRecents] = useState<string[]>([]);

    useEffect(() => {
        if (open) {
            setRecents(readRecents());
        } else {
            setQuery("");
        }
    }, [open]);

    const locale = numberFormatToLocale(appSettings.numberFormat);
    const fxParsed = useMemo(() => parseFxQuery(query.trim()), [query]);
    const fxTarget = fxParsed?.to ?? appSettings.defaultCurrency ?? "EUR";
    const { convertToTarget } = useCurrencyConverter(fxTarget);
    const fxResult = useMemo(() => {
        if (!fxParsed || fxParsed.from === fxTarget) return null;
        const converted = convertToTarget(fxParsed.amount, fxParsed.from);
        if (converted == null || !Number.isFinite(converted)) return null;
        try {
            return new Intl.NumberFormat(locale, { style: "currency", currency: fxTarget }).format(converted);
        } catch {
            return `${converted.toFixed(2)} ${fxTarget}`;
        }
    }, [fxParsed, fxTarget, convertToTarget, locale]);

    const calcResult = useMemo(() => {
        if (fxParsed) return null;
        const value = evaluateArithmetic(query.trim());
        return value == null ? null : new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
    }, [fxParsed, query, locale]);

    const copyResult = (text: string) => {
        onOpenChange(false);
        navigator.clipboard?.writeText(text).then(
            () => toast.success(t("commandPalette.copied")),
            () => undefined,
        );
    };

    const { data: recipientHits } = useQuery({
        queryKey: ["palette-recipients", debouncedQuery],
        queryFn: () => apiClient.getRecipients({ search: debouncedQuery, active: true, limit: 5 }),
        enabled: open && debouncedQuery.length >= 2,
        staleTime: 30_000,
    });

    // Inline ticker quote — when the query looks like a symbol, fetch a price-only
    // quote and surface its absolute + relative move. Enter opens Market Lookup.
    const tickerSymbol = useMemo(() => parseTickerQuery(query.trim()), [query]);
    const debouncedTicker = useDebounce(tickerSymbol ?? "", SEARCH_DEBOUNCE_MS);
    const { data: tickerQuote, isFetching: tickerLoading } = useQuery({
        queryKey: ["palette-quote", debouncedTicker],
        queryFn: async () => {
            const { quotes } = await apiClient.getMarketQuotes<PaletteQuote>(debouncedTicker, { detail: "basic" });
            return quotes[0] ?? null;
        },
        enabled: open && debouncedTicker.length >= 1,
        staleTime: 30_000,
    });
    const fmtTickerPrice = (val: number, currency: string) => {
        try {
            return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
        } catch {
            return `${val.toFixed(2)} ${currency}`;
        }
    };

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onOpenChange(!open);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [open, onOpenChange]);

    const goTo = (url: string) => {
        onOpenChange(false);
        pushRecent(url);
        // Keep the sidebar workspace in sync with cross-workspace jumps.
        if (url.startsWith("/portfolio")) {
            setWorkspace("portfolio");
        } else if (url.startsWith("/research")) {
            setWorkspace("research");
        } else if (url !== "/ai-chat") {
            setWorkspace("budgeting");
        }
        navigate(url);
    };

    const runAction = (action: () => void) => {
        onOpenChange(false);
        action();
    };

    const adminPages: PaletteEntry[] = useMemo(
        () =>
            appSettings.adminMode
                ? [
                      { titleKey: "nav.adminOverview", url: "/admin", icon: Settings },
                      { titleKey: "nav.dbMaintenance", url: "/admin/db", icon: Settings },
                      { titleKey: "nav.adminProviders", url: "/admin/providers", icon: Settings },
                      { titleKey: "nav.adminEndpoints", url: "/admin/endpoints", icon: Settings },
                      { titleKey: "nav.exchangeRates", url: "/admin/exchange-rates", icon: ArrowLeftRight },
                  ]
                : [],
        [appSettings.adminMode],
    );

    const allPages = useMemo(
        () => [...BUDGETING_PAGES, ...PORTFOLIO_PAGES, ...RESEARCH_PAGES, ...adminPages],
        [adminPages],
    );
    const recentEntries = useMemo(
        () => recents
            .map((url) => allPages.find((p) => p.url === url))
            .filter((p): p is PaletteEntry => Boolean(p)),
        [recents, allPages],
    );

    return (
        <CommandDialog open={open} onOpenChange={onOpenChange}>
            <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder={t("commandPalette.placeholder")}
                aria-label={t("commandPalette.placeholder")}
            />
            <CommandList>
                <CommandEmpty>{t("commandPalette.noResults")}</CommandEmpty>
                {tickerSymbol && (tickerQuote || tickerLoading) && (
                    <CommandGroup heading={t("commandPalette.market")} forceMount>
                        <CommandItem
                            forceMount
                            value={`market ${tickerSymbol} ${tickerQuote?.name ?? ""}`}
                            onSelect={() => goTo(`/research/market?symbol=${encodeURIComponent(tickerQuote?.symbol ?? tickerSymbol)}`)}
                        >
                            <LineChart className="text-muted-foreground" />
                            <span className="font-medium">{tickerQuote?.symbol ?? tickerSymbol}</span>
                            {tickerQuote ? (
                                <>
                                    {tickerQuote.name && (
                                        <span className="truncate text-xs text-muted-foreground">{tickerQuote.name}</span>
                                    )}
                                    <span className="ml-auto flex items-baseline gap-2 tabular-nums">
                                        <span className="font-semibold text-foreground">
                                            {fmtTickerPrice(tickerQuote.price, tickerQuote.currency)}
                                        </span>
                                        <span className={cn(
                                            "text-xs font-semibold",
                                            tickerQuote.change >= 0 ? "amount-gain" : "amount-loss",
                                        )}>
                                            {tickerQuote.change >= 0 ? "+" : "−"}{Math.abs(tickerQuote.changePercent).toFixed(2)}%
                                        </span>
                                    </span>
                                </>
                            ) : (
                                <CommandShortcut>{t("commandPalette.lookingUp")}</CommandShortcut>
                            )}
                        </CommandItem>
                    </CommandGroup>
                )}
                {(fxResult || calcResult) && (
                    <CommandGroup heading={t("commandPalette.result")} forceMount>
                        <CommandItem
                            forceMount
                            value={`result ${query}`}
                            onSelect={() => copyResult((fxResult ?? calcResult) as string)}
                        >
                            {fxResult ? <ArrowLeftRight className="text-muted-foreground" /> : <Calculator className="text-muted-foreground" />}
                            <span className="font-semibold tabular-nums">{fxResult ?? calcResult}</span>
                            <CommandShortcut>{t("commandPalette.copyHint")}</CommandShortcut>
                        </CommandItem>
                    </CommandGroup>
                )}
                {query.trim().length >= 2 && (
                    <CommandGroup heading={t("commandPalette.actions")} forceMount>
                        <CommandItem
                            forceMount
                            value={`tx-search ${query}`}
                            onSelect={() => goTo(`/transactions?search=${encodeURIComponent(query.trim())}`)}
                        >
                            <Receipt className="text-muted-foreground" />
                            <span>{t("commandPalette.searchTransactions", { q: query.trim() })}</span>
                        </CommandItem>
                    </CommandGroup>
                )}
                {(recipientHits?.items?.length ?? 0) > 0 && (
                    <CommandGroup heading={t("nav.recipients")} forceMount>
                        {recipientHits!.items.map((r) => (
                            <CommandItem
                                key={`recipient-${r.id}`}
                                forceMount
                                value={`recipient ${r.name} ${query}`}
                                onSelect={() => goTo(`/transactions?recipient_id=${r.id}&filter_label=${encodeURIComponent(r.name)}`)}
                            >
                                <Users className="text-muted-foreground" />
                                <span>{r.name}</span>
                            </CommandItem>
                        ))}
                    </CommandGroup>
                )}
                {recentEntries.length > 0 && query.trim() === "" && (
                    <CommandGroup heading={t("commandPalette.recent")}>
                        {recentEntries.map((page) => (
                            <CommandItem key={`recent-${page.url}`} value={`recent ${t(page.titleKey)} ${page.url}`} onSelect={() => goTo(page.url)}>
                                <page.icon className="text-muted-foreground" />
                                <span>{t(page.titleKey)}</span>
                                <GoToHint url={page.url} />
                            </CommandItem>
                        ))}
                    </CommandGroup>
                )}
                <CommandGroup heading={t("nav.budgeting")}>
                    {BUDGETING_PAGES.map((page) => (
                        <CommandItem key={page.url} value={`${t(page.titleKey)} ${page.url}`} onSelect={() => goTo(page.url)}>
                            <page.icon className="text-muted-foreground" />
                            <span>{t(page.titleKey)}</span>
                            <GoToHint url={page.url} />
                        </CommandItem>
                    ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading={t("nav.portfolio")}>
                    {PORTFOLIO_PAGES.map((page) => (
                        <CommandItem key={page.url} value={`${t(page.titleKey)} ${page.url}`} onSelect={() => goTo(page.url)}>
                            <page.icon className="text-muted-foreground" />
                            <span>{t(page.titleKey)}</span>
                            <GoToHint url={page.url} />
                        </CommandItem>
                    ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading={t("nav.research")}>
                    {RESEARCH_PAGES.map((page) => (
                        <CommandItem key={page.url} value={`${t(page.titleKey)} ${page.url}`} onSelect={() => goTo(page.url)}>
                            <page.icon className="text-muted-foreground" />
                            <span>{t(page.titleKey)}</span>
                            <GoToHint url={page.url} />
                        </CommandItem>
                    ))}
                </CommandGroup>
                {adminPages.length > 0 && (
                    <>
                        <CommandSeparator />
                        <CommandGroup heading={t("nav.admin")}>
                            {adminPages.map((page) => (
                                <CommandItem key={page.url} value={`${t(page.titleKey)} ${page.url}`} onSelect={() => goTo(page.url)}>
                                    <page.icon className="text-muted-foreground" />
                                    <span>{t(page.titleKey)}</span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </>
                )}
                <CommandSeparator />
                <CommandGroup heading={t("commandPalette.actions")}>
                    <CommandItem value={t("layout.light")} onSelect={() => runAction(() => setMode("light"))}>
                        <Sun className="text-muted-foreground" />
                        <span>{t("layout.light")}</span>
                    </CommandItem>
                    <CommandItem value={t("layout.dark")} onSelect={() => runAction(() => setMode("dark"))}>
                        <Moon className="text-muted-foreground" />
                        <span>{t("layout.dark")}</span>
                    </CommandItem>
                    <CommandItem value={t("layout.settings")} onSelect={() => runAction(() => onOpenSettings("general"))}>
                        <Settings className="text-muted-foreground" />
                        <span>{t("layout.settings")}</span>
                        <CommandShortcut>⌘,</CommandShortcut>
                    </CommandItem>
                    <CommandItem value={t("shortcuts.title")} onSelect={() => runAction(onOpenShortcuts)}>
                        <Keyboard className="text-muted-foreground" />
                        <span>{t("shortcuts.title")}</span>
                        <CommandShortcut>?</CommandShortcut>
                    </CommandItem>
                </CommandGroup>
            </CommandList>
        </CommandDialog>
    );
}
