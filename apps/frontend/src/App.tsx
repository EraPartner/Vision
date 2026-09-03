import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion } from "framer-motion";
import {
    Navigate,
    Route,
    RouterProvider,
    Routes,
    createBrowserRouter,
    useLocation,
    useParams,
} from "react-router";
import { AppLayout } from "@/components/layout/AppLayout";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";
import {
    AppSettingsProvider,
    SettingsSaveErrorToaster,
    useAppSettings,
} from "@/contexts/AppSettingsContext";
import {
    BelgianTaxProfileProvider,
    BelgianTaxSaveErrorToaster,
} from "@/contexts/BelgianTaxProfileContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { LanguageProvider, type Language } from "@/contexts/LanguageContext";
import { lazy, Suspense, useCallback, useEffect, type ReactNode } from "react";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { GlobalMutationErrorToaster } from "@/components/shared/GlobalMutationErrorToaster";
import { ScrollToTop } from "@/components/shared/ScrollToTop";
import { StartupRedirect } from "@/components/shared/StartupRedirect";
import { PageLoader } from "@/components/shared/PageLoader";
import { RequireAdmin } from "@/components/auth/RequireAdmin";

import { useSettingsStore } from "@/stores/settingsStore";

// Lazy-loaded pages for code splitting. Loaders live in lib/routePreload so
// sidebar hover can warm the same chunks the router requests on click.
import { routeLoaders } from "@/lib/routePreload";
import { loadMotionFeatures } from "@/lib/motionFeatures";
import { LOCAL_STORAGE_KEYS } from "@/lib/localStorage-keys";
import { setNativeLanguage } from "@/lib/api/electron";
import { UnsavedChangesProvider } from "@/contexts/UnsavedChangesContext";

const TaxOverviewPage = lazy(routeLoaders["/tax"]);
const PortfolioTaxPage = lazy(routeLoaders["/portfolio/tax"]);
const RebalancePage = lazy(routeLoaders["/portfolio/rebalance"]);
const DashboardPage = lazy(routeLoaders["/"]);
const TransactionsPage = lazy(routeLoaders["/transactions"]);
const CategoriesPage = lazy(routeLoaders["/categories"]);
const AccountsPage = lazy(routeLoaders["/accounts"]);
const AccountDetailPage = lazy(routeLoaders["/accounts/:id"]);
const RecipientsPage = lazy(routeLoaders["/recipients"]);
const ImportPage = lazy(routeLoaders["/import"]);
const ImportReviewPage = lazy(routeLoaders["/import/:batchId/review"]);
const PlannedPaymentsPage = lazy(routeLoaders["/planned"]);
const StatisticsPage = lazy(routeLoaders["/statistics"]);
const OwesPage = lazy(routeLoaders["/owes"]);
const PortfolioOverviewPage = lazy(routeLoaders["/portfolio"]);
const StocksPage = lazy(routeLoaders["/portfolio/stocks"]);
const CryptoPage = lazy(routeLoaders["/portfolio/crypto"]);
const MetalsPage = lazy(routeLoaders["/portfolio/metals"]);
const RealEstatePage = lazy(routeLoaders["/portfolio/real-estate"]);
const SavingsPage = lazy(routeLoaders["/portfolio/savings"]);
const PerformancePage = lazy(routeLoaders["/portfolio/performance"]);
const NetWorthPage = lazy(routeLoaders["/portfolio/net-worth"]);
const ExchangeRatesPage = lazy(routeLoaders["/admin/exchange-rates"]);
const PortfolioImportPage = lazy(routeLoaders["/portfolio/import"]);
const PortfolioImportReviewPage = lazy(
    routeLoaders["/portfolio/import/:batchId/review"],
);
const DbMaintenancePage = lazy(routeLoaders["/admin/db"]);
const TableDataEditorPage = lazy(routeLoaders["/admin/db/:table"]);
const AdminOverviewPage = lazy(routeLoaders["/admin"]);
const ProviderHealthPage = lazy(routeLoaders["/admin/providers"]);
const EndpointLivenessPage = lazy(routeLoaders["/admin/endpoints"]);
const AIChatPage = lazy(routeLoaders["/ai-chat"]);
const ResearchHomePage = lazy(routeLoaders["/research"]);
const MarketOverviewPage = lazy(routeLoaders["/research/markets"]);
const MarketLookupPage = lazy(routeLoaders["/research/market"]);
const WatchlistPage = lazy(routeLoaders["/research/watchlist"]);
const ResearchComparePage = lazy(routeLoaders["/research/compare"]);
const PortfolioForecastPage = lazy(routeLoaders["/research/forecast"]);
const ChartBuilderPage = lazy(routeLoaders["/research/charts"]);
const NotFound = lazy(() => import("./pages/NotFound"));

// Devtools (API Inspector). Lazily loaded as a separate chunk that is only
// fetched when actually rendered, so it costs normal users nothing on load.
// Shown when ANY of:
//   • local Vite dev server (import.meta.env.DEV), or
//   • Docker dev build (VITE_DEVTOOLS=true via docker-compose.dev.yml), or
//   • the user enables Admin Mode at runtime — which is the only path that
//     works in the packaged Electron app and public release image, since those
//     run a normally-built bundle with no VITE_DEVTOOLS build arg.
const isDevtoolsBuildEnabled =
    import.meta.env.DEV || import.meta.env.VITE_DEVTOOLS === "true";
