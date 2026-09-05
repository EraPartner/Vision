import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
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
    LineChart,
    Moon,
    Receipt,
    Settings,
    Sun,
    Users,
} from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useTheme } from "@/stores/hydration/ThemeHydration";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useDebounce, SEARCH_DEBOUNCE_MS } from "@/hooks/useDebounce";
import { Keyboard, Calculator } from "lucide-react";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { numberFormatToLocale } from "@/utils/currency";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
    ADMIN_NAV_ITEMS,
    GO_TO_KEY_BY_URL,
    PALETTE_SECTIONS,
    WORKSPACE_AGNOSTIC_URLS,
    type NavItem as PaletteEntry,
} from "@/lib/navigation";
import {
    evaluateArithmetic,
    parseFxQuery,
    parseTickerQuery,
    pushPaletteRecent,
    readPaletteRecents,
} from "@/lib/commandPalette";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import {
    usePaletteRecipientSearch,
    usePaletteTickerQuote,
} from "@/hooks/useCommandPaletteQueries";

function GoToHint({ url }: { url: string }) {
    const key = GO_TO_KEY_BY_URL.get(url);
    if (!key) return null;
    return <CommandShortcut>G {key.toUpperCase()}</CommandShortcut>;
}

// Spotlight-style inline answers ------------------------------------------

interface CommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onOpenSettings: (tab: string) => void;
    onOpenShortcuts: () => void;
}

