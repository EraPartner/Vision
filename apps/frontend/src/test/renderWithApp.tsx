import { ReactElement, ReactNode } from "react";
import { render, RenderOptions, RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";
import { AppSettingsProvider, useAppSettings } from "@/contexts/AppSettingsContext";
import { BelgianTaxProfileProvider } from "@/contexts/BelgianTaxProfileContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { LanguageProvider, type Language } from "@/contexts/LanguageContext";

interface RenderWithAppOptions extends Omit<RenderOptions, "wrapper"> {
    initialEntries?: string[];
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

function LanguageBridge({ children }: { children: ReactNode }) {
    const { appSettings, updateAppSettings } = useAppSettings();
    const language: Language = (appSettings.language as Language) ?? "en";
    const setLanguage = (lang: Language) => updateAppSettings({ language: lang });
    return (
        <LanguageProvider language={language} setLanguage={setLanguage}>
            {children}
        </LanguageProvider>
    );
}

function AllProviders({
    children,
    initialEntries,
    queryClient,
}: {
    children: ReactNode;
    initialEntries: string[];
    queryClient: QueryClient;
}) {
    return (
        <QueryClientProvider client={queryClient}>
            <SettingsPreloadProvider>
                <ThemeProvider>
                    <SettingsProvider>
                        <AppSettingsProvider>
                            <BelgianTaxProfileProvider>
                                <LanguageBridge>
                                    <TooltipProvider>
                                        <MemoryRouter initialEntries={initialEntries}>
                                            {children}
                                        </MemoryRouter>
                                    </TooltipProvider>
                                </LanguageBridge>
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
 * and real react-router-dom navigation, with HTTP intercepted by MSW.
 */
export function renderWithApp(
    ui: ReactElement,
    options: RenderWithAppOptions = {},
): RenderWithAppResult {
    const { initialEntries = ["/"], queryClient = makeTestQueryClient(), ...rest } = options;
    const result = render(ui, {
        wrapper: ({ children }) => (
            <AllProviders initialEntries={initialEntries} queryClient={queryClient}>
                {children}
            </AllProviders>
        ),
        ...rest,
    });
    return { ...result, queryClient };
}
