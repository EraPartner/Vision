import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";
import { AppSettingsProvider, useAppSettings } from "@/contexts/AppSettingsContext";
import { BelgianTaxProfileProvider } from "@/contexts/BelgianTaxProfileContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { LanguageProvider, type Language } from "@/contexts/LanguageContext";
import { configureCurrencyFormatDefaults, numberFormatToLocale } from "@/utils/currency";

import { lazy, Suspense, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { ScrollToTop } from "@/components/shared/ScrollToTop";
import { RequireAdmin } from "@/components/auth/RequireAdmin";
import TaxOverviewPage from "@/pages/TaxOverviewPage.tsx";
import PortfolioTaxPage from "@/pages/portfolio/tax/PortfolioTaxPage";

// Lazy-loaded pages for code splitting
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const TransactionsPage = lazy(() => import("./pages/TransactionsPage"));
const CategoriesPage = lazy(() => import("./pages/CategoriesPage"));
const RecipientsPage = lazy(() => import("./pages/RecipientsPage"));
const ImportPage = lazy(() => import("./pages/ImportPage"));
const ImportReviewPage = lazy(() => import("./pages/ImportReviewPage"));
const PlannedPaymentsPage = lazy(() => import("./pages/PlannedPaymentsPage"));
const StatisticsPage = lazy(() => import("./pages/StatisticsPage"));
const OwesPage = lazy(() => import("./pages/OwesPage"));
const PortfolioOverviewPage = lazy(() => import("./pages/portfolio/PortfolioOverviewPage"));
const MarketLookupPage = lazy(() => import("./pages/MarketLookupPage"));
const StocksPage = lazy(() => import("./pages/portfolio/StocksPage"));
const CryptoPage = lazy(() => import("./pages/portfolio/CryptoPage"));
const MetalsPage = lazy(() => import("./pages/portfolio/MetalsPage"));
const RealEstatePage = lazy(() => import("./pages/portfolio/RealEstatePage"));
const SavingsPage = lazy(() => import("./pages/portfolio/SavingsPage"));
const PerformancePage = lazy(() => import("./pages/portfolio/PerformancePage"));
const NetWorthPage = lazy(() => import("./pages/portfolio/net-worth/NetWorthPage"));
const ExchangeRatesPage = lazy(() => import("./pages/portfolio/ExchangeRatesPage"));
const WatchlistPage = lazy(() => import("./pages/portfolio/WatchlistPage"));
const DbMaintenancePage = lazy(() => import("./pages/DbMaintenancePage"));
const AdminOverviewPage = lazy(() => import("./pages/admin/AdminOverviewPage"));
const ProviderHealthPage = lazy(() => import("./pages/admin/ProviderHealthPage"));
const EndpointLivenessPage = lazy(() => import("./pages/admin/EndpointLivenessPage"));
const AIChatPage = lazy(() => import("./pages/AIChatPage"));
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
            <div className="flex flex-col items-center gap-4">
                <div className="relative">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    </div>
                </div>
                <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>
            </div>
        </div>
    );
}

// Bridge: reads language from AppSettings and provides it to LanguageContext
function LanguageBridge({ children }: { children: React.ReactNode }) {
    const { appSettings, updateAppSettings } = useAppSettings();
    const language: Language = (appSettings.language as Language) ?? 'en';
    const setLanguage = (lang: Language) => updateAppSettings({ language: lang });

    useEffect(() => {
        configureCurrencyFormatDefaults({
            defaultCurrency: appSettings.defaultCurrency,
            locale: numberFormatToLocale(appSettings.numberFormat),
            fractionDigits: appSettings.showDecimalPlaces,
        });
    }, [appSettings.defaultCurrency, appSettings.numberFormat, appSettings.showDecimalPlaces]);

    return (
        <LanguageProvider language={language} setLanguage={setLanguage}>
            {children}
        </LanguageProvider>
    );
}

const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
            <SettingsPreloadProvider>
                <ThemeProvider>
                    <SettingsProvider>
                        <AppSettingsProvider>
                            <BelgianTaxProfileProvider>
                                <LanguageBridge>
                                    <TooltipProvider>
                                    <ErrorBoundary>
                                        <Sonner />
                                        <BrowserRouter
                                            future={{
                                                v7_startTransition: true,
                                                v7_relativeSplatPath: true,
                                            }}
                                        >
                                            <ScrollToTop />
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
                                                    <Route path="/import/:batchId/review" element={<ImportReviewPage />} />
                                                    <Route path="/owes" element={<OwesPage />} />
                                                    <Route path="/tax" element={<TaxOverviewPage />} />
                                                    <Route path="/admin" element={<RequireAdmin><AdminOverviewPage /></RequireAdmin>} />
                                                    <Route path="/admin/db" element={<RequireAdmin><DbMaintenancePage /></RequireAdmin>} />
                                                    <Route path="/admin/providers" element={<RequireAdmin><ProviderHealthPage /></RequireAdmin>} />
                                                    <Route path="/admin/endpoints" element={<RequireAdmin><EndpointLivenessPage /></RequireAdmin>} />
                                                    {/* Portfolio */}
                                                    <Route path="/portfolio" element={<PortfolioOverviewPage />} />
                                                    <Route path="/portfolio/market" element={<MarketLookupPage />} />
                                                    <Route path="/portfolio/stocks" element={<StocksPage />} />
                                                    <Route path="/portfolio/crypto" element={<CryptoPage />} />
                                                    <Route path="/portfolio/metals" element={<MetalsPage />} />
                                                    <Route path="/portfolio/real-estate" element={<RealEstatePage />} />
                                                    <Route path="/portfolio/savings" element={<SavingsPage />} />
                                                    <Route path="/portfolio/performance" element={<PerformancePage />} />
                                                    <Route path="/portfolio/net-worth" element={<NetWorthPage />} />
                                                    <Route path="/portfolio/exchange-rates" element={<ExchangeRatesPage />} />
                                                    <Route path="/portfolio/watchlist" element={<WatchlistPage />} />
                                                    <Route path="/portfolio/tax" element={<PortfolioTaxPage />} />
                                                    {/* AI Chat (workspace-agnostic) */}
                                                    <Route path="/ai-chat" element={<AIChatPage />} />
                                                    <Route path="*" element={<NotFound />} />
                                                    </Routes>
                                                </Suspense>
                                            </AppLayout>
                                        </BrowserRouter>
                                    </ErrorBoundary>
                                    </TooltipProvider>
                                </LanguageBridge>
                            </BelgianTaxProfileProvider>
                        </AppSettingsProvider>
                    </SettingsProvider>
                </ThemeProvider>
            </SettingsPreloadProvider>
        </QueryClientProvider>
    );
};

export default App;
