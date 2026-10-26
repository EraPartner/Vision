import type { ComponentType } from "react";
import { LEGACY_ROUTES, ROUTES, type AppPathname, type RoutePattern } from "@/lib/routes";

type RouteLoader = () => Promise<{ default: ComponentType }>;

export interface AppRouteMetadata {
    path: RoutePattern;
    loader: RouteLoader;
    admin: boolean;
}

/** Ordered page-route source of truth for lazy loading, preloading, and admin gating. */
export const appRouteManifest = [
    { path: ROUTES.home, loader: () => import("@/pages/DashboardPage"), admin: false },
    {
        path: ROUTES.transactions,
        loader: () => import("@/pages/TransactionsPage"),
        admin: false,
    },
    {
        path: ROUTES.categories,
        loader: () => import("@/pages/CategoriesPage"),
        admin: false,
    },
    {
        path: ROUTES.accounts,
        loader: () => import("@/pages/AccountsPage"),
        admin: false,
    },
    {
        path: ROUTES.account,
        loader: () => import("@/pages/AccountDetailPage"),
        admin: false,
    },
    {
        path: ROUTES.analysis,
        loader: () => import("@/pages/AnalysisWorkspacePage"),
        admin: false,
    },
    {
        path: ROUTES.analysisMonitors,
        loader: () => import("@/pages/AnalysisMonitorsPage"),
        admin: false,
    },
    {
        path: ROUTES.recipients,
        loader: () => import("@/pages/RecipientsPage"),
        admin: false,
    },
    {
        path: ROUTES.planned,
        loader: () => import("@/pages/PlannedPaymentsPage"),
        admin: false,
    },
    {
        path: ROUTES.statistics,
        loader: () => import("@/pages/StatisticsPage"),
        admin: false,
    },
    {
        path: ROUTES.import,
        loader: () => import("@/pages/ImportPage"),
        admin: false,
    },
    {
        path: ROUTES.importReview,
        loader: () => import("@/pages/ImportReviewPage"),
        admin: false,
    },
    { path: ROUTES.owes, loader: () => import("@/pages/OwesPage"), admin: false },
    {
        path: ROUTES.tax,
        loader: () => import("@/pages/TaxOverviewPage"),
        admin: false,
    },
    {
        path: ROUTES.admin,
        loader: () => import("@/pages/admin/AdminOverviewPage"),
        admin: true,
    },
    {
        path: ROUTES.adminDb,
        loader: () => import("@/pages/DbMaintenancePage"),
        admin: true,
    },
    {
        path: ROUTES.adminDbTable,
        loader: () => import("@/pages/admin/TableDataEditorPage"),
        admin: true,
    },
    {
        path: ROUTES.adminProviders,
        loader: () => import("@/pages/admin/ProviderHealthPage"),
        admin: true,
    },
    {
        path: ROUTES.adminEndpoints,
        loader: () => import("@/pages/admin/EndpointLivenessPage"),
        admin: true,
    },
    {
        path: ROUTES.adminExchangeRates,
        loader: () => import("@/pages/admin/ExchangeRatesPage"),
        admin: true,
    },
    {
        path: ROUTES.portfolio,
        loader: () => import("@/pages/portfolio/PortfolioPage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioStocks,
        loader: () => import("@/pages/portfolio/StocksPage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioCrypto,
        loader: () => import("@/pages/portfolio/CryptoPage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioMetals,
        loader: () => import("@/pages/portfolio/MetalsPage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioRealEstate,
        loader: () => import("@/pages/portfolio/RealEstatePage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioSavings,
        loader: () => import("@/pages/portfolio/SavingsPage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioNetWorth,
        loader: () => import("@/pages/portfolio/net-worth/NetWorthPage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioImport,
        loader: () => import("@/pages/portfolio/PortfolioImportPage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioImportReview,
        loader: () => import("@/pages/portfolio/PortfolioImportReviewPage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioTax,
        loader: () => import("@/pages/portfolio/tax/PortfolioTaxPage"),
        admin: false,
    },
    {
        path: ROUTES.portfolioRebalance,
        loader: () => import("@/pages/portfolio/RebalancePage"),
        admin: false,
    },
    {
        path: ROUTES.research,
        loader: () => import("@/pages/research/ResearchHomePage"),
        admin: false,
    },
    {
        path: ROUTES.researchMarkets,
        loader: () => import("@/pages/research/MarketOverviewPage"),
        admin: false,
    },
    {
        path: ROUTES.researchMarket,
        loader: () => import("@/pages/research/MarketLookupPage"),
        admin: false,
    },
    {
        path: ROUTES.researchWatchlist,
        loader: () => import("@/pages/research/WatchlistPage"),
        admin: false,
    },
    {
        path: ROUTES.researchCompare,
        loader: () => import("@/pages/research/ResearchComparePage"),
        admin: false,
    },
    {
        path: ROUTES.researchForecast,
        loader: () => import("@/pages/research/PortfolioForecastPage"),
        admin: false,
    },
    {
        path: ROUTES.researchCharts,
        loader: () => import("@/pages/research/ChartBuilderPage"),
        admin: false,
    },
    {
        path: ROUTES.researchDossiers,
        loader: () => import("@/pages/research/ResearchDossiersPage"),
        admin: false,
    },
    {
        path: ROUTES.aiChat,
        loader: () => import("@/pages/AIChatPage"),
        admin: false,
    },
] satisfies readonly AppRouteMetadata[];

/**
 * Former page paths that now live elsewhere. `App.tsx` renders each as a
 * redirect that keeps the query string, so saved deep links keep working
 * (`/portfolio/performance?period=1y` → `/portfolio?period=1y`).
 */
export const legacyRouteRedirects: ReadonlyArray<{ from: string; to: AppPathname }> = [
    { from: LEGACY_ROUTES.portfolioPerformance, to: ROUTES.portfolio },
];

/** Path lookup derived from the manifest for sidebar hover preloading. */
export const routeLoaders: Record<string, RouteLoader> = Object.fromEntries(
    appRouteManifest.map(({ path, loader }) => [path, loader]),
);

const preloaded = new Set<string>();

/** Fire-and-forget chunk warmup; failures are ignored (the route's lazy()
 *  import will retry and surface errors through the normal path). */
export function preloadRoute(url: string): void {
    const loader = routeLoaders[url];
    if (!loader || preloaded.has(url)) return;
    preloaded.add(url);
    loader().catch(() => {
        preloaded.delete(url);
    });
}