const DevtoolsRoot = lazy(() =>
    import("@/components/devtools/DevtoolsRoot").then((m) => ({
        default: m.DevtoolsRoot,
    })),
);

// Renders the devtools when build-enabled or when Admin Mode is on. Reads the
// Zustand store directly (no provider needed) so it works above the settings
// context providers where the devtools mount.
function DevtoolsGate() {
    const adminMode = useSettingsStore((s) => s.appSettings.adminMode);
    if (!isDevtoolsBuildEnabled && !adminMode) return null;
    return (
        <Suspense fallback={null}>
            <DevtoolsRoot />
        </Suspense>
    );
}

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000, // 30s before data considered stale
            gcTime: 5 * 60_000, // 5min garbage collection
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
});

// Bridge: reads language from AppSettings and provides it to LanguageContext
function LanguageBridge({ children }: { children: React.ReactNode }) {
    const { appSettings, updateAppSettings } = useAppSettings();
    const language: Language = (appSettings.language as Language) ?? "en";
    // `updateAppSettings` (zustand action) is referentially stable, so this
    // callback identity stays stable across settings changes — otherwise every
    // unrelated settings toggle would re-publish the LanguageContext value and
    // re-render every `useLanguage` consumer app-wide.
    const setLanguage = useCallback(
        (lang: Language) => updateAppSettings({ language: lang }),
        [updateAppSettings],
    );

    // Mirror the active language to localStorage so the next cold boot can start
    // the correct locale chunk during entry execution (see LanguageContext),
    // instead of waiting behind the settings API round trip.
    useEffect(() => {
        try {
            localStorage.setItem(LOCAL_STORAGE_KEYS.LANGUAGE, language);
        } catch {
            // localStorage unavailable — locale prefetch falls back to English.
        }
        setNativeLanguage(language);
    }, [language]);

    return (
        <LanguageProvider language={language} setLanguage={setLanguage}>
            {children}
        </LanguageProvider>
    );
}

// Per-route error boundary, keyed by pathname. Keying remounts the boundary on
// every navigation, so (a) a crash on one page is automatically cleared when the
// user navigates elsewhere, and (b) being nested inside AppLayout, a page crash
// replaces only the content area — the nav shell stays interactive. The outer
// app-level <ErrorBoundary> remains the last-resort catch for the shell itself.
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>;
}

// Redirect a relocated route to its new path, preserving the query string so
// deep-links (e.g. /portfolio/market?symbol=AAPL&investmentId=3) survive the
// ADR-079 Research move.
function RedirectWithQuery({ to }: { to: string }) {
    const { search } = useLocation();
    return <Navigate to={`${to}${search}`} replace />;
}

// The standalone research symbol page was retired in favour of Market Lookup as
// the single security-detail surface. Old /research/symbol/:symbol links (and
// holding deep-links carrying ?investmentId=) redirect into the ?symbol= form.
function RedirectSymbolToMarket() {
    const { symbol } = useParams<{ symbol: string }>();
    const { search } = useLocation();
    const params = new URLSearchParams(search);
    if (symbol) params.set("symbol", symbol);
    return <Navigate to={`/research/market?${params.toString()}`} replace />;
}

