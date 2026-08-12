// @vitest-environment jsdom
/**
 * Boot behaviour of the shared exclusion resolver.
 *
 * Two invariants live here:
 *  1. latency — the category list the dashboard's money queries wait on is
 *     fetched once, at boot, in parallel with settings. The hook must adopt that
 *     in-flight request instead of starting its own after mount.
 *  2. money — `isReady` gates every query whose key embeds the exclusion arrays.
 *     It must not go true while those arrays are still the store defaults.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { delay, http } from "msw";

import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { useSettingsStore, DEFAULT_DASHBOARD_SETTINGS } from "@/stores/settingsStore";
import {
    resetCategoriesPreloadForTests,
    startCategoriesPreload,
} from "@/lib/categoriesPreload";
import { useExcludedIds } from "@/hooks/useExcludedIds";
import { useAllCategories } from "@/hooks/useCategories";
import { categoryKeys } from "@/lib/queryKeys";

const API_BASE = "http://localhost:3002";

function category(id: number, isActive: boolean) {
    return {
        id,
        general: "FOOD",
        detail: `D${id}`,
        is_active: isActive,
        created_at: "2025-01-01T00:00:00.000Z",
        links: [],
    };
}

/** Counts every GET /api/categories and answers with one hidden category (id 42). */
function countCategoryRequests() {
    const counter = { count: 0 };
    server.use(
        http.get(`${API_BASE}/api/categories`, () => {
            counter.count += 1;
            return ok({
                items: [category(1, true), category(42, false)],
                total: 2,
                limit: 1000,
                offset: 0,
                links: [],
            });
        }),
    );
    return counter;
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
    return (
        <QueryClientProvider client={queryClient}>
            <SettingsPreloadProvider>
                <SettingsProvider>{children}</SettingsProvider>
            </SettingsPreloadProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    resetCategoriesPreloadForTests();
    // The settings store is a module singleton — put it back in its pre-boot
    // (unhydrated) state so each test exercises a real cold start.
    useSettingsStore.setState({
        dashboardSettings: DEFAULT_DASHBOARD_SETTINGS,
        isDashboardSettingsLoading: true,
    });
});

afterEach(() => {
    resetCategoriesPreloadForTests();
});

describe("useExcludedIds boot path", () => {
    it("adopts the boot preload instead of refetching the category list after mount", async () => {
        const categories = countCategoryRequests();

        // Boot: main.tsx fires this while the entry graph is still executing.
        await startCategoriesPreload();
        expect(categories.count).toBe(1);

        const { result } = renderHook(() => useExcludedIds("dashboard"), { wrapper });

        await waitFor(() => expect(result.current.isReady).toBe(true));

        // The mounted hook must have consumed the boot response. A second request
        // here means the category hop re-serialized after mount — the exact
        // round trip the preload exists to remove.
        expect(categories.count).toBe(1);
        expect(result.current.excludedCategoryIds).toEqual([42]);
    });

    it("still fetches for itself when no preload ran (unit-test / non-boot path)", async () => {
        const categories = countCategoryRequests();

        const { result } = renderHook(() => useExcludedIds("dashboard"), { wrapper });

        await waitFor(() => expect(result.current.isReady).toBe(true));
        expect(categories.count).toBe(1);
        expect(result.current.excludedCategoryIds).toEqual([42]);
    });

    it("refetches from the network after invalidation — the preload seeds one fetch only", async () => {
        const categories = countCategoryRequests();

        await startCategoriesPreload();
        const { result } = renderHook(() => useExcludedIds("dashboard"), { wrapper });
        await waitFor(() => expect(result.current.isReady).toBe(true));
        expect(categories.count).toBe(1);

        await queryClient.invalidateQueries({ queryKey: categoryKeys.allList });

        // A replayed boot snapshot here would silently outlive a category being
        // hidden/unhidden, keeping money totals on a stale exclusion set.
        await waitFor(() => expect(categories.count).toBe(2));
    });

    it("shares one cache entry with the other full-list consumers", async () => {
        const categories = countCategoryRequests();

        // The Settings → Statistics exclusion picker reads the same list through
        // useAllCategories. It used to key its copy under
        // ['categories','all-for-exclusions']'s twin ['categories','all'], so
        // visiting both surfaces fetched the identical payload twice.
        const { result } = renderHook(
            () => ({ excluded: useExcludedIds("dashboard"), picker: useAllCategories() }),
            { wrapper },
        );

        await waitFor(() => expect(result.current.excluded.isReady).toBe(true));
        await waitFor(() => expect(result.current.picker.data).toBeDefined());

        expect(categories.count).toBe(1);
        expect(result.current.picker.data?.map((c) => c.id)).toEqual([1, 42]);
    });

    it("stays not-ready while settings are still the store defaults", async () => {
        countCategoryRequests();
        server.use(
            http.get(`${API_BASE}/api/settings`, async () => {
                await delay(120);
                return ok([
                    { key: "dashboard_settings", value: { excludedCategoryIds: [9] } },
                ]);
            }),
        );

        await startCategoriesPreload();
        const { result } = renderHook(() => useExcludedIds("dashboard"), { wrapper });

        // Categories have landed, settings have not. Going ready here would let
        // the dashboard fetch — and paint as final — totals computed without the
        // user's own excluded category 9, under a query key that hydration then
        // changes, forcing a second round trip.
        await waitFor(() =>
            expect(queryClient.getQueryData(categoryKeys.allList)).toBeDefined(),
        );
        expect(result.current.isReady).toBe(false);

        await waitFor(() => expect(result.current.isReady).toBe(true));
        expect(result.current.excludedCategoryIds).toEqual([9, 42]);
    });
});
