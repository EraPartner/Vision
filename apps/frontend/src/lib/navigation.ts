import { Briefcase, Receipt, Telescope, type LucideIcon } from "lucide-react";
import type { Workspace } from "@/hooks/useWorkspace";
import { PAGE_ICONS } from "@/lib/pageIcons";

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
    {
        titleKey: "nav.aiChat",
        url: "/ai-chat",
        icon: PAGE_ICONS["/ai-chat"],
        shortcutKey: "a",
    },
    { titleKey: "nav.accounts", url: "/accounts", icon: PAGE_ICONS["/accounts"] },
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
                {
                    titleKey: "nav.dashboard",
                    url: "/",
                    icon: PAGE_ICONS["/"],
                    shortcutKey: "d",
                },
                {
                    titleKey: "nav.transactions",
                    url: "/transactions",
                    icon: PAGE_ICONS["/transactions"],
                    shortcutKey: "t",
                },
            ],
        },
        {
            labelKey: "nav.organization",
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
            ],
        },
        {
            labelKey: "nav.analysis",
            items: [
                {
                    titleKey: "nav.statistics",
                    url: "/statistics",
                    icon: PAGE_ICONS["/statistics"],
                    shortcutKey: "s",
                },
                {
                    titleKey: "nav.plannedPayments",
                    url: "/planned",
                    icon: PAGE_ICONS["/planned"],
                },
                { titleKey: "nav.whoOwesYou", url: "/owes", icon: PAGE_ICONS["/owes"] },
                { titleKey: "nav.taxOverview", url: "/tax", icon: PAGE_ICONS["/tax"] },
            ],
        },
        {
            labelKey: "nav.tools",
            items: [
                {
                    titleKey: "nav.importExport",
                    url: "/import",
                    icon: PAGE_ICONS["/import"],
                    shortcutKey: "i",
                },
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
            items: [                {
                    titleKey: "nav.dashboard",
                    url: "/portfolio",
                    icon: PAGE_ICONS["/portfolio"],
                    shortcutKey: "p",
                    goToTitleKey: "nav.portfolio",
                },
                {
                    titleKey: "nav.netWorth",
                    url: "/portfolio/net-worth",
                    icon: PAGE_ICONS["/portfolio/net-worth"],
                    shortcutKey: "n",
                },
            ],
        },
        {
            labelKey: "nav.investments",
            items: [
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
                { titleKey: "nav.metals", url: "/portfolio/metals", icon: PAGE_ICONS["/portfolio/metals"] },
            ],
        },
        {
            labelKey: "nav.assets",
            items: [
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
            ],
        },
        {
            labelKey: "nav.analysis",
            items: [
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
                    titleKey: "nav.taxOverview",
                    url: "/portfolio/tax",
                    icon: PAGE_ICONS["/portfolio/tax"],
                },
            ],
        },
        {
            labelKey: "nav.tools",
            items: [
                {
                    titleKey: "nav.portfolioImport",
                    url: "/portfolio/import",
                    icon: PAGE_ICONS["/portfolio/import"],
                },
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
                {
                    titleKey: "nav.researchHome",
                    url: "/research",
                    icon: PAGE_ICONS["/research"],
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
            ],
        },
        {
            labelKey: "nav.analysis",
            items: [
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
    { titleKey: "nav.adminOverview", url: "/admin", icon: PAGE_ICONS["/admin"] },
    { titleKey: "nav.dbMaintenance", url: "/admin/db", icon: PAGE_ICONS["/admin/db"] },
    { titleKey: "nav.adminProviders", url: "/admin/providers", icon: PAGE_ICONS["/admin/providers"] },
    { titleKey: "nav.adminEndpoints", url: "/admin/endpoints", icon: PAGE_ICONS["/admin/endpoints"] },
    {
        titleKey: "nav.exchangeRates",
        url: "/admin/exchange-rates",
        icon: PAGE_ICONS["/admin/exchange-rates"],
    },
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

/**
 * The command palette's always-visible nav sections: each workspace flattened
 * in sidebar order, with the workspace-agnostic pages carried at the tail of
 * the Budgeting section (AI chat's historical spot). Reconciled: the palette's
 * drifted copy was missing Rebalance, Portfolio Import and Accounts, and
 * ordered Performance ahead of the investment pages; it now follows the
 * sidebar's maintained order.
 */
export const PALETTE_SECTIONS: ReadonlyArray<{
    headingKey: string;
    pages: ReadonlyArray<NavItem>;
}> = NAV_WORKSPACES.map((ws) => ({
    headingKey: ws.labelKey,
    pages: (ws.id === "budgeting"
        ? [...flattenGroups(ws), ...GLOBAL_NAV_ITEMS]
        : flattenGroups(ws)
    ),
}));

/** Gmail-style go-to sequences: press `g`, then a destination key. Derived
 *  from `shortcutKey` in registry order; shared with ShortcutsOverlay so the
 *  help sheet stays truthful. */
export const GO_TO_ROUTES: ReadonlyArray<{
    key: string;
    url: string;
    titleKey: string;
}> = ALL_NAV_ITEMS.flatMap((item) =>
    item.shortcutKey
        ? [
              {
                  key: item.shortcutKey,
                  url: item.url,
                  titleKey: item.goToTitleKey ?? item.titleKey,
              },
          ]
        : [],
);

/** url → go-to key, so nav surfaces can display an entry's keyboard sequence. */
export const GO_TO_KEY_BY_URL: ReadonlyMap<string, string> = new Map(
    GO_TO_ROUTES.map((r) => [r.url, r.key]),
);

/** The three workspace section roots, in left-to-right cycle order. `[` / `]`
 *  step between them; shared with ShortcutsOverlay so the help stays truthful. */
export const SECTION_CYCLE: ReadonlyArray<{ url: string; titleKey: string }> =
    NAV_WORKSPACES.map((ws) => ({ url: ws.rootUrl, titleKey: ws.labelKey }));

/** Workspace root urls — active only on an exact match (they have children). */
export const WORKSPACE_ROOT_URLS: ReadonlySet<string> = new Set(
    NAV_WORKSPACES.map((ws) => ws.rootUrl),
);

/** Urls of workspace-agnostic pages: jumping to one keeps the current
 *  workspace (and its sidebar) instead of forcing a switch. */
export const WORKSPACE_AGNOSTIC_URLS: ReadonlySet<string> = new Set(
    GLOBAL_NAV_ITEMS.map((item) => item.url),
);

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
        const matches =
            route.url === "/"
                ? pathname === "/"
                : pathname === route.url ||
                  pathname.startsWith(route.url + "/");
        if (matches && (!best || route.url.length > best.url.length))
            best = route;
    }
    return best?.titleKey;
}
