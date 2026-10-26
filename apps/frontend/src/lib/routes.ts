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
 * follow any known path. A `:param` segment takes the type in `RouteParamTypes`,
 * so `/accounts/${accountId}` type-checks while `/accounts/${anyNumber}` and
 * `/acounts/${accountId}` do not. `useRouteParams` (hooks/useRouteParams) is the
 * inverse: it parses `useParams()` into those same types.
 */
import type { AccountId, Brand } from "@vision/types/brands";

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

/** Pathnames of param-free pages (the nav registry, icons, shortcuts). */
export type StaticAppPath = Exclude<RoutePattern, `${string}:${string}`>;

/** Branded id of a transaction import batch (`/import/:batchId/review`). */
export type ImportBatchId = Brand<number, "ImportBatchId">;
/** Branded id of a portfolio import batch (`/portfolio/import/:batchId/review`). */
export type PortfolioImportBatchId = Brand<number, "PortfolioImportBatchId">;

/** Unchecked constructors: the caller got the number from a validated API response. */
export const asImportBatchId = (id: number): ImportBatchId => id as ImportBatchId;
export const asPortfolioImportBatchId = (
    id: number,
): PortfolioImportBatchId => id as PortfolioImportBatchId;

/**
 * The type of each `:param` of a parameterised page. A param that is an id is
 * branded, so `/accounts/${id}` only type-checks with an `AccountId`; the
 * others accept any text (`:table` is a name, and the caller encodes it).
 * `hooks/useRouteParams` parses `useParams()` into these same types.
 */
export interface RouteParamTypes {
    [ROUTES.account]: { id: AccountId };
    [ROUTES.importReview]: { batchId: ImportBatchId };
    [ROUTES.portfolioImportReview]: { batchId: PortfolioImportBatchId };
    [ROUTES.adminDbTable]: { table: string };
}

type ParamType<P extends string, Name extends string> =
    P extends keyof RouteParamTypes
        ? Name extends keyof RouteParamTypes[P]
            ? RouteParamTypes[P][Name]
            : string
        : string;

/** `/accounts/:id` becomes `/accounts/${AccountId}`; patterns without params are unchanged. */
type FillParams<P extends string, Whole extends string = P> =
    P extends `${infer Head}:${infer Name}/${infer Tail}`
        ? `${Head}${ParamType<Whole, Name>}/${FillParams<Tail, Whole>}`
        : P extends `${infer Head}:${infer Name}`
          ? `${Head}${ParamType<Whole, Name>}`
          : P;

/** Every concrete pathname a page route can have, without query or fragment. */
export type AppPathname = RoutePattern extends infer P extends string
    ? P extends string
        ? FillParams<P, P>
        : never
    : never;

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
