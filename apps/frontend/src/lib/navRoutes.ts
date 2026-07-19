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
    PiggyBank,
    Receipt,
    Settings,
    Sparkles,
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

/**
 * A navigable page: its i18n title key, route URL, and icon. Shared source of
 * truth for the command palette entries and the per-route document title —
 * `titleKey` is resolved through the active locale by whichever consumer needs
 * a label, so the mapping lives in exactly one place.
 */
export interface NavRoute {
    titleKey: string;
    url: string;
    icon: LucideIcon;
}

export const BUDGETING_PAGES: NavRoute[] = [
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

export const PORTFOLIO_PAGES: NavRoute[] = [
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

export const RESEARCH_PAGES: NavRoute[] = [
    { titleKey: "nav.researchHome", url: "/research", icon: Telescope },
    { titleKey: "nav.markets", url: "/research/markets", icon: Globe },
    { titleKey: "nav.marketLookup", url: "/research/market", icon: LineChart },
    { titleKey: "nav.compare", url: "/research/compare", icon: GitCompareArrows },
    { titleKey: "nav.chartBuilder", url: "/research/charts", icon: CandlestickChart },
    { titleKey: "nav.forecast", url: "/research/forecast", icon: TrendingUp },
    { titleKey: "nav.watchlist", url: "/research/watchlist", icon: Target },
];

export const ADMIN_PAGES: NavRoute[] = [
    { titleKey: "nav.adminOverview", url: "/admin", icon: Settings },
    { titleKey: "nav.dbMaintenance", url: "/admin/db", icon: Settings },
    { titleKey: "nav.adminProviders", url: "/admin/providers", icon: Settings },
    { titleKey: "nav.adminEndpoints", url: "/admin/endpoints", icon: Settings },
    { titleKey: "nav.exchangeRates", url: "/admin/exchange-rates", icon: ArrowLeftRight },
];

// All navigable pages across every workspace (admin included). Used to resolve a
// pathname back to its title key.
const ALL_ROUTES: NavRoute[] = [
    ...BUDGETING_PAGES,
    ...PORTFOLIO_PAGES,
    ...RESEARCH_PAGES,
    ...ADMIN_PAGES,
];

/**
 * Resolve a pathname to the title key of the most specific matching nav route,
 * or `undefined` when nothing matches. The root ("/") matches only exactly;
 * every other route matches its own path or any child path ("/import/42/review"
 * → "/import") with the longest matching prefix winning so siblings and parents
 * don't shadow a deeper page.
 */
export function matchNavTitleKey(pathname: string): string | undefined {
    let best: NavRoute | undefined;
    for (const route of ALL_ROUTES) {
        const matches = route.url === "/"
            ? pathname === "/"
            : pathname === route.url || pathname.startsWith(route.url + "/");
        if (matches && (!best || route.url.length > best.url.length)) best = route;
    }
    return best?.titleKey;
}
