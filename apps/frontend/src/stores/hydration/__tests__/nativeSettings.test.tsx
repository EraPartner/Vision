// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { apiClient } from "@/lib/api";
import {
    SettingsPreloadProvider,
    usePreloadedSetting,
} from "@/contexts/SettingsPreloadContext";
import { AppSettingsProvider } from "@/stores/hydration/AppSettingsHydration";
import { SettingsProvider } from "@/stores/hydration/SettingsHydration";
import { ThemeProvider } from "@/stores/hydration/ThemeHydration";
import {
    NATIVE_SETTINGS_EVENT,
    NATIVE_SETTINGS_SESSION_EVENT,
    startNativeSettingsMirror,
} from "@/stores/hydration/nativeSettings";
import {
    DEFAULT_APP_SETTINGS,
    DEFAULT_DASHBOARD_SETTINGS,
    DEFAULT_THEME_SCHEDULE,
    useSettingsStore,
} from "@/stores/settingsStore";

function install(snapshot: Record<string, unknown> = {}) {
    const change = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperties(window, {
        __VISION_NATIVE_SETTINGS__: { value: true, configurable: true },
        __VISION_NATIVE_SETTINGS_SNAPSHOT__: {
            value: snapshot,
            configurable: true,
        },
        __VISION_NATIVE_SETTINGS_SESSION_TIER__: {
            value: { value: null },
            configurable: true,
        },
        __visionNativeSettingsChange: { value: change, configurable: true },
    });
    return change;
}
function draft(
    key: string,
    value: unknown,
    kind = "draft",
    expected?: unknown,
) {
    window.dispatchEvent(
        new CustomEvent(NATIVE_SETTINGS_EVENT, {
            detail: { key, kind, value, expected },
        }),
    );
}
function Wrapper({ children }: { children: ReactNode }) {
    return (
        <SettingsPreloadProvider>
            <AppSettingsProvider>
                <SettingsProvider>
                    <ThemeProvider>{children}</ThemeProvider>
                </SettingsProvider>
            </AppSettingsProvider>
        </SettingsPreloadProvider>
    );
}
beforeEach(() => {
    useSettingsStore.setState({
        appSettings: DEFAULT_APP_SETTINGS,
        isAppSettingsLoading: true,
        dashboardSettings: DEFAULT_DASHBOARD_SETTINGS,
        isDashboardSettingsLoading: true,
        theme: "dark",
        themeMode: "dark",
        themeVariant: "default",
        themeSystemAccent: false,
        themeSchedule: DEFAULT_THEME_SCHEDULE,
        isThemeLoaded: false,
        settingsSaveErrorNonce: 0,
        sessionTierOverride: undefined,
    });
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: vi.fn().mockReturnValue({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }),
    });
});
afterEach(() => {
    for (const key of [
        "__VISION_NATIVE_SETTINGS__",
        "__VISION_NATIVE_SETTINGS_SNAPSHOT__",
        "__VISION_NATIVE_SETTINGS_SESSION_TIER__",
        "__visionNativeSettingsChange",
    ])
        Reflect.deleteProperty(window, key);
    vi.restoreAllMocks();
});

