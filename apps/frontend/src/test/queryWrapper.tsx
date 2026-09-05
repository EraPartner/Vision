import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, type DefaultOptions } from "@tanstack/react-query";
import { LanguageProvider } from "@/stores/hydration/LanguageHydration";

/**
 * QueryClient / provider wrappers for `renderHook` in hook tests.
 *
 * `renderWithApp` covers component rendering; these cover the bare
 * `QueryClientProvider` (and the QueryClientProvider + LanguageProvider) wrappers
 * that hook tests otherwise re-implement.
 */

/**
 * A QueryClient tuned for tests: retries disabled and no caching between renders
 * by default. Pass `queryOverrides` to tweak (e.g. `{ gcTime: Infinity }` when a
 * test seeds the cache and needs it to outlive the render).
 */
export function createTestQueryClient(queryOverrides: DefaultOptions["queries"] = {}): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0, ...queryOverrides } },
  });
}

/** Bare `QueryClientProvider` wrapper. Creates a fresh client unless one is passed. */
export function createQueryWrapper(client?: QueryClient) {
  const qc = client ?? createTestQueryClient();
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/** `QueryClientProvider` + English `LanguageProvider` wrapper. */
export function createLanguageQueryWrapper(client?: QueryClient) {
  const qc = client ?? createTestQueryClient();
  return function LanguageQueryWrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: qc },
      createElement(LanguageProvider, { language: "en", setLanguage: () => {}, children }),
    );
  };
}
