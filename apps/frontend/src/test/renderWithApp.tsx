import { ReactElement, ReactNode } from "react";
import { render, RenderOptions, RenderResult } from "@testing-library/react";
import { MemoryRouter, type MemoryRouterProps } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsProvider } from "@/stores/hydration/SettingsHydration";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";
import { AppSettingsProvider } from "@/stores/hydration/AppSettingsHydration";
import { BelgianTaxProfileProvider } from "@/contexts/BelgianTaxProfileContext";
import { ThemeProvider } from "@/stores/hydration/ThemeHydration";
import { LanguageHydration } from "@/stores/hydration/LanguageHydration";

interface RenderWithAppOptions extends Omit<RenderOptions, "wrapper"> {
    initialEntries?: MemoryRouterProps["initialEntries"];
    queryClient?: QueryClient;
}

interface RenderWithAppResult extends RenderResult {
    queryClient: QueryClient;
}

function makeTestQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 0, staleTime: 0 },
            mutations: { retry: false },
        },
    });
}

function AllProviders({
    children,
    initialEntries,
    queryClient,
}: {
    children: ReactNode;
    initialEntries: NonNullable<MemoryRouterProps["initialEntries"]>;
    queryClient: QueryClient;
}) {
    return (
        <QueryClientProvider client={queryClient}>
            <SettingsPreloadProvider>
                <ThemeProvider>
                    <SettingsProvider>
                        <AppSettingsProvider>
                            <BelgianTaxProfileProvider>
                                <LanguageHydration>
                                    <TooltipProvider>
                                        <MemoryRouter
                                            initialEntries={initialEntries}
                                        >
                                            {children}
                                        </MemoryRouter>
                                    </TooltipProvider>
                                </LanguageHydration>
                            </BelgianTaxProfileProvider>
                        </AppSettingsProvider>
                    </SettingsProvider>
                </ThemeProvider>
            </SettingsPreloadProvider>
        </QueryClientProvider>
    );
}

/**
 * Render a React tree with Vision's full provider stack and a memory router.
 * Use for component-integration tests that need real context, real react-query,
 * and real react-router navigation, with HTTP intercepted by MSW.
 */
export function renderWithApp(
    ui: ReactElement,
    options: RenderWithAppOptions = {},
): RenderWithAppResult {
    const {
        initialEntries = ["/"],
        queryClient = makeTestQueryClient(),
        ...rest
    } = options;
    const result = render(ui, {
        wrapper: ({ children }) => (
            <AllProviders
                initialEntries={initialEntries}
                queryClient={queryClient}
            >
                {children}
            </AllProviders>
        ),
        ...rest,
    });
    return { ...result, queryClient };
}