describe("native-owned Settings hydration", () => {
    it("preserves a native draft received before React and refuses a late API rewind", async () => {
        const change = install({
            app_settings: {
                language: "nl",
                future: { exact: "9007199254740993" },
            },
        });
        let resolve!: (value: Record<string, unknown>) => void;
        vi.spyOn(apiClient, "getSettings").mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const save = vi.spyOn(apiClient, "saveSetting");
        const { result } = renderHook(
            () => usePreloadedSetting("app_settings"),
            { wrapper: Wrapper },
        );
        act(() =>
            draft("app_settings", {
                language: "nl",
                defaultCurrency: "USD",
                future: { exact: "9007199254740993" },
            }),
        );
        act(() =>
            resolve({
                app_settings: { language: "en", defaultCurrency: "EUR" },
                onboarding_complete: true,
            }),
        );
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.value).toEqual({
            language: "nl",
            defaultCurrency: "USD",
            future: { exact: "9007199254740993" },
        });
        expect(useSettingsStore.getState().appSettings.defaultCurrency).toBe(
            "USD",
        );
        expect(change).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it("forwards existing app/dashboard/theme actions as deltas without HTTP writes or raw-field roundtrips", async () => {
        const change = install();
        vi.spyOn(apiClient, "getSettings").mockResolvedValue({
            app_settings: {
                ...DEFAULT_APP_SETTINGS,
                analysisBenchmark: "SPY",
                untouched: { large: "9007199254740993" },
            },
            dashboard_settings: DEFAULT_DASHBOARD_SETTINGS,
            theme_settings: {
                mode: "dark",
                schedule: DEFAULT_THEME_SCHEDULE,
                variant: "default",
                systemAccent: false,
            },
        });
        const save = vi.spyOn(apiClient, "saveSetting");
        const { result } = renderHook(
            () => usePreloadedSetting("app_settings"),
            { wrapper: Wrapper },
        );
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        change.mockClear();
        act(() => {
            useSettingsStore.getState().updateAppSettings({
                adminMode: true,
                analysisBenchmark: undefined,
            });
            useSettingsStore
                .getState()
                .updateDashboardSettings({ excludedCategoryIds: [1, 7] });
            useSettingsStore.getState().setThemeMode("light");
        });
        expect(change.mock.calls).toEqual([
            ["app_settings", { adminMode: true }, ["analysisBenchmark"]],
            ["dashboard_settings", { excludedCategoryIds: [1, 7] }, []],
            ["theme_settings", { mode: "light" }, []],
        ]);
        await new Promise((resolve) => setTimeout(resolve, 550));
        expect(save).not.toHaveBeenCalled();
    });

    it("does not echo host updates and an older ACK cannot replace a newer draft", () => {
        const change = install();
        const mirror = startNativeSettingsMirror(() => {});
        draft("app_settings", { language: "nl", colorblindGainLoss: true });
        draft("app_settings", { language: "en", colorblindGainLoss: true });
        draft("app_settings", { language: "nl" }, "ack", {
            exists: true,
            value: { language: "nl" },
        });
        draft("theme_settings", {
            mode: "light",
            schedule: DEFAULT_THEME_SCHEDULE,
            variant: "nord",
            systemAccent: true,
        });
        draft("onboarding_complete", false);
        draft("app_settings", { language: "nl" }, "bogus");
        expect(useSettingsStore.getState().appSettings.language).toBe("en");
        expect(useSettingsStore.getState().themeVariant).toBe("nord");
        expect(mirror.drafts.app_settings).toEqual({
            language: "en",
            colorblindGainLoss: true,
        });
        expect(change).not.toHaveBeenCalled();
        mirror.stop();
    });

    it("reports a missing host writer rather than silently dropping a web control edit", async () => {
        install();
        Reflect.deleteProperty(window, "__visionNativeSettingsChange");
        const mirror = startNativeSettingsMirror(() => {});
        draft("app_settings", DEFAULT_APP_SETTINGS);
        useSettingsStore.getState().updateAppSettings({ adminMode: true });
        await waitFor(() =>
            expect(useSettingsStore.getState().settingsSaveErrorNonce).toBe(1),
        );
        mirror.stop();
    });

    it("does not take over an earlier native-sidebar shell without the separate Settings flag", () => {
        const change = install();
        Reflect.deleteProperty(window, "__VISION_NATIVE_SETTINGS__");
        const mirror = startNativeSettingsMirror(() => {});
        draft("app_settings", { language: "nl" });
        expect(useSettingsStore.getState().isAppSettingsLoading).toBe(true);
        expect(change).not.toHaveBeenCalled();
        mirror.stop();
    });

    it("mirrors session-only capped effects without forwarding or changing persisted preferences", () => {
        const change = install();
        const mirror = startNativeSettingsMirror(() => {});
        draft("app_settings", DEFAULT_APP_SETTINGS);
        window.dispatchEvent(
            new CustomEvent(NATIVE_SETTINGS_SESSION_EVENT, {
                detail: { sessionTierOverride: "enhanced" },
            }),
        );
        expect(useSettingsStore.getState().sessionTierOverride).toBe(
            "enhanced",
        );
        expect(useSettingsStore.getState().appSettings.visualEffects).toBe(
            "standard",
        );
        window.dispatchEvent(
            new CustomEvent(NATIVE_SETTINGS_SESSION_EVENT, {
                detail: { sessionTierOverride: null },
            }),
        );
        expect(useSettingsStore.getState().sessionTierOverride).toBeUndefined();
        expect(change).not.toHaveBeenCalled();
        mirror.stop();
    });

    it("forwards only changed schedule fields while retaining opaque nested native values", () => {
        const change = install();
        const mirror = startNativeSettingsMirror(() => {});
        draft("theme_settings", {
            mode: "schedule",
            variant: "default",
            systemAccent: false,
            schedule: {
                ...DEFAULT_THEME_SCHEDULE,
                futureAmount: 9007199254740992,
            },
        });
        useSettingsStore
            .getState()
            .setThemeSchedule({
                ...useSettingsStore.getState().themeSchedule,
                lightFrom: "08:00",
            });
        expect(change).toHaveBeenCalledExactlyOnceWith(
            "theme_settings",
            { schedule: { lightFrom: "08:00" } },
            [],
        );
        mirror.stop();
    });
});
