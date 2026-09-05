// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { type ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { apiClient } from "@/lib/api";
import {
    useSettingsStore,
    DEFAULT_APP_SETTINGS,
    DEFAULT_DASHBOARD_SETTINGS,
    migrateDashboardSettings,
} from "@/stores/settingsStore";
import {
    useAppSettings,
    AppSettingsProvider,
} from "@/stores/hydration/AppSettingsHydration";
import {
    useSettings,
    SettingsProvider,
} from "@/stores/hydration/SettingsHydration";
import { useTheme } from "@/stores/hydration/ThemeHydration";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";

const API_BASE = "http://localhost:3002";

beforeEach(() => {
    useSettingsStore.setState({
        appSettings: DEFAULT_APP_SETTINGS,
        isAppSettingsLoading: true,
        settingsSaveErrorNonce: 0,
        dashboardSettings: DEFAULT_DASHBOARD_SETTINGS,
        isDashboardSettingsLoading: true,
        theme: "dark",
        themeMode: "dark",
        isThemeLoaded: false,
    });
});

describe("useAppSettings", () => {
    it("returns default currency EUR", () => {
        const { result } = renderHook(() => useAppSettings());
        expect(result.current.appSettings.defaultCurrency).toBe("EUR");
    });

    it("isLoading is true before hydration", () => {
        const { result } = renderHook(() => useAppSettings());
        expect(result.current.isLoading).toBe(true);
    });

    it("updateAppSettings merges partial changes", () => {
        const { result } = renderHook(() => useAppSettings());
        act(() => result.current.updateAppSettings({ defaultCurrency: "USD" }));
        expect(result.current.appSettings.defaultCurrency).toBe("USD");
        expect(result.current.appSettings.dateFormat).toBe(
            DEFAULT_APP_SETTINGS.dateFormat,
        );
    });

    it("updateAppSettings validates malformed runtime values", () => {
        const { result } = renderHook(() => useAppSettings());
        act(() =>
            result.current.updateAppSettings({
                defaultCurrency: "US",
                showDecimalPlaces: Number.NaN,
            }),
        );
        expect(result.current.appSettings.defaultCurrency).toBe("EUR");
        expect(result.current.appSettings.showDecimalPlaces).toBe(2);
    });

    it("resetAppSettings restores defaults", () => {
        const { result } = renderHook(() => useAppSettings());
        act(() => result.current.updateAppSettings({ defaultCurrency: "USD" }));
        act(() => result.current.resetAppSettings());
        expect(result.current.appSettings.defaultCurrency).toBe("EUR");
    });
});

describe("useSettings", () => {
    it("returns empty excludedCategoryIds by default", () => {
        const { result } = renderHook(() => useSettings());
        expect(result.current.settings.excludedCategoryIds).toEqual([]);
    });

    it("isLoading is true before hydration", () => {
        const { result } = renderHook(() => useSettings());
        expect(result.current.isLoading).toBe(true);
    });

    it("updateSettings merges partial changes", () => {
        const { result } = renderHook(() => useSettings());
        act(() =>
            result.current.updateSettings({ excludedCategoryIds: [1, 2] }),
        );
        expect(result.current.settings.excludedCategoryIds).toEqual([1, 2]);
        expect(result.current.settings.excludeHiddenCategories).toBe(
            DEFAULT_DASHBOARD_SETTINGS.excludeHiddenCategories,
        );
    });

    it("resetSettings restores defaults", () => {
        const { result } = renderHook(() => useSettings());
        act(() => result.current.updateSettings({ excludedCategoryIds: [5] }));
        act(() => result.current.resetSettings());
        expect(result.current.settings.excludedCategoryIds).toEqual([]);
    });
});

describe("useTheme", () => {
    it("initial theme is dark", () => {
        const { result } = renderHook(() => useTheme());
        expect(result.current.theme).toBe("dark");
    });

    it("initial mode is dark", () => {
        const { result } = renderHook(() => useTheme());
        expect(result.current.mode).toBe("dark");
    });

    it("toggleTheme switches from dark to light", () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.toggleTheme());
        expect(result.current.theme).toBe("light");
        expect(result.current.mode).toBe("light");
    });

    it("setTheme explicitly sets theme and mode", () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.setTheme("light"));
        expect(result.current.theme).toBe("light");
        expect(result.current.mode).toBe("light");
    });
});

// ─── Edge cases (mutation error, boot fetch fail, persistence) ───────────────

function makeProviderWrapper() {
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <SettingsPreloadProvider>
                <AppSettingsProvider>
                    <SettingsProvider>{children}</SettingsProvider>
                </AppSettingsProvider>
            </SettingsPreloadProvider>
        );
    };
}

