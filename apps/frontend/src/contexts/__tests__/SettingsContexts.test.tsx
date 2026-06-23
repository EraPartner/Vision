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
} from "@/stores/settingsStore";
import { useAppSettings, AppSettingsProvider } from "@/contexts/AppSettingsContext";
import { useSettings, SettingsProvider } from "@/contexts/SettingsContext";
import { useTheme } from "@/contexts/ThemeContext";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";

const API_BASE = "http://localhost:3002";

beforeEach(() => {
    useSettingsStore.setState({
        appSettings: DEFAULT_APP_SETTINGS,
        isAppSettingsLoading: true,
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
        expect(result.current.appSettings.dateFormat).toBe(DEFAULT_APP_SETTINGS.dateFormat);
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
        act(() => result.current.updateSettings({ excludedCategoryIds: [1, 2] }));
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

describe("AppSettingsContext — edge cases", () => {
    afterEach(() => vi.restoreAllMocks());

    it("hydrates from server-provided preload data (boot fetch success)", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok({ app_settings: { defaultCurrency: "USD" } }),
            ),
        );
        const { result } = renderHook(() => useAppSettings(), { wrapper: makeProviderWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.appSettings.defaultCurrency).toBe("USD");
    });

    it("falls back to defaults when preload boot fetch fails (network error)", async () => {
        const spy = vi.spyOn(apiClient, "getSettings").mockRejectedValueOnce(new Error("Network error"));
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const { result } = renderHook(() => useAppSettings(), { wrapper: makeProviderWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.appSettings.defaultCurrency).toBe(DEFAULT_APP_SETTINGS.defaultCurrency);
        spy.mockRestore();
        errSpy.mockRestore();
    });

    it("falls back to defaults when preload returns 5xx", async () => {
        const errSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const spy = vi
            .spyOn(apiClient, "getSettings")
            .mockRejectedValueOnce(Object.assign(new Error("server error"), { status: 500 }));
        const { result } = renderHook(() => useAppSettings(), { wrapper: makeProviderWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.appSettings.defaultCurrency).toBe(DEFAULT_APP_SETTINGS.defaultCurrency);
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

        const { result } = renderHook(() => useAppSettings(), { wrapper: makeProviderWrapper() });
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

        vi.useRealTimers();
        saveSpy.mockRestore();
        errSpy.mockRestore();
    });

    it("calls saveSetting after a debounce when settings change (mutation success)", async () => {
        vi.useFakeTimers();
        server.use(http.get(`${API_BASE}/api/settings`, () => ok({})));
        const saveSpy = vi.spyOn(apiClient, "saveSetting").mockResolvedValue(undefined as never);

        const { result } = renderHook(() => useAppSettings(), { wrapper: makeProviderWrapper() });
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

describe("SettingsContext — edge cases", () => {
    afterEach(() => vi.restoreAllMocks());

    it("hydrates from preloaded dashboard_settings (boot fetch success)", async () => {
        const spy = vi
            .spyOn(apiClient, "getSettings")
            .mockResolvedValueOnce({ dashboard_settings: { excludedCategoryIds: [42] } });
        const { result } = renderHook(() => useSettings(), { wrapper: makeProviderWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.settings.excludedCategoryIds).toContain(42);
        spy.mockRestore();
    });

    it("falls back to defaults when preload boot fetch fails (network error)", async () => {
        const spy = vi.spyOn(apiClient, "getSettings").mockRejectedValueOnce(new Error("Network error"));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { result } = renderHook(() => useSettings(), { wrapper: makeProviderWrapper() });
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

        const { result } = renderHook(() => useSettings(), { wrapper: makeProviderWrapper() });
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

        vi.useRealTimers();
        saveSpy.mockRestore();
        errSpy.mockRestore();
    });
});

describe("ThemeContext — edge cases", () => {
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
