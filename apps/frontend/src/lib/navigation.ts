import type { LucideIcon } from "lucide-react";
import { PAGE_ICONS } from "@/lib/pageIcons";

/**
 * Single source of truth for the app's navigable pages.
 *
 * Every navigation surface derives its view from this registry instead of
 * hand-maintaining its own list (which had already drifted apart):
 *   - AppSidebar renders one labelled sidebar: the top items, the Money,
 *     Wealth and Research sections (each can be hidden), the admin section,
 *     and the footer items;
 *   - CommandPalette flattens the same sections into searchable page entries
 *     (`PALETTE_SECTIONS`);
 *   - useGoToShortcuts binds the `g`-then-key sequences (`GO_TO_ROUTES`,
 *     derived from `shortcutKey`), and ShortcutsOverlay lists them;
 *   - useDocumentTitle resolves the per-route title via `matchNavTitleKey`.
 *
 * Sections replaced the three workspace modes (ADR-180): everything is
 * visible at once, like Finder or Music, so nothing hides behind a switch.
 */
export interface NavItem {
    /** i18n key for the page label — resolved through the active locale. */
    titleKey: string;
    url: string;
    icon: LucideIcon;
    /** Second key of the `g`-then-key go-to sequence, if the page has one. */
    shortcutKey?: string;
    /**
     * A live count rendered next to the label: things that need the user
     * (uncategorized transactions, payments due) or are waiting (insights,
     * unread monitor results). The sidebar maps each id to its hook.
     */
    badge?: "needs-category" | "planned-due" | "insights" | "monitors";
    /**
     * Active when the pathname matches exactly, instead of the default
     * boundary-aware prefix match. Used by section roots that have children
     * with their own entries (`/portfolio`, `/research`, `/admin`).
     */
    exact?: boolean;
}

export type NavSectionId = "top" | "money" | "wealth" | "research" | "admin";

export interface NavSection {
    id: NavSectionId;
    /** i18n key for the section heading. The top section has none. */
    labelKey?: string;
    /** A section with a heading can be hidden ("Hide" / "Show"). */
    collapsible: boolean;
    /** Hidden until the user shows it (persisted per browser). */
    defaultHidden?: boolean;
    items: NavItem[];
}

const TOP_SECTION: NavSection = {
    id: "top",
    collapsible: false,
    items: [
        {
            titleKey: "nav.home",
            url: "/",
            icon: PAGE_ICONS["/"],
            shortcutKey: "h",
            exact: true,
        },
        {
            titleKey: "nav.transactions",
            url: "/transactions",
            icon: PAGE_ICONS["/transactions"],
            shortcutKey: "t",
            badge: "needs-category",
        },
        {
            titleKey: "nav.accounts",
            url: "/accounts",
            icon: PAGE_ICONS["/accounts"],
        },
        {
            titleKey: "nav.plannedPayments",
            url: "/planned",
            icon: PAGE_ICONS["/planned"],
            badge: "planned-due",
        },
    ],
};

const MONEY_SECTION: NavSection = {
    id: "money",
    labelKey: "nav.money",
    collapsible: true,
    items: [
        {
            titleKey: "nav.categories",
            url: "/categories",
            icon: PAGE_ICONS["/categories"],
            shortcutKey: "c",
        },
        {
            titleKey: "nav.recipients",
            url: "/recipients",
            icon: PAGE_ICONS["/recipients"],
            shortcutKey: "r",
        },
        {
            titleKey: "nav.statistics",
            url: "/statistics",
            icon: PAGE_ICONS["/statistics"],
            shortcutKey: "s",
            badge: "insights",
        },
        {
            titleKey: "nav.whoOwesYou",
            url: "/owes",
            icon: PAGE_ICONS["/owes"],
        },
        {
            titleKey: "nav.taxes",
            url: "/tax",
            icon: PAGE_ICONS["/tax"],
        },
        {
            titleKey: "nav.importExport",
            url: "/import",
            icon: PAGE_ICONS["/import"],
            shortcutKey: "i",
        },
    ],
};