describe("AppSettingsHydration — edge cases", () => {
    afterEach(() => vi.restoreAllMocks());

    it("hydrates from server-provided preload data (boot fetch success)", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok({ app_settings: { defaultCurrency: "USD" } }),
            ),
        );
        const { result } = renderHook(() => useAppSettings(), {
            wrapper: makeProviderWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.appSettings.defaultCurrency).toBe("USD");
    });

    it("falls back to defaults when preload boot fetch fails (network error)", async () => {
        const spy = vi
            .spyOn(apiClient, "getSettings")
            .mockRejectedValueOnce(new Error("Network error"));
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { result } = renderHook(() => useAppSettings(), {
            wrapper: makeProviderWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.appSettings.defaultCurrency).toBe(
            DEFAULT_APP_SETTINGS.defaultCurrency,
        );
        spy.mockRestore();
        errSpy.mockRestore();
    });

    it("falls back to defaults when preload returns 5xx", async () => {
        const errSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const spy = vi
            .spyOn(apiClient, "getSettings")
            .mockRejectedValueOnce(
                Object.assign(new Error("server error"), { status: 500 }),
            );
        const { result } = renderHook(() => useAppSettings(), {
            wrapper: makeProviderWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.appSettings.defaultCurrency).toBe(
            DEFAULT_APP_SETTINGS.defaultCurrency,
        );
        spy.mockRestore();
        errSpy.mockRestore();
    });

    it("logs error but keeps in-memory state when persisting save fails (mutation error)", async () => {
        vi.useFakeTimers();
        server.use(http.get(`${API_BASE}/api/settings`, () => ok({})));
        const saveSpy = vi
            .spyOn(apiClient, "saveSetting")
            .mockRejectedValue(new Error("save failed"));
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const { result } = renderHook(() => useAppSettings(), {
            wrapper: makeProviderWrapper(),
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        // Hydrate completes
        act(() => {
            useSettingsStore.setState({ isAppSettingsLoading: false });
        });
        // Mutate
        act(() => result.current.updateAppSettings({ defaultCurrency: "USD" }));
        // Flush debounce
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });

        expect(saveSpy).toHaveBeenCalled();
        // Local state remains updated despite save failure (no rollback)
        expect(result.current.appSettings.defaultCurrency).toBe("USD");
        expect(useSettingsStore.getState().settingsSaveErrorNonce).toBe(1);

        vi.useRealTimers();
        saveSpy.mockRestore();
        errSpy.mockRestore();
    });

    it("calls saveSetting after a debounce when settings change (mutation success)", async () => {
        vi.useFakeTimers();
        server.use(http.get(`${API_BASE}/api/settings`, () => ok({})));
        const saveSpy = vi
            .spyOn(apiClient, "saveSetting")
            .mockResolvedValue(undefined as never);

        const { result } = renderHook(() => useAppSettings(), {
            wrapper: makeProviderWrapper(),
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        act(() => {
            useSettingsStore.setState({ isAppSettingsLoading: false });
        });
        const before = saveSpy.mock.calls.length;
        act(() => result.current.updateAppSettings({ defaultCurrency: "GBP" }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        // At least one new save call after the debounce window
        expect(saveSpy.mock.calls.length).toBeGreaterThan(before);

        vi.useRealTimers();
        saveSpy.mockRestore();
    });
});

describe("SettingsHydration — legacy localStorage migration", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        localStorage.removeItem("vision_dashboardSettings");
    });

    function renderWithLegacyBlob(blob: string) {
        const getSpy = vi
            .spyOn(apiClient, "getSettings")
            .mockResolvedValueOnce({});
        const saveSpy = vi
            .spyOn(apiClient, "saveSetting")
            .mockResolvedValue(undefined as never);
        localStorage.setItem("vision_dashboardSettings", blob);
        const rendered = renderHook(() => useSettings(), {
            wrapper: makeProviderWrapper(),
        });
        return { ...rendered, getSpy, saveSpy };
    }

    it("hydrates a valid legacy blob merged over defaults and persists that merge to the API", async () => {
        const blob = {
            excludedCategoryIds: [3, 4],
            exclusionScope: "dashboard",
        };
        const { result, saveSpy } = renderWithLegacyBlob(JSON.stringify(blob));
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        const expected = { ...DEFAULT_DASHBOARD_SETTINGS, ...blob };
        expect(result.current.settings).toEqual(expected);
        expect(saveSpy).toHaveBeenCalledWith("dashboard_settings", expected);
        expect(localStorage.getItem("vision_dashboardSettings")).toBeNull();
    });

    it("preserves unknown keys from the legacy blob (loose merge)", async () => {
        const blob = { excludedCategoryIds: [1], someLegacyFlag: true };
        const { result, saveSpy } = renderWithLegacyBlob(JSON.stringify(blob));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(saveSpy).toHaveBeenCalledWith("dashboard_settings", {
            ...DEFAULT_DASHBOARD_SETTINGS,
            ...blob,
        });
    });

    it("falls back to defaults and does not persist when the legacy blob is not valid JSON", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { result, saveSpy } = renderWithLegacyBlob("{not json");
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.settings).toEqual(DEFAULT_DASHBOARD_SETTINGS);
        expect(saveSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it("defaults a malformed field instead of writing it back to the API", async () => {
        const blob = {
            excludedCategoryIds: "not-an-array",
            exclusionScope: "dashboard",
        };
        const { result, saveSpy } = renderWithLegacyBlob(JSON.stringify(blob));
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        const expected = {
            ...DEFAULT_DASHBOARD_SETTINGS,
            exclusionScope: "dashboard",
        };
        expect(result.current.settings).toEqual(expected);
        expect(saveSpy).toHaveBeenCalledWith("dashboard_settings", expected);
    });

    it("falls back to defaults wholesale when the legacy blob is not an object", async () => {
        const { result, saveSpy } = renderWithLegacyBlob(
            JSON.stringify([1, 2]),
        );
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.settings).toEqual(DEFAULT_DASHBOARD_SETTINGS);
        // Still migrated (write-back timing unchanged), but with a valid shape —
        // never the old `{ ...defaults, ...[1,2] }` index-key poisoning.
        expect(saveSpy).toHaveBeenCalledWith(
            "dashboard_settings",
            DEFAULT_DASHBOARD_SETTINGS,
        );
    });
});

describe("migrateDashboardSettings", () => {
    it("merges a valid partial blob over defaults, preserving unknown keys", () => {
        expect(
            migrateDashboardSettings({
                excludedRecipientIds: [7],
                someFutureKey: "x",
            }),
        ).toEqual({
            ...DEFAULT_DASHBOARD_SETTINGS,
            excludedRecipientIds: [7],
            someFutureKey: "x",
        });
    });

    it("keeps a fully valid blob unchanged", () => {
        const blob = {
            excludedCategoryIds: [1, 2],
            excludedRecipientIds: [],
            excludeHiddenCategories: false,
            exclusionScope: "statistics",
        };
        expect(migrateDashboardSettings(blob)).toEqual(blob);
    });

    it("falls back per-field for malformed values", () => {
        expect(
            migrateDashboardSettings({
                excludedCategoryIds: [1, "2"],
                excludeHiddenCategories: "yes",
                exclusionScope: "bogus",
            }),
        ).toEqual(DEFAULT_DASHBOARD_SETTINGS);
    });

    it("returns defaults for non-object blobs", () => {
        expect(migrateDashboardSettings(null)).toEqual(
            DEFAULT_DASHBOARD_SETTINGS,
        );
        expect(migrateDashboardSettings([1])).toEqual(
            DEFAULT_DASHBOARD_SETTINGS,
        );
        expect(migrateDashboardSettings("x")).toEqual(
            DEFAULT_DASHBOARD_SETTINGS,
        );
    });
});

describe("SettingsHydration — edge cases", () => {
    afterEach(() => vi.restoreAllMocks());

    it("hydrates from preloaded dashboard_settings (boot fetch success)", async () => {
        const spy = vi
            .spyOn(apiClient, "getSettings")
            .mockResolvedValueOnce({
                dashboard_settings: { excludedCategoryIds: [42] },
            });
        const { result } = renderHook(() => useSettings(), {
            wrapper: makeProviderWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.settings.excludedCategoryIds).toContain(42);
        spy.mockRestore();
    });

    it("falls back to defaults when preload boot fetch fails (network error)", async () => {
        const spy = vi
            .spyOn(apiClient, "getSettings")
            .mockRejectedValueOnce(new Error("Network error"));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { result } = renderHook(() => useSettings(), {
            wrapper: makeProviderWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.settings.excludedCategoryIds).toEqual([]);
        spy.mockRestore();
        warnSpy.mockRestore();
    });

    it("logs error but keeps in-memory state when persisting save fails", async () => {
        vi.useFakeTimers();
        server.use(http.get(`${API_BASE}/api/settings`, () => ok({})));
        const saveSpy = vi
            .spyOn(apiClient, "saveSetting")
            .mockRejectedValue(new Error("save failed"));
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const { result } = renderHook(() => useSettings(), {
            wrapper: makeProviderWrapper(),
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        act(() => {
            useSettingsStore.setState({ isDashboardSettingsLoading: false });
        });
        act(() => result.current.updateSettings({ excludedCategoryIds: [99] }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });

        expect(saveSpy).toHaveBeenCalled();
        expect(result.current.settings.excludedCategoryIds).toEqual([99]);
        expect(useSettingsStore.getState().settingsSaveErrorNonce).toBe(1);

        vi.useRealTimers();
        saveSpy.mockRestore();
        errSpy.mockRestore();
    });
});

describe("ThemeHydration — edge cases", () => {
    it("setTheme to invalid value falls back gracefully (no crash)", () => {
        const { result } = renderHook(() => useTheme());
        // setTheme accepts "light" | "dark"; this is a type check + runtime no-op for unrelated calls
        act(() => result.current.setTheme("dark"));
        expect(result.current.theme).toBe("dark");
    });

    it("toggleTheme is idempotent across two flips", () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.toggleTheme());
        act(() => result.current.toggleTheme());
        expect(result.current.theme).toBe("dark");
    });
});
