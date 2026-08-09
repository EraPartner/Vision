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
import { z } from 'zod';
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
    /**
     * Gain/loss color palette (accessibility). `true` = colorblind-safe
     * Okabe-Ito green/orange (loss is orange); `false` = classic gold/red
     * (loss is red). Drives the `.skin-v2` root class via lib/skin.ts —
     * pure CSS, applied by AppSettingsProvider. Default off / classic red
     * (ADR-104 addendum 2026-06-24); opt-in for colorblind accessibility.
     */
    colorblindGainLoss: boolean;
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
    colorblindGainLoss: false,
};

/**
 * Persisted app-settings blob guard, mirroring `storedDashboardSettingsSchema`
 * below. Loose object so unknown keys survive the migration (they flow through
 * the merge and are persisted back); per-field `.catch` so one malformed field
 * falls back to its default instead of poisoning the whole blob. This matters
 * most for the money-formatting fields: an unvalidated `defaultCurrency`
 * ("US") or `showDecimalPlaces` (-1 / NaN / 101) makes `Intl.NumberFormat`
 * throw `RangeError`, which either crashes a page into the error boundary or —
 * where formatters guard — silently renders a bare unlocalised number on every
 * money tile. Validating here means every consumer sees Intl-safe settings.
 *
 * Deliberately type/shape-level only where any value is safe downstream
 * (`dateFormat`, `numberFormat` — `numberFormatToLocale` already maps unknown
 * strings to its own default, so an enum catch here would *change* behavior).
 * `showDecimalPlaces` is bounded to Intl's universally-valid 0–20 fraction
 * digits (the UI offers 0–3); `defaultCurrency` to a well-formed ISO-4217
 * 3-letter code, which is exactly what Intl accepts without throwing.
 */
const storedAppSettingsSchema = z.looseObject({
    defaultCurrency: z
        .string()
        .regex(/^[A-Za-z]{3}$/)
        .catch(DEFAULT_APP_SETTINGS.defaultCurrency),
    dateFormat: z.string().catch(DEFAULT_APP_SETTINGS.dateFormat),
    numberFormat: z.string().catch(DEFAULT_APP_SETTINGS.numberFormat),
    defaultPageSize: z.number().int().positive().catch(DEFAULT_APP_SETTINGS.defaultPageSize),
    startOfWeek: z
        .enum(['monday', 'sunday'] as const satisfies readonly AppSettings['startOfWeek'][])
        .catch(DEFAULT_APP_SETTINGS.startOfWeek),
    showDecimalPlaces: z
        .number()
        .int()
        .min(0)
        .max(20)
        .catch(DEFAULT_APP_SETTINGS.showDecimalPlaces),
    language: z
        .enum(['en', 'nl'] as const satisfies readonly Language[])
        .catch(DEFAULT_APP_SETTINGS.language),
    aiDefaultModel: z.string().optional().catch(undefined),
    costBasisMethod: z
        .enum(['weighted_avg', 'fifo', 'lifo'] as const satisfies readonly CostBasisMethod[])
        .catch(DEFAULT_APP_SETTINGS.costBasisMethod),
    adminMode: z.boolean().catch(DEFAULT_APP_SETTINGS.adminMode),
    // Optional (not caught to the default): the pre-ADR-075 legacy mapping in
    // migrateAppSettings must still see "absent" to apply `enhancedEffects`.
    visualEffects: z
        .enum(['reduced', 'standard', 'enhanced'] as const satisfies readonly VisualEffectsTier[])
        .optional()
        .catch(undefined),
    autoAdaptDisplay: z.boolean().catch(DEFAULT_APP_SETTINGS.autoAdaptDisplay),
    startupSection: z
        .enum([
            'budgeting',
            'portfolio',
            'research',
            'ai-chat',
            'last',
        ] as const satisfies readonly StartupSection[])
        .catch(DEFAULT_APP_SETTINGS.startupSection),
    autoClearPlannedOnMatch: z.boolean().catch(DEFAULT_APP_SETTINGS.autoClearPlannedOnMatch),
    colorblindGainLoss: z.boolean().catch(DEFAULT_APP_SETTINGS.colorblindGainLoss),
    enhancedEffects: z.boolean().optional().catch(undefined),
});