const WEALTH_SECTION: NavSection = {
    id: "wealth",
    labelKey: "nav.wealth",
    collapsible: true,
    items: [
        {
            titleKey: "nav.portfolio",
            url: "/portfolio",
            icon: PAGE_ICONS["/portfolio"],
            shortcutKey: "p",
            exact: true,
        },
        {
            titleKey: "nav.netWorth",
            url: "/portfolio/net-worth",
            icon: PAGE_ICONS["/portfolio/net-worth"],
            shortcutKey: "n",
        },
        {
            titleKey: "nav.stocksEtfs",
            url: "/portfolio/stocks",
            icon: PAGE_ICONS["/portfolio/stocks"],
        },
        {
            titleKey: "nav.crypto",
            url: "/portfolio/crypto",
            icon: PAGE_ICONS["/portfolio/crypto"],
        },
        {
            titleKey: "nav.metals",
            url: "/portfolio/metals",
            icon: PAGE_ICONS["/portfolio/metals"],
        },
        {
            titleKey: "nav.realEstate",
            url: "/portfolio/real-estate",
            icon: PAGE_ICONS["/portfolio/real-estate"],
        },
        {
            titleKey: "nav.savingsBonds",
            url: "/portfolio/savings",
            icon: PAGE_ICONS["/portfolio/savings"],
        },
        {
            titleKey: "nav.performance",
            url: "/portfolio/performance",
            icon: PAGE_ICONS["/portfolio/performance"],
        },
        {
            titleKey: "nav.rebalance",
            url: "/portfolio/rebalance",
            icon: PAGE_ICONS["/portfolio/rebalance"],
        },
        {
            titleKey: "nav.portfolioTaxes",
            url: "/portfolio/tax",
            icon: PAGE_ICONS["/portfolio/tax"],
        },
        {
            titleKey: "nav.portfolioImport",
            url: "/portfolio/import",
            icon: PAGE_ICONS["/portfolio/import"],
        },
    ],
};

const RESEARCH_SECTION: NavSection = {
    id: "research",
    labelKey: "nav.research",
    collapsible: true,
    defaultHidden: true,
    items: [
        {
            titleKey: "nav.researchHome",
            url: "/research",
            icon: PAGE_ICONS["/research"],
            exact: true,
        },
        {
            titleKey: "nav.markets",
            url: "/research/markets",
            icon: PAGE_ICONS["/research/markets"],
            shortcutKey: "m",
        },
        {
            titleKey: "nav.marketLookup",
            url: "/research/market",
            icon: PAGE_ICONS["/research/market"],
        },
        {
            titleKey: "nav.compare",
            url: "/research/compare",
            icon: PAGE_ICONS["/research/compare"],
        },
        {
            titleKey: "nav.chartBuilder",
            url: "/research/charts",
            icon: PAGE_ICONS["/research/charts"],
        },
        {
            titleKey: "nav.forecast",
            url: "/research/forecast",
            icon: PAGE_ICONS["/research/forecast"],
        },
        {
            titleKey: "nav.watchlist",
            url: "/research/watchlist",
            icon: PAGE_ICONS["/research/watchlist"],
        },
        {
            titleKey: "nav.dossiers",
            url: "/research/dossiers",
            icon: PAGE_ICONS["/research/dossiers"],
        },
        {
            titleKey: "nav.analysisWorkspace",
            url: "/analysis",
            icon: PAGE_ICONS["/analysis"],
            exact: true,
        },
        {
            titleKey: "nav.analysisMonitors",
            url: "/analysis/monitors",
            icon: PAGE_ICONS["/analysis/monitors"],
            badge: "monitors",
        },
    ],
};

/**
 * Admin pages — shown only when `appSettings.adminMode` is on (sidebar and
 * palette both gate on it). The sidebar renders them as a section that can
 * be hidden like the others; the palette lists them last.
 */
export const ADMIN_SECTION: NavSection = {
    id: "admin",
    labelKey: "nav.admin",
    collapsible: true,
    items: [
        {
            titleKey: "nav.adminOverview",
            url: "/admin",
            icon: PAGE_ICONS["/admin"],
            exact: true,
        },
        {
            titleKey: "nav.dbMaintenance",
            url: "/admin/db",
            icon: PAGE_ICONS["/admin/db"],
        },
        {
            titleKey: "nav.adminProviders",
            url: "/admin/providers",
            icon: PAGE_ICONS["/admin/providers"],
        },
        {
            titleKey: "nav.adminEndpoints",
            url: "/admin/endpoints",
            icon: PAGE_ICONS["/admin/endpoints"],
        },
        {
            titleKey: "nav.exchangeRates",
            url: "/admin/exchange-rates",
            icon: PAGE_ICONS["/admin/exchange-rates"],
        },
    ],
};

export const ADMIN_NAV_ITEMS: ReadonlyArray<NavItem> = ADMIN_SECTION.items;

/** The always-shown sections, top to bottom. Admin is appended at runtime. */
export const NAV_SECTIONS: ReadonlyArray<NavSection> = [
    TOP_SECTION,
    MONEY_SECTION,
    WEALTH_SECTION,
    RESEARCH_SECTION,
];

/**
 * Footer items: the assistant and Settings. Settings is not a route (it is
 * the `?settings=` dialog), so only the assistant is a NavItem here.
 */
