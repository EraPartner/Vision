import type { ComponentType } from "react";

type RouteLoader = () => Promise<{ default: ComponentType }>;

export interface AppRouteMetadata {
    path: string;
    loader: RouteLoader;
    admin: boolean;
}

/** Ordered page-route source of truth for lazy loading, preloading, and admin gating. */
export const appRouteManifest = [
    { path: "/", loader: () => import("@/pages/DashboardPage"), admin: false },
    {
        path: "/transactions",
        loader: () => import("@/pages/TransactionsPage"),
        admin: false,
    },
    {
        path: "/categories",
        loader: () => import("@/pages/CategoriesPage"),
        admin: false,
    },
    {
        path: "/accounts",
        loader: () => import("@/pages/AccountsPage"),
        admin: false,
    },
    {
        path: "/accounts/:id",
        loader: () => import("@/pages/AccountDetailPage"),
        admin: false,
    },
    {
        path: "/recipients",
        loader: () => import("@/pages/RecipientsPage"),
        admin: false,
    },
    {
        path: "/planned",
        loader: () => import("@/pages/PlannedPaymentsPage"),
        admin: false,
    },
    {
        path: "/statistics",
        loader: () => import("@/pages/StatisticsPage"),
        admin: false,
    },
    {
        path: "/import",
        loader: () => import("@/pages/ImportPage"),
        admin: false,
    },
    {
        path: "/import/:batchId/review",
        loader: () => import("@/pages/ImportReviewPage"),
        admin: false,
    },
    { path: "/owes", loader: () => import("@/pages/OwesPage"), admin: false },
    {
        path: "/tax",
        loader: () => import("@/pages/TaxOverviewPage"),
        admin: false,
    },
    {
        path: "/admin",
        loader: () => import("@/pages/admin/AdminOverviewPage"),
        admin: true,
    },
    {
        path: "/admin/db",
        loader: () => import("@/pages/DbMaintenancePage"),
        admin: true,
    },
    {
        path: "/admin/db/:table",
        loader: () => import("@/pages/admin/TableDataEditorPage"),
        admin: true,
    },
    {
        path: "/admin/providers",
        loader: () => import("@/pages/admin/ProviderHealthPage"),
        admin: true,
    },
    {
        path: "/admin/endpoints",
        loader: () => import("@/pages/admin/EndpointLivenessPage"),
        admin: true,
    },
    {
        path: "/admin/exchange-rates",
        loader: () => import("@/pages/admin/ExchangeRatesPage"),
        admin: true,
    },
    {
        path: "/portfolio",
        loader: () => import("@/pages/portfolio/PortfolioOverviewPage"),
        admin: false,
    },
    {
        path: "/portfolio/stocks",
        loader: () => import("@/pages/portfolio/StocksPage"),
        admin: false,
    },
    {
        path: "/portfolio/crypto",
        loader: () => import("@/pages/portfolio/CryptoPage"),
        admin: false,
    },
    {
        path: "/portfolio/metals",
        loader: () => import("@/pages/portfolio/MetalsPage"),
        admin: false,
    },
    {
        path: "/portfolio/real-estate",
        loader: () => import("@/pages/portfolio/RealEstatePage"),
        admin: false,
    },
    {
        path: "/portfolio/savings",
        loader: () => import("@/pages/portfolio/SavingsPage"),
        admin: false,
    },
    {
        path: "/portfolio/performance",
        loader: () => import("@/pages/portfolio/PerformancePage"),
        admin: false,
    },
    {
        path: "/portfolio/net-worth",
        loader: () => import("@/pages/portfolio/net-worth/NetWorthPage"),
        admin: false,
    },
    {
        path: "/portfolio/import",
        loader: () => import("@/pages/portfolio/PortfolioImportPage"),
        admin: false,
    },
    {
        path: "/portfolio/import/:batchId/review",
        loader: () => import("@/pages/portfolio/PortfolioImportReviewPage"),
        admin: false,
    },
    {
        path: "/portfolio/tax",
        loader: () => import("@/pages/portfolio/tax/PortfolioTaxPage"),
        admin: false,
    },
    {
        path: "/portfolio/rebalance",
        loader: () => import("@/pages/portfolio/RebalancePage"),
        admin: false,
    },
    {
        path: "/research",
        loader: () => import("@/pages/research/ResearchHomePage"),
        admin: false,
    },
    {
        path: "/research/markets",
        loader: () => import("@/pages/research/MarketOverviewPage"),
        admin: false,
    },
    {
        path: "/research/market",
        loader: () => import("@/pages/research/MarketLookupPage"),
        admin: false,
    },
    {
        path: "/research/watchlist",
        loader: () => import("@/pages/research/WatchlistPage"),
        admin: false,
    },
    {
        path: "/research/compare",
        loader: () => import("@/pages/research/ResearchComparePage"),
        admin: false,
    },
    {
        path: "/research/forecast",
        loader: () => import("@/pages/research/PortfolioForecastPage"),
        admin: false,
    },
    {
        path: "/research/charts",
        loader: () => import("@/pages/research/ChartBuilderPage"),
        admin: false,
    },
    {
        path: "/ai-chat",
        loader: () => import("@/pages/AIChatPage"),
        admin: false,
    },
] satisfies readonly AppRouteMetadata[];

/** Path lookup derived from the manifest for sidebar hover preloading. */
export const routeLoaders: Record<string, RouteLoader> = Object.fromEntries(
    appRouteManifest.map(({ path, loader }) => [path, loader]),
);

const preloaded = new Set<string>();

/** Fire-and-forget chunk warmup; failures are ignored (the route's lazy()
 *  import will retry and surface errors through the normal path). */
export function preloadRoute(url: string): void {
    const loader = routeLoaders[url as keyof typeof routeLoaders];
    if (!loader || preloaded.has(url)) return;
    preloaded.add(url);
    loader().catch(() => {
        preloaded.delete(url);
    });
}
