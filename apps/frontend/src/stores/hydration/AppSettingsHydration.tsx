/**
 * AppSettingsHydration
 *
 * Provider: hydrates the Zustand settings store from the single preloaded
 * settings fetch and persists changes back to the API (debounced).
 *
 * Hook: useAppSettings() selects only the app-settings slice from the store,
 * so theme or dashboard-settings updates do NOT trigger re-renders here.
 * useShallow ensures the hook only re-renders when the selected values change.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { usePreloadedSetting } from "@/contexts/SettingsPreloadContext";
import {
    useSettingsStore,
    DEFAULT_APP_SETTINGS,
    migrateAppSettings,
} from "@/stores/settingsStore";
import type { AppSettings } from "@/stores/settingsStore";
import { setSkinV2 } from "@/lib/skin";

// Re-export the app-settings types alongside the hydration bridge.
export type { AppSettings };

interface AppSettingsHydrationValue {
    appSettings: AppSettings;
    updateAppSettings: (updates: Partial<AppSettings>) => void;
    resetAppSettings: () => void;
    isLoading: boolean;
}

const SETTINGS_KEY = "app_settings";

/** @deprecated Import DEFAULT_APP_SETTINGS from \@/stores/settingsStore instead. */
// eslint-disable-next-line react-refresh/only-export-components
export { DEFAULT_APP_SETTINGS as defaultAppSettings };

// ─── Provider ────────────────────────────────────────────────────────────────

export function AppSettingsProvider({ children }: { children: ReactNode }) {
    const { value: preloaded, isLoading: preloadLoading } =
        usePreloadedSetting<AppSettings>(SETTINGS_KEY);

    const _hydrateAppSettings = useSettingsStore((s) => s._hydrateAppSettings);
    const _markSettingsSaveError = useSettingsStore(
        (s) => s._markSettingsSaveError,
    );
    const appSettings = useSettingsStore((s) => s.appSettings);
    const isLoading = useSettingsStore((s) => s.isAppSettingsLoading);

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasHydrated = useRef(false);
    // Skip the first persist-effect run: hydration fires before persist in the
    // same render, so hasHydrated is already true on that first run even though
    // the settings value came from the server and doesn't need saving back.
    const isFirstPersistRun = useRef(true);

    // Hydrate store from preloaded data (migrates pre-ADR-075 blobs that
    // still carry the legacy enhancedEffects boolean)
    useEffect(() => {
        if (preloadLoading) return;
        const migrated = migrateAppSettings(preloaded ?? undefined);
        _hydrateAppSettings(migrated, false);
        hasHydrated.current = true;
        // Sync the colorblind-safe gain/loss skin to the (server) preference,
        // overriding the boot-time localStorage cache so the synced choice wins.
        setSkinV2(migrated.colorblindGainLoss);
    }, [preloaded, preloadLoading, _hydrateAppSettings]);

    // Apply runtime toggles of the gain/loss palette (pure CSS — toggles the
    // `.skin-v2` root class and caches the choice for next boot's first paint).
    const colorblindGainLoss = appSettings.colorblindGainLoss;
    useEffect(() => {
        if (!hasHydrated.current) return;
        setSkinV2(colorblindGainLoss);
    }, [colorblindGainLoss]);

    // Debounced persist to API when settings change (only after hydration)
    useEffect(() => {
        if (!hasHydrated.current) return;
        if (isFirstPersistRun.current) {
            isFirstPersistRun.current = false;
            return;
        }
        if (isLoading) return;

        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SETTINGS_KEY, appSettings).catch((err) => {
                logger.error("Failed to save app settings:", err);
                // Instant-apply has no Save button, so a silent failure means the
                // user believes a change persisted when it didn't. Signal it so the
                // toaster (under LanguageProvider) can surface a translated message.
                _markSettingsSaveError();
            });
        }, 500);

        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, [appSettings, isLoading, _markSettingsSaveError]);

    return <>{children}</>;
}

// ─── Save-error toaster ────────────────────────────────────────────────────────

/**
 * Surfaces a translated toast when an instant-apply settings persist fails.
 * Mounted UNDER LanguageProvider (the provider above it cannot translate), it
 * watches the store's shared save-error nonce and toasts when it advances.
 */
export function SettingsSaveErrorToaster() {
    const { t } = useLanguage();
    const nonce = useSettingsStore((s) => s.settingsSaveErrorNonce);
    const lastSeen = useRef(nonce);
    useEffect(() => {
        if (nonce !== lastSeen.current) {
            lastSeen.current = nonce;
            if (nonce > 0) toast.error(t("settings.saveFailed"));
        }
    }, [nonce, t]);
    return null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line react-refresh/only-export-components
export function useAppSettings(): AppSettingsHydrationValue {
    return useSettingsStore(
        useShallow((s) => ({
            appSettings: s.appSettings,
            updateAppSettings: s.updateAppSettings,
            resetAppSettings: s.resetAppSettings,
            isLoading: s.isAppSettingsLoading,
        })),
    );
}