export const FOOTER_NAV_ITEMS: ReadonlyArray<NavItem> = [
    {
        titleKey: "nav.aiChat",
        url: "/ai-chat",
        icon: PAGE_ICONS["/ai-chat"],
        shortcutKey: "a",
    },
];

// ---------------------------------------------------------------------------
// Derived views — consumers use these instead of re-declaring the data.
// ---------------------------------------------------------------------------

/**
 * All navigable pages (admin and footer included), in display order. Used to
 * resolve a pathname back to its title key and to look up palette recents.
 */
export const ALL_NAV_ITEMS: ReadonlyArray<NavItem> = [
    ...NAV_SECTIONS.flatMap((section) => section.items),
    ...FOOTER_NAV_ITEMS,
    ...ADMIN_SECTION.items,
];

/**
 * The command palette's always-visible page groups: the top items join the
 * Money group (they are money pages too), then Wealth and Research, with the
 * assistant at the end of Research so every page has a heading.
 */
export const PALETTE_SECTIONS: ReadonlyArray<{
    headingKey: string;
    pages: ReadonlyArray<NavItem>;
}> = [
    {
        headingKey: "nav.money",
        pages: [...TOP_SECTION.items, ...MONEY_SECTION.items],
    },
    { headingKey: "nav.wealth", pages: WEALTH_SECTION.items },
    {
        headingKey: "nav.research",
        pages: [...RESEARCH_SECTION.items, ...FOOTER_NAV_ITEMS],
    },
];

/** Gmail-style go-to sequences: press `g`, then a destination key. Derived
 *  from `shortcutKey` in registry order; shared with ShortcutsOverlay so the
 *  help sheet stays truthful. */
export const GO_TO_ROUTES: ReadonlyArray<{
    key: string;
    url: string;
    titleKey: string;
}> = ALL_NAV_ITEMS.flatMap((item) =>
    item.shortcutKey
        ? [{ key: item.shortcutKey, url: item.url, titleKey: item.titleKey }]
        : [],
);

/** url → go-to key, so nav surfaces can display an entry's keyboard sequence. */
export const GO_TO_KEY_BY_URL: ReadonlyMap<string, string> = new Map(
    GO_TO_ROUTES.map((r) => [r.url, r.key]),
);

/** `[` / `]` step between the three area roots (Home, Portfolio, Research),
 *  as they did between the workspace roots; shared with ShortcutsOverlay. */
export const SECTION_CYCLE: ReadonlyArray<{ url: string; titleKey: string }> =
    [
        { url: "/", titleKey: "nav.home" },
        { url: "/portfolio", titleKey: "nav.portfolio" },
        { url: "/research", titleKey: "nav.research" },
    ];

/** Which registry section a nav item belongs to, by url. */
export const SECTION_ID_BY_URL: ReadonlyMap<string, NavSectionId> = new Map([
    ...NAV_SECTIONS.flatMap((section) =>
        section.items.map(
            (item) => [item.url, section.id] as [string, NavSectionId],
        ),
    ),
    ...ADMIN_SECTION.items.map(
        (item) => [item.url, ADMIN_SECTION.id] as [string, NavSectionId],
    ),
]);

/**
 * Whether a nav item is the active one for `pathname`. Exact items match only
 * themselves; every other item also owns its child routes
 * (`/import/42/review` lights up Import) with a boundary check so a sibling
 * whose path is a string prefix (`/research/market` vs `/research/markets`)
 * does not light up too.
 */
export function isActiveNavItem(item: NavItem, pathname: string): boolean {
    if (item.exact) return pathname === item.url;
    return pathname === item.url || pathname.startsWith(item.url + "/");
}

/**
 * Resolve a pathname to the most specific matching nav item, or `undefined`
 * when nothing matches. The root ("/") matches only exactly; every other
 * route matches its own path or any child path, with the longest matching
 * prefix winning so siblings and parents don't shadow a deeper page.
 */
export function matchNavItem(pathname: string): NavItem | undefined {
    let best: NavItem | undefined;
    for (const route of ALL_NAV_ITEMS) {
        const matches =
            route.url === "/"
                ? pathname === "/"
                : pathname === route.url ||
                  pathname.startsWith(route.url + "/");
        if (matches && (!best || route.url.length > best.url.length))
            best = route;
    }
    return best;
}

/** Title key of the most specific nav route for `pathname`, if any. */
export function matchNavTitleKey(pathname: string): string | undefined {
    return matchNavItem(pathname)?.titleKey;
}

/**
 * The section whose item is active for `pathname`, so the sidebar can show a
 * hidden section while the user is inside it.
 */
export function matchNavSectionId(pathname: string): NavSectionId | undefined {
    const item = matchNavItem(pathname);
    return item ? SECTION_ID_BY_URL.get(item.url) : undefined;
}
