/**
 * settingsStore — unified Zustand store for all user settings.
 *
 * Consolidates three previously separate React contexts:
 *   - AppSettingsContext  (app_settings key)
 *   - SettingsContext     (dashboard_settings key)
 *   - ThemeContext        (theme_settings key)
 *
 * The Provider components in each context file still exist to handle:
 *   - Hydration from SettingsPreloadContext
 *   - Debounced persistence back to the API
 *   - DOM side-effects (ThemeContext: CSS class, matchMedia, interval)
 *
 * Consumer hooks (useAppSettings, useSettings, useTheme) select only the
 * slice they need, so unrelated slice updates do not trigger re-renders.
 */

import { create } from 'zustand';
import type { Language } from '@/contexts/LanguageContext';
import type { ThemeVariant } from '@/styles/themes';

// ─── App settings types ───────────────────────────────────────────────────────

export interface AppSettings {
    defaultCurrency: string;
    dateFormat: string;
    numberFormat: string;
    defaultPageSize: number;
    startOfWeek: 'monday' | 'sunday';
    showDecimalPlaces: number;
    language: Language;
    aiDefaultModel?: string;
}

// ─── Dashboard settings types ─────────────────────────────────────────────────

export type ExclusionScope = 'everywhere' | 'dashboard' | 'statistics';

export interface DashboardSettings {
    excludedCategoryIds: number[];
    excludedRecipientIds: number[];
    excludeHiddenCategories: boolean;
    exclusionScope: ExclusionScope;
}

// ─── Theme types ──────────────────────────────────────────────────────────────

export type Theme = 'dark' | 'light';
export type ThemeMode = 'light' | 'dark' | 'system' | 'schedule';
export interface ThemeSchedule {
    lightFrom: string; // HH:MM
    darkFrom: string;  // HH:MM
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_APP_SETTINGS: AppSettings = {
    defaultCurrency: 'EUR',
    dateFormat: 'DD/MM/YYYY',
    numberFormat: 'eu',
    defaultPageSize: 50,
    startOfWeek: 'monday',
    showDecimalPlaces: 2,
    language: 'en',
};

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
    excludedCategoryIds: [],
    excludedRecipientIds: [],
    excludeHiddenCategories: true,
    exclusionScope: 'everywhere',
};

export const DEFAULT_THEME_SCHEDULE: ThemeSchedule = {
    lightFrom: '07:00',
    darkFrom: '20:00',
};

// ─── Store shape ─────────────────────────────────────────────────────────────

interface SettingsState {
    // App settings slice
    appSettings: AppSettings;
    isAppSettingsLoading: boolean;

    // Dashboard settings slice
    dashboardSettings: DashboardSettings;
    isDashboardSettingsLoading: boolean;

    // Theme slice
    theme: Theme;
    themeMode: ThemeMode;
    themeSchedule: ThemeSchedule;
    themeVariant: ThemeVariant;
    isThemeLoaded: boolean;
}

interface SettingsActions {
    // App settings
    updateAppSettings: (updates: Partial<AppSettings>) => void;
    resetAppSettings: () => void;
    /** Called by AppSettingsProvider once preloaded data arrives. */
    _hydrateAppSettings: (settings: AppSettings, isLoading: boolean) => void;

    // Dashboard settings
    updateDashboardSettings: (updates: Partial<DashboardSettings>) => void;
    resetDashboardSettings: () => void;
    /** Called by SettingsProvider once preloaded data arrives. */
    _hydrateDashboardSettings: (settings: DashboardSettings, isLoading: boolean) => void;

    // Theme
    setThemeMode: (mode: ThemeMode) => void;
    setThemeSchedule: (schedule: ThemeSchedule) => void;
    setThemeVariant: (variant: ThemeVariant) => void;
    setTheme: (theme: Theme) => void;
    toggleTheme: () => void;
    /** Called by ThemeProvider once preloaded data arrives. */
    _hydrateTheme: (data: {
        mode?: ThemeMode;
        schedule?: ThemeSchedule;
        variant?: ThemeVariant;
    }) => void;
    /** Called by ThemeProvider after the resolved theme is computed. */
    _setResolvedTheme: (theme: Theme) => void;
    _setThemeLoaded: (loaded: boolean) => void;
}

export type SettingsStore = SettingsState & SettingsActions;

// ─── Store ───────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsStore>((set, get) => ({
    // ── App settings ──────────────────────────────────────────────────────────
    appSettings: DEFAULT_APP_SETTINGS,
    isAppSettingsLoading: true,

    updateAppSettings: (updates) =>
        set((s) => ({ appSettings: { ...s.appSettings, ...updates } })),

    resetAppSettings: () =>
        set({ appSettings: DEFAULT_APP_SETTINGS }),

    _hydrateAppSettings: (settings, isLoading) =>
        set({ appSettings: settings, isAppSettingsLoading: isLoading }),

    // ── Dashboard settings ────────────────────────────────────────────────────
    dashboardSettings: DEFAULT_DASHBOARD_SETTINGS,
    isDashboardSettingsLoading: true,

    updateDashboardSettings: (updates) =>
        set((s) => ({ dashboardSettings: { ...s.dashboardSettings, ...updates } })),

    resetDashboardSettings: () =>
        set({ dashboardSettings: DEFAULT_DASHBOARD_SETTINGS }),

    _hydrateDashboardSettings: (settings, isLoading) =>
        set({ dashboardSettings: settings, isDashboardSettingsLoading: isLoading }),

    // ── Theme ─────────────────────────────────────────────────────────────────
    theme: 'dark',
    themeMode: 'dark',
    themeSchedule: DEFAULT_THEME_SCHEDULE,
    themeVariant: 'default',
    isThemeLoaded: false,

    setThemeMode: (mode) => set({ themeMode: mode }),
    setThemeSchedule: (schedule) => set({ themeSchedule: schedule }),
    setThemeVariant: (variant) => set({ themeVariant: variant }),
    // Sets both the resolved theme AND the mode (used for explicit light/dark override)
    setTheme: (theme) => set({ theme, themeMode: theme }),
    toggleTheme: () => {
        const next = get().theme === 'dark' ? 'light' : 'dark';
        set({ theme: next, themeMode: next });
    },

    _hydrateTheme: (data) =>
        set((s) => ({
            themeMode: data.mode ?? s.themeMode,
            themeSchedule: data.schedule ?? s.themeSchedule,
            themeVariant: data.variant ?? s.themeVariant,
        })),

    _setResolvedTheme: (theme) => set({ theme }),
    _setThemeLoaded: (loaded) => set({ isThemeLoaded: loaded }),
}));