export function CommandPalette({
    open,
    onOpenChange,
    onOpenSettings,
    onOpenShortcuts,
}: CommandPaletteProps) {
    const formatPercent = usePercentFormatter();
    const formatCurrency = useCurrencyFormatter();
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
            setRecents(readPaletteRecents());
        } else {
            setQuery("");
        }
    }, [open]);

    const locale = numberFormatToLocale(appSettings.numberFormat);
    const fxParsed = useMemo(() => parseFxQuery(query.trim()), [query]);
    const fxTarget = fxParsed?.to ?? appSettings.defaultCurrency ?? "EUR";
    const { convertToTarget } = useCurrencyConverter(fxTarget);
    // User-typed/provider currency codes share the canonical guarded formatter.
    // Keep this surface's useful code-bearing fallback for malformed values.
    const fmtSafeCurrency = useCallback(
        (val: number, currency: string, decimals?: number) => {
            const formatted = formatCurrency(val, {
                currency,
                decimals: decimals ?? appSettings.showDecimalPlaces ?? 2,
            });
            return formatted === `${val}`
                ? `${val.toFixed(2)} ${currency}`
                : formatted;
        },
        [appSettings.showDecimalPlaces, formatCurrency],
    );

    const fxResult = useMemo(() => {
        if (!fxParsed || fxParsed.from === fxTarget) return null;
        const converted = convertToTarget(fxParsed.amount, fxParsed.from);
        if (converted == null || !Number.isFinite(converted)) return null;
        return fmtSafeCurrency(converted, fxTarget);
    }, [fxParsed, fxTarget, convertToTarget, fmtSafeCurrency]);

    const calcResult = useMemo(() => {
        if (fxParsed) return null;
        const value = evaluateArithmetic(query.trim());
        return value == null
            ? null
            : new Intl.NumberFormat(locale, {
                  maximumFractionDigits: 6,
              }).format(value);
    }, [fxParsed, query, locale]);

    const copyResult = (text: string) => {
        onOpenChange(false);
        navigator.clipboard?.writeText(text).then(
            () => toast.success(t("commandPalette.copied")),
            () => undefined,
        );
    };

    const { data: recipientHits } = usePaletteRecipientSearch(
        debouncedQuery,
        open,
    );

    // Inline ticker quote — when the query looks like a symbol, fetch a price-only
    // quote and surface its absolute + relative move. Enter opens Market Lookup.
    const tickerSymbol = useMemo(() => parseTickerQuery(query.trim()), [query]);
    const debouncedTicker = useDebounce(tickerSymbol ?? "", SEARCH_DEBOUNCE_MS);
    const { data: tickerQuote, isFetching: tickerLoading } =
        usePaletteTickerQuote(debouncedTicker, open);
    const fmtTickerPrice = (val: number, currency: string) =>
        fmtSafeCurrency(val, currency, 2);

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
        pushPaletteRecent(url);
        // Keep the sidebar workspace in sync with cross-workspace jumps.
        // Workspace-agnostic pages (AI chat, Accounts) keep the current one.
        if (url.startsWith("/portfolio")) {
            setWorkspace("portfolio");
        } else if (url.startsWith("/research")) {
            setWorkspace("research");
        } else if (!WORKSPACE_AGNOSTIC_URLS.has(url)) {
            setWorkspace("budgeting");
        }
        navigate(url);
    };

    const runAction = (action: () => void) => {
        onOpenChange(false);
        action();
    };

    const adminPages: ReadonlyArray<PaletteEntry> = useMemo(
        () => (appSettings.adminMode ? ADMIN_NAV_ITEMS : []),
        [appSettings.adminMode],
    );

    const allPages = useMemo(
        () => [...PALETTE_SECTIONS.flatMap((s) => s.pages), ...adminPages],
        [adminPages],
    );
    const recentEntries = useMemo(
        () =>
            recents
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
                    <CommandGroup
                        heading={t("commandPalette.market")}
                        forceMount
                    >
                        <CommandItem
                            forceMount
                            value={`market ${tickerSymbol} ${tickerQuote?.name ?? ""}`}
                            onSelect={() =>
                                goTo(
                                    `/research/market?symbol=${encodeURIComponent(tickerQuote?.symbol ?? tickerSymbol)}`,
                                )
                            }
                        >
                            <LineChart className="text-muted-foreground" />
                            <span className="font-medium">
                                {tickerQuote?.symbol ?? tickerSymbol}
                            </span>
                            {tickerQuote ? (
                                <>
                                    {tickerQuote.name && (
                                        <span className="truncate text-xs text-muted-foreground">
                                            {tickerQuote.name}
                                        </span>
                                    )}
                                    <span className="ml-auto flex items-baseline gap-2 tabular-nums">
                                        <span className="font-semibold text-foreground">
                                            {fmtTickerPrice(
                                                tickerQuote.price,
                                                tickerQuote.currency,
                                            )}
                                        </span>
                                        <span
                                            className={cn(
                                                "text-xs font-semibold",
                                                tickerQuote.changePercent >= 0
                                                    ? "text-gain"
                                                    : "text-loss",
                                            )}
                                        >
                                            {formatPercent(
                                                tickerQuote.changePercent,
                                                {
                                                    digits: 2,
                                                    signed: true,
                                                },
                                            )}
                                        </span>
                                    </span>
                                </>
                            ) : (
                                <CommandShortcut>
                                    {t("commandPalette.lookingUp")}
                                </CommandShortcut>
                            )}
                        </CommandItem>
                    </CommandGroup>
                )}
                {(fxResult || calcResult) && (
                    <CommandGroup
                        heading={t("commandPalette.result")}
                        forceMount
                    >
                        <CommandItem
                            forceMount
                            value={`result ${query}`}
                            onSelect={() =>
                                copyResult((fxResult ?? calcResult) as string)
                            }
                        >
                            {fxResult ? (
                                <ArrowLeftRight className="text-muted-foreground" />
                            ) : (
                                <Calculator className="text-muted-foreground" />
                            )}
                            <span className="font-semibold tabular-nums">
                                {fxResult ?? calcResult}
                            </span>
                            <CommandShortcut>
                                {t("commandPalette.copyHint")}
                            </CommandShortcut>
                        </CommandItem>
                    </CommandGroup>
                )}
                {query.trim().length >= 2 && (
                    <CommandGroup
                        heading={t("commandPalette.actions")}
                        forceMount
                    >
                        <CommandItem
                            forceMount
                            value={`tx-search ${query}`}
                            onSelect={() =>
                                goTo(
                                    `/transactions?search=${encodeURIComponent(query.trim())}`,
                                )
                            }
                        >
                            <Receipt className="text-muted-foreground" />
                            <span>
                                {t("commandPalette.searchTransactions", {
                                    q: query.trim(),
                                })}
                            </span>
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
                                onSelect={() =>
                                    goTo(
                                        `/transactions?recipient_id=${r.id}&filter_label=${encodeURIComponent(r.name)}`,
                                    )
                                }
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
                            <CommandItem
                                key={`recent-${page.url}`}
                                value={`recent ${t(page.titleKey)} ${page.url}`}
                                onSelect={() => goTo(page.url)}
                            >
                                <page.icon className="text-muted-foreground" />
                                <span>{t(page.titleKey)}</span>
                                <GoToHint url={page.url} />
                            </CommandItem>
                        ))}
                    </CommandGroup>
                )}
                {/* The always-visible nav sections render identically (heading +
                    page items with go-to hints). Admin stays separate: it is
                    conditional and has no go-to hints. */}
                {PALETTE_SECTIONS.map(({ headingKey, pages }, idx) => (
                    <Fragment key={headingKey}>
                        {idx > 0 && <CommandSeparator />}
                        <CommandGroup heading={t(headingKey)}>
                            {pages.map((page) => (
                                <CommandItem
                                    key={page.url}
                                    value={`${t(page.titleKey)} ${page.url}`}
                                    onSelect={() => goTo(page.url)}
                                >
                                    <page.icon className="text-muted-foreground" />
                                    <span>{t(page.titleKey)}</span>
                                    <GoToHint url={page.url} />
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </Fragment>
                ))}
                {adminPages.length > 0 && (
                    <>
                        <CommandSeparator />
                        <CommandGroup heading={t("nav.admin")}>
                            {adminPages.map((page) => (
                                <CommandItem
                                    key={page.url}
                                    value={`${t(page.titleKey)} ${page.url}`}
                                    onSelect={() => goTo(page.url)}
                                >
                                    <page.icon className="text-muted-foreground" />
                                    <span>{t(page.titleKey)}</span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </>
                )}
                <CommandSeparator />
                <CommandGroup heading={t("commandPalette.actions")}>
                    <CommandItem
                        value={t("layout.light")}
                        onSelect={() => runAction(() => setMode("light"))}
                    >
                        <Sun className="text-muted-foreground" />
                        <span>{t("layout.light")}</span>
                    </CommandItem>
                    <CommandItem
                        value={t("layout.dark")}
                        onSelect={() => runAction(() => setMode("dark"))}
                    >
                        <Moon className="text-muted-foreground" />
                        <span>{t("layout.dark")}</span>
                    </CommandItem>
                    <CommandItem
                        value={t("layout.settings")}
                        onSelect={() =>
                            runAction(() => onOpenSettings("general"))
                        }
                    >
                        <Settings className="text-muted-foreground" />
                        <span>{t("layout.settings")}</span>
                        <CommandShortcut>⌘,</CommandShortcut>
                    </CommandItem>
                    <CommandItem
                        value={t("shortcuts.title")}
                        onSelect={() => runAction(onOpenShortcuts)}
                    >
                        <Keyboard className="text-muted-foreground" />
                        <span>{t("shortcuts.title")}</span>
                        <CommandShortcut>?</CommandShortcut>
                    </CommandItem>
                </CommandGroup>
            </CommandList>
        </CommandDialog>
    );
}
