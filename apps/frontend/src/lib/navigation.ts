import {
    Activity,
    ArrowLeftRight,
    BarChart3,
    Briefcase,
    Building2,
    CalendarClock,
    CandlestickChart,
    Coins,
    Database,
    Gem,
    GitCompareArrows,
    Globe,
    HandCoins,
    Import,
    Landmark,
    LayoutDashboard,
    LineChart,
    PiggyBank,
    Receipt,
    Scale,
    ShieldCheck,
    Sparkles,
    Tags,
    Target,
    Telescope,
    TrendingUp,
    Users,
    Wallet,
    type LucideIcon,
} from "lucide-react";
import type { Workspace } from "@/contexts/WorkspaceContext";

/**
 * Single source of truth for the app's navigable pages.
 *
 * Every navigation surface derives its view from this registry instead of
 * hand-maintaining its own list (which had already drifted apart):
 *   - AppSidebar renders the grouped workspace sections, the workspace
 *     switcher, the workspace-agnostic pages, and the admin section;
 *   - CommandPalette flattens the same sections into searchable page entries
 *     (`PALETTE_SECTIONS`);
 *   - useGoToShortcuts binds the `g`-then-key sequences (`GO_TO_ROUTES`,
 *     derived from `shortcutKey`), and ShortcutsOverlay lists them;
 *   - useDocumentTitle resolves the per-route title via `matchNavTitleKey`.
 */
export interface NavItem {
    /** i18n key for the page label — resolved through the active locale. */
    titleKey: string;
    url: string;
    icon: LucideIcon;
    /**
     * Command-palette icon override for the one place the surfaces
     * deliberately differ (the portfolio dashboard). Omitted everywhere else.
     */
    paletteIcon?: LucideIcon;
    /** Second key of the `g`-then-key go-to sequence, if the page has one. */
    shortcutKey?: string;
    /**
     * Label override for the shortcuts-overlay go-to list, for the one entry
     * whose page title is ambiguous there (the portfolio dashboard: "G P"
     * reads "Portfolio", not a second "Dashboard"). Omitted everywhere else.
     */
    goToTitleKey?: string;
}

export interface NavGroup {
    /** i18n key for the sidebar group label (e.g. "nav.overview"). */
    labelKey: string;
    items: NavItem[];
}

export interface NavWorkspaceSection {
    id: Workspace;
    /** i18n key for the workspace label — switcher tab and palette heading. */
    labelKey: string;
    /** Workspace-switcher icon (also the collapsed-rail cycle button). */
    icon: LucideIcon;
    /** Section root: `[` / `]` cycling lands here; active only on exact match. */
    rootUrl: string;
    groups: NavGroup[];
}

/**
 * Workspace-agnostic pages (AI chat, and the cross-workspace Accounts hub —
 * ADR-088). The sidebar pins them above the workspace switcher; the palette
 * lists them at the tail of the Budgeting section; navigating to them never
 * forces a workspace switch (see WORKSPACE_AGNOSTIC_URLS).
 */
export const GLOBAL_NAV_ITEMS: NavItem[] = [
    { titleKey: "nav.aiChat", url: "/ai-chat", icon: Sparkles, shortcutKey: "a" },
    { titleKey: "nav.accounts", url: "/accounts", icon: Landmark },
];

const BUDGETING_SECTION: NavWorkspaceSection = {
    id: "budgeting",
    labelKey: "nav.budgeting",
    icon: Receipt,
    rootUrl: "/",
    groups: [
        {
            labelKey: "nav.overview",
            items: [
                { titleKey: "nav.dashboard", url: "/", icon: LayoutDashboard, shortcutKey: "d" },
                { titleKey: "nav.transactions", url: "/transactions", icon: Receipt, shortcutKey: "t" },
            ],
        },
        {
            labelKey: "nav.organization",
            items: [
                { titleKey: "nav.categories", url: "/categories", icon: Tags, shortcutKey: "c" },
                { titleKey: "nav.recipients", url: "/recipients", icon: Users, shortcutKey: "r" },
            ],
        },
        {
            labelKey: "nav.analysis",
            items: [
                { titleKey: "nav.statistics", url: "/statistics", icon: BarChart3, shortcutKey: "s" },
                { titleKey: "nav.plannedPayments", url: "/planned", icon: CalendarClock },
                { titleKey: "nav.whoOwesYou", url: "/owes", icon: HandCoins },
                { titleKey: "nav.taxOverview", url: "/tax", icon: Landmark },
            ],
        },
        {
            labelKey: "nav.tools",
            items: [
                { titleKey: "nav.importExport", url: "/import", icon: Import, shortcutKey: "i" },
            ],
        },
    ],
};

