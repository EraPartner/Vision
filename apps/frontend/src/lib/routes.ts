/**
 * Typed route table: the single source of truth for in-app URLs.
 *
 * `ROUTES` holds every page pattern (react-router syntax). The router manifest
 * (`lib/routePreload`) declares its `path`s from these constants, and `AppPath`
 * is derived from the same table at the type level, so a typo'd or removed
 * route fails to compile at every `useAppNavigate()`, `<AppLink to>`,
 * `<AppNavigate>` and nav-registry call site instead of 404-ing at runtime.
 *
 * Only the path part is typed: a query string (`?x=1`) or fragment (`#id`) may
 * follow any known path. A `:param` segment accepts any text, so
 * `/accounts/${id}` type-checks while `/acounts/${id}` does not.
 */
export const ROUTES = {
    home: "/",
    transactions: "/transactions",
    categories: "/categories",
    accounts: "/accounts",
    account: "/accounts/:id",
    analysis: "/analysis",
    analysisMonitors: "/analysis/monitors",
    recipients: "/recipients",
    planned: "/planned",
    statistics: "/statistics",
    import: "/import",
    importReview: "/import/:batchId/review",
    owes: "/owes",
    tax: "/tax",
    admin: "/admin",
    adminDb: "/admin/db",
    adminDbTable: "/admin/db/:table",
    adminProviders: "/admin/providers",
    adminEndpoints: "/admin/endpoints",
    adminExchangeRates: "/admin/exchange-rates",
    portfolio: "/portfolio",
    portfolioStocks: "/portfolio/stocks",
    portfolioCrypto: "/portfolio/crypto",
    portfolioMetals: "/portfolio/metals",
    portfolioRealEstate: "/portfolio/real-estate",
    portfolioSavings: "/portfolio/savings",
    portfolioNetWorth: "/portfolio/net-worth",
    portfolioImport: "/portfolio/import",
    portfolioImportReview: "/portfolio/import/:batchId/review",
    portfolioTax: "/portfolio/tax",
    portfolioRebalance: "/portfolio/rebalance",
    research: "/research",
    researchMarkets: "/research/markets",
    researchMarket: "/research/market",
    researchWatchlist: "/research/watchlist",
    researchCompare: "/research/compare",
    researchForecast: "/research/forecast",
    researchCharts: "/research/charts",
    researchDossiers: "/research/dossiers",
    aiChat: "/ai-chat",
} as const;

/** Retired page paths that still redirect (see `legacyRouteRedirects`). */
export const LEGACY_ROUTES = {
    portfolioPerformance: "/portfolio/performance",
} as const;

/** A react-router pattern of a real page (`/accounts/:id`). */
export type RoutePattern = (typeof ROUTES)[keyof typeof ROUTES];

/** `/accounts/:id` becomes `/accounts/${string}`; patterns without params are unchanged. */
type FillParams<P extends string> = P extends `${infer Head}:${infer Rest}`
    ? Rest extends `${string}/${infer Tail}`
        ? `${Head}${string}/${FillParams<Tail>}`
        : `${Head}${string}`
    : P;

/** Every concrete pathname a page route can have, without query or fragment. */
export type AppPathname = FillParams<RoutePattern>;

/** Pathnames of param-free pages (the nav registry, icons, shortcuts). */
export type StaticAppPath = Exclude<RoutePattern, `${string}:${string}`>;

/** A navigable in-app target: a known pathname, optionally with `?query` or `#hash`. */
export type AppPath =
    | AppPathname
    | `${AppPathname}?${string}`
    | `${AppPathname}#${string}`;

const PATTERN_REGEXES: ReadonlyArray<RegExp> = [
    ...Object.values(ROUTES),
    ...Object.values(LEGACY_ROUTES),
].map((pattern) => new RegExp(`^${pattern.replace(/:[^/]+/g, "[^/]+")}/?$`));

/**
 * Runtime guard for paths that arrive as plain strings (native menu payloads,
 * the persisted "last page"): true when the pathname matches a page route.
 */
export function isAppPath(value: unknown): value is AppPath {
    if (typeof value !== "string" || !value.startsWith("/")) return false;
    const pathname = value.split(/[?#]/, 1)[0] ?? "";
    return PATTERN_REGEXES.some((re) => re.test(pathname));
}
