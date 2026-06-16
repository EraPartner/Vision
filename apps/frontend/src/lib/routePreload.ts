/**
 * Route-chunk loaders, keyed by route path. Shared by App.tsx (lazy() route
 * definitions) and AppSidebar (hover prefetch), so hovering a nav item warms
 * the same chunk the router will request on click.
 */

export const routeLoaders = {
    "/": () => import("@/pages/DashboardPage"),
    "/transactions": () => import("@/pages/TransactionsPage"),
    "/categories": () => import("@/pages/CategoriesPage"),
    "/recipients": () => import("@/pages/RecipientsPage"),
    "/planned": () => import("@/pages/PlannedPaymentsPage"),
    "/statistics": () => import("@/pages/StatisticsPage"),
    "/import": () => import("@/pages/ImportPage"),
    "/import/:batchId/review": () => import("@/pages/ImportReviewPage"),
    "/owes": () => import("@/pages/OwesPage"),
    "/tax": () => import("@/pages/TaxOverviewPage"),
    "/admin": () => import("@/pages/admin/AdminOverviewPage"),
    "/admin/db": () => import("@/pages/DbMaintenancePage"),
    "/admin/providers": () => import("@/pages/admin/ProviderHealthPage"),
    "/admin/endpoints": () => import("@/pages/admin/EndpointLivenessPage"),
    "/portfolio": () => import("@/pages/portfolio/PortfolioOverviewPage"),
    "/portfolio/stocks": () => import("@/pages/portfolio/StocksPage"),
    "/portfolio/crypto": () => import("@/pages/portfolio/CryptoPage"),
    "/portfolio/metals": () => import("@/pages/portfolio/MetalsPage"),
    "/portfolio/real-estate": () => import("@/pages/portfolio/RealEstatePage"),
    "/portfolio/savings": () => import("@/pages/portfolio/SavingsPage"),
    "/portfolio/performance": () => import("@/pages/portfolio/PerformancePage"),
    "/portfolio/net-worth": () => import("@/pages/portfolio/net-worth/NetWorthPage"),
    "/admin/exchange-rates": () => import("@/pages/admin/ExchangeRatesPage"),
    "/portfolio/import": () => import("@/pages/portfolio/PortfolioImportPage"),
    "/portfolio/import/:batchId/review": () => import("@/pages/portfolio/PortfolioImportReviewPage"),
    "/portfolio/tax": () => import("@/pages/portfolio/tax/PortfolioTaxPage"),
    "/research": () => import("@/pages/research/ResearchHomePage"),
    "/research/market": () => import("@/pages/research/MarketLookupPage"),
    "/research/watchlist": () => import("@/pages/research/WatchlistPage"),
    "/research/symbol/:symbol": () => import("@/pages/research/ResearchSymbolPage"),
    "/research/compare": () => import("@/pages/research/ResearchComparePage"),
    "/ai-chat": () => import("@/pages/AIChatPage"),
} as const;

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