const PORTFOLIO_SECTION: NavWorkspaceSection = {
    id: "portfolio",
    labelKey: "nav.portfolio",
    icon: Briefcase,
    rootUrl: "/portfolio",
    groups: [
        {
            labelKey: "nav.overview",
            items: [
                // The palette's flat list has two "Dashboard" rows (budgeting +
                // portfolio); it keeps the workspace's Briefcase to tell them
                // apart, while the grouped sidebar uses LayoutDashboard.
                { titleKey: "nav.dashboard", url: "/portfolio", icon: LayoutDashboard, paletteIcon: Briefcase, shortcutKey: "p", goToTitleKey: "nav.portfolio" },
                { titleKey: "nav.netWorth", url: "/portfolio/net-worth", icon: Wallet, shortcutKey: "n" },
            ],
        },
        {
            labelKey: "nav.investments",
            items: [
                { titleKey: "nav.stocksEtfs", url: "/portfolio/stocks", icon: TrendingUp },
                { titleKey: "nav.crypto", url: "/portfolio/crypto", icon: Coins },
                { titleKey: "nav.metals", url: "/portfolio/metals", icon: Gem },
            ],
        },
        {
            labelKey: "nav.assets",
            items: [
                { titleKey: "nav.realEstate", url: "/portfolio/real-estate", icon: Building2 },
                { titleKey: "nav.savingsBonds", url: "/portfolio/savings", icon: PiggyBank },
            ],
        },
        {
            labelKey: "nav.analysis",
            items: [
                { titleKey: "nav.performance", url: "/portfolio/performance", icon: BarChart3 },
                { titleKey: "nav.rebalance", url: "/portfolio/rebalance", icon: Scale },
                { titleKey: "nav.taxOverview", url: "/portfolio/tax", icon: Landmark },
            ],
        },
        {
            labelKey: "nav.tools",
            items: [
                { titleKey: "nav.portfolioImport", url: "/portfolio/import", icon: Import },
            ],
        },
    ],
};

const RESEARCH_SECTION: NavWorkspaceSection = {
    id: "research",
    labelKey: "nav.research",
    icon: Telescope,
    rootUrl: "/research",
    groups: [
        {
            labelKey: "nav.overview",
            items: [
                { titleKey: "nav.researchHome", url: "/research", icon: Telescope },
                { titleKey: "nav.markets", url: "/research/markets", icon: Globe, shortcutKey: "m" },
                { titleKey: "nav.marketLookup", url: "/research/market", icon: LineChart },
            ],
        },
        {
            labelKey: "nav.analysis",
            items: [
                { titleKey: "nav.compare", url: "/research/compare", icon: GitCompareArrows },
                { titleKey: "nav.chartBuilder", url: "/research/charts", icon: CandlestickChart },
                { titleKey: "nav.forecast", url: "/research/forecast", icon: TrendingUp },
                { titleKey: "nav.watchlist", url: "/research/watchlist", icon: Target },
            ],
        },
    ],
};

/** Workspace lookup for the sidebar (typed so every Workspace has a section). */
export const NAV_WORKSPACE_BY_ID: Record<Workspace, NavWorkspaceSection> = {
    budgeting: BUDGETING_SECTION,
    portfolio: PORTFOLIO_SECTION,
    research: RESEARCH_SECTION,
};

/** The workspace sections in left-to-right display/cycle order. */
export const NAV_WORKSPACES: ReadonlyArray<NavWorkspaceSection> = [
    BUDGETING_SECTION,
    PORTFOLIO_SECTION,
    RESEARCH_SECTION,
];

/**
 * Admin pages — shown only when `appSettings.adminMode` is on (both sidebar
 * and palette gate on it). Icons reconciled: the palette's drifted copy used a
 * generic `Settings` placeholder for the first four; the sidebar's semantic
 * icons win and both surfaces now share them.
 */