/**
 * Merge a stored app_settings blob over the defaults, mapping the pre-ADR-075
 * `enhancedEffects` boolean onto `visualEffects` (true → enhanced, false →
 * standard). The legacy key is dropped so the next persist writes the new
 * shape. A blob that already carries `visualEffects` wins over the legacy key.
 *
 * The blob is untrusted (arbitrary JSON from the settings API):
 * `storedAppSettingsSchema` validates it per-field first, so a well-formed
 * (possibly partial) blob produces exactly the old
 * `{ ...DEFAULT_APP_SETTINGS, ...raw }` result, unknown keys included;
 * malformed fields fall back per-field and a blob that is not an object at
 * all falls back to the defaults wholesale.
 */
export function migrateAppSettings(raw: unknown): AppSettings {
    const parsed = storedAppSettingsSchema.safeParse(raw);
    if (!parsed.success) return DEFAULT_APP_SETTINGS;
    const { enhancedEffects, visualEffects, aiDefaultModel, ...rest } = parsed.data;
    const merged: AppSettings = { ...DEFAULT_APP_SETTINGS, ...rest };
    if (aiDefaultModel !== undefined) merged.aiDefaultModel = aiDefaultModel;
    merged.visualEffects = visualEffects ?? (enhancedEffects ? 'enhanced' : 'standard');
    return merged;
}

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
    excludedCategoryIds: [],
    excludedRecipientIds: [],
    excludeHiddenCategories: true,
    exclusionScope: 'everywhere',
};

/**
 * Persisted dashboard-settings blob guard (ZOD-11). Loose object so unknown
 * keys survive the migration (they used to flow through the spread merge and
 * be persisted); per-field `.catch` so a malformed field falls back to its
 * default instead of poisoning the merge — important because the migrated
 * result is written back to the API.
 */
const storedDashboardSettingsSchema = z.looseObject({
    excludedCategoryIds: z.array(z.number()).catch(() => []),
    excludedRecipientIds: z.array(z.number()).catch(() => []),
    excludeHiddenCategories: z
        .boolean()
        .catch(DEFAULT_DASHBOARD_SETTINGS.excludeHiddenCategories),
    exclusionScope: z
        .enum(['everywhere', 'dashboard', 'statistics'] as const satisfies readonly ExclusionScope[])
        .catch(DEFAULT_DASHBOARD_SETTINGS.exclusionScope),
});

/**
 * Merge a stored dashboard_settings blob over the defaults. A well-formed
 * (possibly partial) blob produces exactly the old
 * `{ ...DEFAULT_DASHBOARD_SETTINGS, ...raw }` result, unknown keys included;
 * malformed fields fall back per-field and a blob that is not an object at
 * all falls back to the defaults wholesale.
 */
export function migrateDashboardSettings(raw: unknown): DashboardSettings {
    const parsed = storedDashboardSettingsSchema.safeParse(raw);
    return parsed.success
        ? (parsed.data as DashboardSettings)
        : { ...DEFAULT_DASHBOARD_SETTINGS };
}

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
     * Bumped whenever a debounced persist of app settings fails. A component
     * rendered under LanguageProvider watches this to surface a translated toast
     * (the provider itself sits above LanguageProvider and can't translate).
     */
    appSettingsSaveErrorNonce: number;
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
    /** Called by AppSettingsProvider when a debounced persist fails. */
    _markAppSettingsSaveError: () => void;

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
    appSettingsSaveErrorNonce: 0,
    sessionTierOverride: undefined,

    updateAppSettings: (updates) =>
        set((s) => ({ appSettings: { ...s.appSettings, ...updates } })),

    resetAppSettings: () =>
        set({ appSettings: DEFAULT_APP_SETTINGS, sessionTierOverride: undefined }),

    setSessionTierOverride: (tier) =>
        set({ sessionTierOverride: tier }),

    _hydrateAppSettings: (settings, isLoading) =>
        set({ appSettings: settings, isAppSettingsLoading: isLoading }),

    _markAppSettingsSaveError: () =>
        set((s) => ({ appSettingsSaveErrorNonce: s.appSettingsSaveErrorNonce + 1 })),

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
