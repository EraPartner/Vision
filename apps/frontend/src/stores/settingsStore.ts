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

export type CostBasisMethod = 'weighted_avg' | 'fifo' | 'lifo';

/**
 * The section the app lands on at launch. Maps to a sidebar workspace's main
 * page (budgeting → /, portfolio → /portfolio, research → /research) plus the
 * workspace-agnostic AI Chat (/ai-chat). 'last' reopens the page the user was
 * on when they last closed the app. See StartupRedirect.
 */
export type StartupSection = 'budgeting' | 'portfolio' | 'research' | 'ai-chat' | 'last';

/**
 * Atmosphere/material tier (ADR-075, supersedes the ADR-071 boolean):
 * - reduced: no backdrop-filter glass, no liquid canvas — for GPU-starved
 *   outputs (4K TVs on base M-series).
 * - standard: CSS aurora blobs + glass materials (the default look).
 * - enhanced: adds the WebGL shader aurora and Electron vibrancy.
 */
export type VisualEffectsTier = 'reduced' | 'standard' | 'enhanced';

export interface AppSettings {
    defaultCurrency: string;
    dateFormat: string;
    numberFormat: string;
    defaultPageSize: number;
    startOfWeek: 'monday' | 'sunday';
    showDecimalPlaces: number;
    language: Language;
    aiDefaultModel?: string;
    costBasisMethod: CostBasisMethod;
    adminMode: boolean;
    visualEffects: VisualEffectsTier;
    /** Cap the effective tier at 'reduced' while the window sits on a large display. */
    autoAdaptDisplay: boolean;
    /** Section whose main page the app opens on at launch. */
    startupSection: StartupSection;
    /** Auto-clear a planned payment when an imported/created transaction unambiguously matches it. */
    autoClearPlannedOnMatch: boolean;
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
    costBasisMethod: 'weighted_avg',
    adminMode: false,
    visualEffects: 'standard',
    autoAdaptDisplay: true,
    startupSection: 'budgeting',
    autoClearPlannedOnMatch: true,
};

/**
 * Merge a stored app_settings blob over the defaults, mapping the pre-ADR-075
 * `enhancedEffects` boolean onto `visualEffects` (true → enhanced, false →
 * standard). The legacy key is dropped so the next persist writes the new
 * shape. A blob that already carries `visualEffects` wins over the legacy key.
 */
export function migrateAppSettings(
    raw: (Partial<AppSettings> & { enhancedEffects?: boolean }) | undefined,
): AppSettings {
    if (!raw) return DEFAULT_APP_SETTINGS;
    const { enhancedEffects, ...rest } = raw;
    const merged: AppSettings = { ...DEFAULT_APP_SETTINGS, ...rest };
    if (rest.visualEffects === undefined && enhancedEffects !== undefined) {
        merged.visualEffects = enhancedEffects ? 'enhanced' : 'standard';
    }
    return merged;
}

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
    /**
     * Session-only manual tier pick for the auto-adapt cap (ADR-075 addendum):
     * lives outside appSettings so it is never persisted — in-memory by
     * design, so a restart returns large displays to auto mode. Only applied
     * while the cap is active (see resolveEffectiveTier).
     */
    sessionTierOverride: VisualEffectsTier | undefined;

    // Dashboard settings slice
    dashboardSettings: DashboardSettings;
    isDashboardSettingsLoading: boolean;

    // Theme slice
    theme: Theme;
    themeMode: ThemeMode;
    themeSchedule: ThemeSchedule;
    themeVariant: ThemeVariant;
    /** macOS only: override the variant's primary/ring with the system accent color. */
    themeSystemAccent: boolean;
    isThemeLoaded: boolean;
}

interface SettingsActions {
    // App settings
    updateAppSettings: (updates: Partial<AppSettings>) => void;
    resetAppSettings: () => void;
    setSessionTierOverride: (tier: VisualEffectsTier | undefined) => void;
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
    setThemeSystemAccent: (on: boolean) => void;
    setTheme: (theme: Theme) => void;
    toggleTheme: () => void;
    /** Called by ThemeProvider once preloaded data arrives. */
    _hydrateTheme: (data: {
        mode?: ThemeMode;
        schedule?: ThemeSchedule;
        variant?: ThemeVariant;
        systemAccent?: boolean;
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
    sessionTierOverride: undefined,

    updateAppSettings: (updates) =>
        set((s) => ({ appSettings: { ...s.appSettings, ...updates } })),

    resetAppSettings: () =>
        set({ appSettings: DEFAULT_APP_SETTINGS, sessionTierOverride: undefined }),

    setSessionTierOverride: (tier) =>
        set({ sessionTierOverride: tier }),

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
    themeSystemAccent: false,
    isThemeLoaded: false,

    setThemeMode: (mode) => set({ themeMode: mode }),
    setThemeSchedule: (schedule) => set({ themeSchedule: schedule }),
    setThemeVariant: (variant) => set({ themeVariant: variant }),
    setThemeSystemAccent: (on) => set({ themeSystemAccent: on }),
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
            themeSystemAccent: data.systemAccent ?? s.themeSystemAccent,
        })),

    _setResolvedTheme: (theme) => set({ theme }),
    _setThemeLoaded: (loaded) => set({ isThemeLoaded: loaded }),
}));
