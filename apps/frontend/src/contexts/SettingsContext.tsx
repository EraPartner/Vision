/**
 * SettingsContext (dashboard settings)
 *
 * Provider: hydrates the Zustand settings store from the single preloaded
 * settings fetch and persists changes back to the API (debounced).
 *
 * Hook: useSettings() selects only the dashboard-settings slice from the
 * store, so app-settings or theme updates do NOT trigger re-renders here.
 * useShallow ensures the hook only re-renders when the selected values change.
 */

import React, { useEffect, useRef, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { apiClient } from '@/lib/api';
import logger from '@/lib/logger';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';
import { useSettingsStore, DEFAULT_DASHBOARD_SETTINGS } from '@/stores/settingsStore';
import type { ExclusionScope, DashboardSettings } from '@/stores/settingsStore';

// Re-export so existing consumers don't need to change their imports
export type { ExclusionScope, DashboardSettings };

interface SettingsContextType {
    settings: DashboardSettings;
    updateSettings: (settings: Partial<DashboardSettings>) => void;
    resetSettings: () => void;
    isLoading: boolean;
}

const SETTINGS_KEY = 'dashboard_settings';

// ─── Provider ────────────────────────────────────────────────────────────────

export function SettingsProvider({ children }: { children: ReactNode }) {
    const { value: preloaded, isLoading: preloadLoading } =
        usePreloadedSetting<DashboardSettings>(SETTINGS_KEY);

    const _hydrateDashboardSettings = useSettingsStore((s) => s._hydrateDashboardSettings);
    const dashboardSettings = useSettingsStore((s) => s.dashboardSettings);
    const isLoading = useSettingsStore((s) => s.isDashboardSettingsLoading);

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isFirstRender = useRef(true);

    // Hydrate store from preloaded data (with localStorage migration fallback)
    useEffect(() => {
        if (preloadLoading) return;

        if (preloaded) {
            _hydrateDashboardSettings({ ...DEFAULT_DASHBOARD_SETTINGS, ...preloaded }, false);
        } else {
            // Fallback: migrate from localStorage for users upgrading from older versions
            try {
                const stored = localStorage.getItem('vision_dashboardSettings');
                if (stored) {
                    const parsed = JSON.parse(stored);
                    const migrated = { ...DEFAULT_DASHBOARD_SETTINGS, ...parsed };
                    _hydrateDashboardSettings(migrated, false);
                    apiClient.saveSetting(SETTINGS_KEY, migrated).catch((err) => {
                        logger.error('Failed to migrate settings to database', err);
                    });
                    localStorage.removeItem('vision_dashboardSettings');
                } else {
                    _hydrateDashboardSettings(DEFAULT_DASHBOARD_SETTINGS, false);
                }
            } catch (err) {
                logger.warn('Failed to read legacy settings from localStorage', err);
                _hydrateDashboardSettings(DEFAULT_DASHBOARD_SETTINGS, false);
            }
        }
    }, [preloaded, preloadLoading, _hydrateDashboardSettings]);

    // Debounced persist to API when settings change (skip initial render)
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        if (isLoading) return;

        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SETTINGS_KEY, dashboardSettings).catch((err) => {
                logger.error('Failed to save settings to database:', err);
            });
        }, 500);

        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, [dashboardSettings, isLoading]);

    return <>{children}</>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSettings(): SettingsContextType {
    return useSettingsStore(
        useShallow((s) => ({
            settings: s.dashboardSettings,
            updateSettings: s.updateDashboardSettings,
            resetSettings: s.resetDashboardSettings,
            isLoading: s.isDashboardSettingsLoading,
        }))
    );
}