export const ADMIN_NAV_ITEMS: NavItem[] = [
    { titleKey: "nav.adminOverview", url: "/admin", icon: ShieldCheck },
    { titleKey: "nav.dbMaintenance", url: "/admin/db", icon: Database },
    { titleKey: "nav.adminProviders", url: "/admin/providers", icon: Globe },
    { titleKey: "nav.adminEndpoints", url: "/admin/endpoints", icon: Activity },
    { titleKey: "nav.exchangeRates", url: "/admin/exchange-rates", icon: ArrowLeftRight },
];

// ---------------------------------------------------------------------------
// Derived views — consumers use these instead of re-declaring the data.
// ---------------------------------------------------------------------------

function flattenGroups(section: NavWorkspaceSection): NavItem[] {
    return section.groups.flatMap((group) => group.items);
}

/**
 * All navigable pages across every workspace (global + admin included), in
 * display order. Used to resolve a pathname back to its title key and to look
 * up palette recents.
 */
export const ALL_NAV_ITEMS: ReadonlyArray<NavItem> = [
    ...NAV_WORKSPACES.flatMap(flattenGroups),
    ...GLOBAL_NAV_ITEMS,
    ...ADMIN_NAV_ITEMS,
];

/** Palette view of an item: the per-surface icon override applied. */
function toPaletteItem(item: NavItem): NavItem {
    return item.paletteIcon ? { ...item, icon: item.paletteIcon } : item;
}

/**
 * The command palette's always-visible nav sections: each workspace flattened
 * in sidebar order, with the workspace-agnostic pages carried at the tail of
 * the Budgeting section (AI chat's historical spot). Reconciled: the palette's
 * drifted copy was missing Rebalance, Portfolio Import and Accounts, and
 * ordered Performance ahead of the investment pages; it now follows the
 * sidebar's maintained order.
 */
export const PALETTE_SECTIONS: ReadonlyArray<{ headingKey: string; pages: ReadonlyArray<NavItem> }> =
    NAV_WORKSPACES.map((ws) => ({
        headingKey: ws.labelKey,
        pages: (ws.id === "budgeting"
            ? [...flattenGroups(ws), ...GLOBAL_NAV_ITEMS]
            : flattenGroups(ws)
        ).map(toPaletteItem),
    }));

/** Gmail-style go-to sequences: press `g`, then a destination key. Derived
 *  from `shortcutKey` in registry order; shared with ShortcutsOverlay so the
 *  help sheet stays truthful. */
export const GO_TO_ROUTES: ReadonlyArray<{ key: string; url: string; titleKey: string }> =
    ALL_NAV_ITEMS.flatMap((item) =>
        item.shortcutKey
            ? [{ key: item.shortcutKey, url: item.url, titleKey: item.goToTitleKey ?? item.titleKey }]
            : []);

/** url → go-to key, so nav surfaces can display an entry's keyboard sequence. */
export const GO_TO_KEY_BY_URL: ReadonlyMap<string, string> =
    new Map(GO_TO_ROUTES.map((r) => [r.url, r.key]));

/** The three workspace section roots, in left-to-right cycle order. `[` / `]`
 *  step between them; shared with ShortcutsOverlay so the help stays truthful. */
export const SECTION_CYCLE: ReadonlyArray<{ url: string; titleKey: string }> =
    NAV_WORKSPACES.map((ws) => ({ url: ws.rootUrl, titleKey: ws.labelKey }));

/** Workspace root urls — active only on an exact match (they have children). */
export const WORKSPACE_ROOT_URLS: ReadonlySet<string> =
    new Set(NAV_WORKSPACES.map((ws) => ws.rootUrl));

/** Urls of workspace-agnostic pages: jumping to one keeps the current
 *  workspace (and its sidebar) instead of forcing a switch. */
export const WORKSPACE_AGNOSTIC_URLS: ReadonlySet<string> =
    new Set(GLOBAL_NAV_ITEMS.map((item) => item.url));

/**
 * Resolve a pathname to the title key of the most specific matching nav route,
 * or `undefined` when nothing matches. The root ("/") matches only exactly;
 * every other route matches its own path or any child path ("/import/42/review"
 * → "/import") with the longest matching prefix winning so siblings and parents
 * don't shadow a deeper page.
 */
export function matchNavTitleKey(pathname: string): string | undefined {
    let best: NavItem | undefined;
    for (const route of ALL_NAV_ITEMS) {
        const matches = route.url === "/"
            ? pathname === "/"
            : pathname === route.url || pathname.startsWith(route.url + "/");
        if (matches && (!best || route.url.length > best.url.length)) best = route;
    }
    return best?.titleKey;
}
