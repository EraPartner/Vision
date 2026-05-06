/**
 * ThemeContext
 *
 * Provider: hydrates the Zustand settings store from the preloaded settings
 * fetch and handles all DOM-side-effects (CSS class on <html>, localStorage
 * mirror for FOUC prevention, matchMedia listener for system mode, per-minute
 * interval for schedule mode, theme-variant palette application, and debounced
 * API persistence).
 *
 * Hook: useTheme() selects only the theme slice from the Zustand store via
 * useShallow, so app-settings or dashboard-settings updates do NOT trigger
 * re-renders in theme consumers.
 */

import React, { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { apiClient } from '@/lib/api';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';
import { applyThemePalette, isThemeVariant, type ThemeVariant } from '@/styles/themes';
import {
    useSettingsStore,
    type Theme,
    type ThemeMode,
    type ThemeSchedule,
} from '@/stores/settingsStore';

// Re-export types that downstream consumers import from this module
export type { Theme, ThemeMode, ThemeSchedule };

interface ThemeContextType {
    theme: Theme;
    mode: ThemeMode;
    schedule: ThemeSchedule;
    variant: ThemeVariant;
    setMode: (m: ThemeMode) => void;
    setSchedule: (s: ThemeSchedule) => void;
    setVariant: (v: ThemeVariant) => void;
    toggleTheme: () => void;
    setTheme: (t: Theme) => void;
}

const SETTINGS_KEY = 'theme_settings';
const VARIANT_STORAGE_KEY = 'vision_theme_variant';
const THEME_STORAGE_KEY = 'vision_theme';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveTheme(mode: ThemeMode, schedule: ThemeSchedule): Theme {
    if (mode === 'light') return 'light';
    if (mode === 'dark') return 'dark';
    if (mode === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    // schedule mode
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const [lh = 8, lm = 0] = schedule.lightFrom.split(':').map(Number);
    const [dh = 20, dm = 0] = schedule.darkFrom.split(':').map(Number);
    const lightMinutes = (Number.isFinite(lh) ? lh : 8) * 60 + (Number.isFinite(lm) ? lm : 0);
    const darkMinutes = (Number.isFinite(dh) ? dh : 20) * 60 + (Number.isFinite(dm) ? dm : 0);

    if (lightMinutes < darkMinutes) {
        return minutes >= lightMinutes && minutes < darkMinutes ? 'light' : 'dark';
    }
    // Inverted schedule (e.g. light 20:00, dark 07:00)
    return minutes >= lightMinutes || minutes < darkMinutes ? 'light' : 'dark';
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function ThemeProvider({ children }: { children: ReactNode }) {
    const { value: preloaded, isLoading: preloadLoading } = usePreloadedSetting<{
        mode?: ThemeMode;
        schedule?: ThemeSchedule;
        variant?: ThemeVariant;
    }>(SETTINGS_KEY);

    const _hydrateTheme = useSettingsStore((s) => s._hydrateTheme);
    const _setResolvedTheme = useSettingsStore((s) => s._setResolvedTheme);
    const _setThemeLoaded = useSettingsStore((s) => s._setThemeLoaded);

    const mode = useSettingsStore((s) => s.themeMode);
    const schedule = useSettingsStore((s) => s.themeSchedule);
    const variant = useSettingsStore((s) => s.themeVariant);
    const theme = useSettingsStore((s) => s.theme);
    const isLoaded = useSettingsStore((s) => s.isThemeLoaded);

    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isFirstPersist = useRef(true);

    const persist = useCallback((m: ThemeMode, s: ThemeSchedule, v: ThemeVariant) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SETTINGS_KEY, { mode: m, schedule: s, variant: v })
                .catch(() => { /* ignore persistence failures silently */ });
        }, 500);
    }, []);

    // Hydrate store from preloaded data (with localStorage migration fallback)
    useEffect(() => {
        if (preloadLoading) return;

        if (preloaded) {
            _hydrateTheme({
                mode: preloaded.mode,
                schedule: preloaded.schedule,
                variant: isThemeVariant(preloaded.variant) ? preloaded.variant : undefined,
            });
        } else {
            // Fallback: localStorage migration from older app versions
            try {
                const stored = localStorage.getItem(THEME_STORAGE_KEY);
                if (stored === 'light' || stored === 'dark') {
                    _hydrateTheme({ mode: stored as ThemeMode });
                }
                const storedVariant = localStorage.getItem(VARIANT_STORAGE_KEY);
                if (isThemeVariant(storedVariant)) {
                    _hydrateTheme({ variant: storedVariant });
                }
            } catch { /* localStorage unavailable */ }
        }

        _setThemeLoaded(true);
    }, [preloaded, preloadLoading, _hydrateTheme, _setThemeLoaded]);

    // Resolve effective theme whenever mode/schedule changes (post-load)
    useEffect(() => {
        if (!isLoaded) return;
        _setResolvedTheme(resolveTheme(mode, schedule));
    }, [mode, schedule, isLoaded, _setResolvedTheme]);

    // Persist mode/schedule/variant when they change after initial load
    useEffect(() => {
        if (!isLoaded) return;
        if (isFirstPersist.current) {
            isFirstPersist.current = false;
            return;
        }
        persist(mode, schedule, variant);
    }, [mode, schedule, variant, isLoaded, persist]);

    // Re-check every minute in schedule mode
    useEffect(() => {
        if (mode !== 'schedule') return;
        const interval = setInterval(() => {
            _setResolvedTheme(resolveTheme('schedule', schedule));
        }, 60_000);
        return () => clearInterval(interval);
    }, [mode, schedule, _setResolvedTheme]);

    // Listen to OS dark-mode changes in system mode
    useEffect(() => {
        if (mode !== 'system') return;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => _setResolvedTheme(mq.matches ? 'dark' : 'light');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [mode, _setResolvedTheme]);

    // Apply CSS class to <html> and mirror to localStorage (FOUC prevention)
    useEffect(() => {
        if (theme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* ignore */ }
    }, [theme]);

    // Apply variant palette as CSS custom properties on :root
    useEffect(() => {
        if (!isLoaded) return;
        applyThemePalette(variant, theme);
        try { localStorage.setItem(VARIANT_STORAGE_KEY, variant); } catch { /* ignore */ }
    }, [variant, theme, isLoaded]);

    return <>{children}</>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextType {
    return useSettingsStore(
        useShallow((s) => ({
            theme: s.theme,
            mode: s.themeMode,
            schedule: s.themeSchedule,
            variant: s.themeVariant,
            setMode: s.setThemeMode,
            setSchedule: s.setThemeSchedule,
            setVariant: s.setThemeVariant,
            toggleTheme: s.toggleTheme,
            setTheme: s.setTheme,
        }))
    );
}
