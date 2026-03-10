import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { AppSettingsProvider } from "@/contexts/AppSettingsContext";
import { ThemeProvider } from "@/contexts/ThemeContext";

import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";

// Lazy-loaded pages for code splitting
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const TransactionsPage = lazy(() => import("./pages/TransactionsPage"));
const CategoriesPage = lazy(() => import("./pages/CategoriesPage"));
const RecipientsPage = lazy(() => import("./pages/RecipientsPage"));
const ImportPage = lazy(() => import("./pages/ImportPage"));
const PlannedPaymentsPage = lazy(() => import("./pages/PlannedPaymentsPage"));
const StatisticsPage = lazy(() => import("./pages/StatisticsPage"));
const PortfolioOverviewPage = lazy(() => import("./pages/portfolio/PortfolioOverviewPage"));
const MarketLookupPage = lazy(() => import("./pages/MarketLookupPage"));
const StocksPage = lazy(() => import("./pages/portfolio/StocksPage"));
const CryptoPage = lazy(() => import("./pages/portfolio/CryptoPage"));
const RealEstatePage = lazy(() => import("./pages/portfolio/RealEstatePage"));
const SavingsPage = lazy(() => import("./pages/portfolio/SavingsPage"));
const PerformancePage = lazy(() => import("./pages/portfolio/PerformancePage"));
const NetWorthPage = lazy(() => import("./pages/portfolio/NetWorthPage"));
const ExchangeRatesPage = lazy(() => import("./pages/portfolio/ExchangeRatesPage"));
const WatchlistPage = lazy(() => import("./pages/portfolio/WatchlistPage"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,        // 30s before data considered stale
            gcTime: 5 * 60_000,       // 5min garbage collection
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
});

function PageLoader() {
    return (
        <div className="flex items-center justify-center h-96">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
    );
}

const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
            <ThemeProvider>
                <SettingsProvider>
                    <AppSettingsProvider>
                        <TooltipProvider>
                            <ErrorBoundary>
                                <Toaster />
                                <Sonner />
                                <BrowserRouter
                                    future={{
                                        v7_startTransition: true,
                                        v7_relativeSplatPath: true,
                                    }}
                                >
                                    <AppLayout>
                                        <Suspense fallback={<PageLoader />}>
                                            <Routes>
                                                {/* Budgeting */}
                                                <Route path="/" element={<DashboardPage />} />
                                                <Route path="/transactions" element={<TransactionsPage />} />
                                                <Route path="/categories" element={<CategoriesPage />} />
                                                <Route path="/recipients" element={<RecipientsPage />} />
                                                <Route path="/planned" element={<PlannedPaymentsPage />} />
                                                <Route path="/statistics" element={<StatisticsPage />} />
                                                <Route path="/import" element={<ImportPage />} />
                                                {/* Portfolio */}
                                                <Route path="/portfolio" element={<PortfolioOverviewPage />} />
                                                <Route path="/portfolio/market" element={<MarketLookupPage />} />
                                                <Route path="/portfolio/stocks" element={<StocksPage />} />
                                                <Route path="/portfolio/crypto" element={<CryptoPage />} />
                                                <Route path="/portfolio/real-estate" element={<RealEstatePage />} />
                                                <Route path="/portfolio/savings" element={<SavingsPage />} />
                                                <Route path="/portfolio/performance" element={<PerformancePage />} />
                                                <Route path="/portfolio/net-worth" element={<NetWorthPage />} />
                                                <Route path="/portfolio/exchange-rates" element={<ExchangeRatesPage />} />
                                                <Route path="/portfolio/watchlist" element={<WatchlistPage />} />
                                                <Route path="*" element={<NotFound />} />
                                            </Routes>
                                        </Suspense>
                                    </AppLayout>
                                </BrowserRouter>
                            </ErrorBoundary>
                        </TooltipProvider>
                    </AppSettingsProvider>
                </SettingsProvider>
            </ThemeProvider>
        </QueryClientProvider>
    );
};

export default App;
