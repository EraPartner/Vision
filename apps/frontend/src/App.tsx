import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
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
import { SettingsProvider } from "@/stores/hydration/SettingsHydration";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";
import {
    AppSettingsProvider,
    SettingsSaveErrorToaster,
} from "@/stores/hydration/AppSettingsHydration";
import {
    BelgianTaxProfileProvider,
    BelgianTaxSaveErrorToaster,
} from "@/contexts/BelgianTaxProfileContext";
import { ThemeProvider } from "@/stores/hydration/ThemeHydration";
import { LanguageHydration } from "@/stores/hydration/LanguageHydration";
import { lazy, Suspense, type ReactNode } from "react";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { GlobalMutationErrorToaster } from "@/components/shared/GlobalMutationErrorToaster";
import { ScrollToTop } from "@/components/shared/ScrollToTop";
import { StartupRedirect } from "@/components/shared/StartupRedirect";
import { PageLoader } from "@/components/shared/PageLoader";
import { RequireAdmin } from "@/components/auth/RequireAdmin";
import { LegacyInsightDismissalMigrationGate } from "@/components/shared/LegacyInsightDismissalMigrationGate";

import { useSettingsStore } from "@/stores/settingsStore";

// Lazy-loaded pages for code splitting. Loaders live in lib/routePreload so
// sidebar hover can warm the same chunks the router requests on click.
import { appRouteManifest } from "@/lib/routePreload";
import { loadMotionFeatures } from "@/lib/motionFeatures";
import { UnsavedChangesProvider } from "@/contexts/UnsavedChangesContext";

const lazyAppRoutes = appRouteManifest.map(({ path, loader, admin }) => ({
    path,
    admin,
    Component: lazy(loader),
}));
const NotFound = lazy(() => import("./pages/NotFound"));

// Devtools (API Inspector). Lazily loaded as a separate chunk that is only
// fetched when actually rendered, so it costs normal users nothing on load.
// Shown when ANY of:
//   • local Vite dev server (import.meta.env.DEV), or
//   • an explicit VITE_DEVTOOLS=true source build, or
//   • the user enables Admin Mode at runtime — which is the only path that
//     works in the packaged Electron app and public release, since those
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
            staleTime: QUERY_STALE_TIME_MS.DEFAULT, // 30s before data considered stale
            gcTime: 5 * 60_000, // 5min garbage collection
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
});

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
                            {lazyAppRoutes.map(({ path, admin, Component }) => (
                                <Route
                                    key={path}
                                    path={path}
                                    element={
                                        admin ? (
                                            <RequireAdmin>
                                                <Component />
                                            </RequireAdmin>
                                        ) : (
                                            <Component />
                                        )
                                    }
                                />
                            ))}
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
                                path="/research/symbol/:symbol"
                                element={<RedirectSymbolToMarket />}
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
                <SettingsPreloadProvider>
                    <ThemeProvider>
                        <SettingsProvider>
                            <AppSettingsProvider>
                                <BelgianTaxProfileProvider>
                                    <LanguageHydration>
                                        <TooltipProvider>
                                            <ErrorBoundary>
                                                <LegacyInsightDismissalMigrationGate>
                                                    <Sonner />
                                                    <SettingsSaveErrorToaster />
                                                    <BelgianTaxSaveErrorToaster />
                                                    <GlobalMutationErrorToaster />
                                                    <RouterProvider
                                                        router={browserRouter}
                                                    />
                                                </LegacyInsightDismissalMigrationGate>
                                            </ErrorBoundary>
                                        </TooltipProvider>
                                    </LanguageHydration>
                                </BelgianTaxProfileProvider>
                            </AppSettingsProvider>
                        </SettingsProvider>
                    </ThemeProvider>
                </SettingsPreloadProvider>
                <DevtoolsGate />
            </QueryClientProvider>
        </LazyMotion>
    );
};

export default App;
