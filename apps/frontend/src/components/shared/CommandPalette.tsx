import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
} from "@/components/ui/command";
import {
    ArrowLeftRight,
    BarChart3,
    Briefcase,
    Building2,
    CalendarClock,
    Coins,
    Gem,
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
    TrendingUp,
    Users,
    Wallet,
    type LucideIcon,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";

interface PaletteEntry {
    titleKey: string;
    url: string;
    icon: LucideIcon;
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
    { titleKey: "nav.marketLookup", url: "/portfolio/market", icon: LineChart },
    { titleKey: "nav.watchlist", url: "/portfolio/watchlist", icon: Target },
    { titleKey: "nav.exchangeRates", url: "/portfolio/exchange-rates", icon: ArrowLeftRight },
    { titleKey: "nav.taxOverview", url: "/portfolio/tax", icon: Landmark },
];

interface CommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onOpenSettings: (tab: string) => void;
}

export function CommandPalette({ open, onOpenChange, onOpenSettings }: CommandPaletteProps) {
    const navigate = useNavigate();
    const { t } = useLanguage();
    const { setMode } = useTheme();
    const { setWorkspace } = useWorkspace();
    const { appSettings } = useAppSettings();

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
        // Keep the sidebar workspace in sync with cross-workspace jumps.
        if (url.startsWith("/portfolio")) {
            setWorkspace("portfolio");
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
                  ]
                : [],
        [appSettings.adminMode],
    );

    return (
        <CommandDialog open={open} onOpenChange={onOpenChange}>
            <CommandInput placeholder={t("commandPalette.placeholder")} aria-label={t("commandPalette.placeholder")} />
            <CommandList>
                <CommandEmpty>{t("commandPalette.noResults")}</CommandEmpty>
                <CommandGroup heading={t("nav.budgeting")}>
                    {BUDGETING_PAGES.map((page) => (
                        <CommandItem key={page.url} value={`${t(page.titleKey)} ${page.url}`} onSelect={() => goTo(page.url)}>
                            <page.icon className="text-muted-foreground" />
                            <span>{t(page.titleKey)}</span>
                        </CommandItem>
                    ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading={t("nav.portfolio")}>
                    {PORTFOLIO_PAGES.map((page) => (
                        <CommandItem key={page.url} value={`${t(page.titleKey)} ${page.url}`} onSelect={() => goTo(page.url)}>
                            <page.icon className="text-muted-foreground" />
                            <span>{t(page.titleKey)}</span>
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
                    </CommandItem>
                </CommandGroup>
            </CommandList>
        </CommandDialog>
    );
}