function RouterSurface() {
    return (
        <UnsavedChangesProvider>
            <ScrollToTop />
            <StartupRedirect />
            <AppLayout>
                <RoutedErrorBoundary>
                    <Suspense fallback={<PageLoader />}>
                        <Routes>
                            {/* Budgeting */}
                            <Route path="/" element={<DashboardPage />} />
                            <Route
                                path="/transactions"
                                element={<TransactionsPage />}
                            />
                            <Route
                                path="/categories"
                                element={<CategoriesPage />}
                            />
                            <Route
                                path="/accounts"
                                element={<AccountsPage />}
                            />
                            <Route
                                path="/accounts/:id"
                                element={<AccountDetailPage />}
                            />
                            <Route
                                path="/recipients"
                                element={<RecipientsPage />}
                            />
                            <Route
                                path="/planned"
                                element={<PlannedPaymentsPage />}
                            />
                            <Route
                                path="/statistics"
                                element={<StatisticsPage />}
                            />
                            <Route path="/import" element={<ImportPage />} />
                            <Route
                                path="/import/:batchId/review"
                                element={<ImportReviewPage />}
                            />
                            <Route path="/owes" element={<OwesPage />} />
                            <Route path="/tax" element={<TaxOverviewPage />} />
                            <Route
                                path="/admin"
                                element={
                                    <RequireAdmin>
                                        <AdminOverviewPage />
                                    </RequireAdmin>
                                }
                            />
                            <Route
                                path="/admin/db"
                                element={
                                    <RequireAdmin>
                                        <DbMaintenancePage />
                                    </RequireAdmin>
                                }
                            />
                            <Route
                                path="/admin/db/:table"
                                element={
                                    <RequireAdmin>
                                        <TableDataEditorPage />
                                    </RequireAdmin>
                                }
                            />
                            <Route
                                path="/admin/providers"
                                element={
                                    <RequireAdmin>
                                        <ProviderHealthPage />
                                    </RequireAdmin>
                                }
                            />
                            <Route
                                path="/admin/endpoints"
                                element={
                                    <RequireAdmin>
                                        <EndpointLivenessPage />
                                    </RequireAdmin>
                                }
                            />
                            <Route
                                path="/admin/exchange-rates"
                                element={
                                    <RequireAdmin>
                                        <ExchangeRatesPage />
                                    </RequireAdmin>
                                }
                            />
                            {/* Portfolio */}
                            <Route
                                path="/portfolio"
                                element={<PortfolioOverviewPage />}
                            />
                            <Route
                                path="/portfolio/stocks"
                                element={<StocksPage />}
                            />
                            <Route
                                path="/portfolio/crypto"
                                element={<CryptoPage />}
                            />
                            <Route
                                path="/portfolio/metals"
                                element={<MetalsPage />}
                            />
                            <Route
                                path="/portfolio/real-estate"
                                element={<RealEstatePage />}
                            />
                            <Route
                                path="/portfolio/savings"
                                element={<SavingsPage />}
                            />
                            <Route
                                path="/portfolio/performance"
                                element={<PerformancePage />}
                            />
                            <Route
                                path="/portfolio/rebalance"
                                element={<RebalancePage />}
                            />
                            <Route
                                path="/portfolio/net-worth"
                                element={<NetWorthPage />}
                            />
                            <Route
                                path="/portfolio/exchange-rates"
                                element={
                                    <Navigate
                                        to="/admin/exchange-rates"
                                        replace
                                    />
                                }
                            />
                            <Route
                                path="/portfolio/import"
                                element={<PortfolioImportPage />}
                            />
                            <Route
                                path="/portfolio/import/:batchId/review"
                                element={<PortfolioImportReviewPage />}
                            />
                            <Route
                                path="/portfolio/tax"
                                element={<PortfolioTaxPage />}
                            />
                            {/* Research (ADR-079) */}
                            <Route
                                path="/research"
                                element={<ResearchHomePage />}
                            />
                            <Route
                                path="/research/markets"
                                element={<MarketOverviewPage />}
                            />
                            <Route
                                path="/research/market"
                                element={<MarketLookupPage />}
                            />
                            <Route
                                path="/research/watchlist"
                                element={<WatchlistPage />}
                            />
                            <Route
                                path="/research/symbol/:symbol"
                                element={<RedirectSymbolToMarket />}
                            />
                            <Route
                                path="/research/compare"
                                element={<ResearchComparePage />}
                            />
                            <Route
                                path="/research/forecast"
                                element={<PortfolioForecastPage />}
                            />
                            <Route
                                path="/research/charts"
                                element={<ChartBuilderPage />}
                            />
                            <Route
                                path="/portfolio/market"
                                element={
                                    <RedirectWithQuery to="/research/market" />
                                }
                            />
                            <Route
                                path="/portfolio/watchlist"
                                element={
                                    <RedirectWithQuery to="/research/watchlist" />
                                }
                            />
                            <Route path="/ai-chat" element={<AIChatPage />} />
                            <Route path="*" element={<NotFound />} />
                        </Routes>
                    </Suspense>
                </RoutedErrorBoundary>
            </AppLayout>
        </UnsavedChangesProvider>
    );
}

const browserRouter = createBrowserRouter([
    { path: "*", element: <RouterSurface /> },
]);

const App = () => {
    return (
        // Single Framer Motion feature provider for the whole tree — mounted
        // above DevtoolsGate because the API Inspector renders <Tabs> (an `m`
        // call site) outside AppLayout. `strict` makes any stray `motion.*`
        // component inside this tree throw in dev instead of silently pulling a
        // second copy of the animation engine into the boot chunk. Features are
        // fetched asynchronously; see lib/motionFeatures.ts. `children` keeps a
        // stable element identity across LazyMotion's post-load re-render, so
        // React bails out of re-rendering the app when the bundle arrives.
        <LazyMotion features={loadMotionFeatures} strict>
            <QueryClientProvider client={queryClient}>
                <DevtoolsGate />
                <SettingsPreloadProvider>
                    <ThemeProvider>
                        <SettingsProvider>
                            <AppSettingsProvider>
                                <BelgianTaxProfileProvider>
                                    <LanguageBridge>
                                        <TooltipProvider>
                                            <ErrorBoundary>
                                                <Sonner />
                                                <SettingsSaveErrorToaster />
                                                <BelgianTaxSaveErrorToaster />
                                                <GlobalMutationErrorToaster />
                                                <RouterProvider
                                                    router={browserRouter}
                                                />
                                            </ErrorBoundary>
                                        </TooltipProvider>
                                    </LanguageBridge>
                                </BelgianTaxProfileProvider>
                            </AppSettingsProvider>
                        </SettingsProvider>
                    </ThemeProvider>
                </SettingsPreloadProvider>
            </QueryClientProvider>
        </LazyMotion>
    );
};

export default App;
