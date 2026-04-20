import React, { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { apiClient } from '@/lib/api';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';
import { applyThemePalette, isThemeVariant, type ThemeVariant } from '@/styles/themes';

type Theme = 'dark' | 'light';
type ThemeMode = 'light' | 'dark' | 'system' | 'schedule';

interface ThemeSchedule {
    lightFrom: string; // HH:MM
    darkFrom: string;  // HH:MM
}

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

const DEFAULT_SCHEDULE: ThemeSchedule = { lightFrom: '07:00', darkFrom: '20:00' };
const DEFAULT_VARIANT: ThemeVariant = 'default';

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function resolveTheme(mode: ThemeMode, schedule: ThemeSchedule): Theme {
    if (mode === 'light') return 'light';
    if (mode === 'dark') return 'dark';
    if (mode === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    // schedule
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const [lh, lm] = schedule.lightFrom.split(':').map(Number);
    const [dh, dm] = schedule.darkFrom.split(':').map(Number);
    const lightMinutes = lh * 60 + lm;
    const darkMinutes = dh * 60 + dm;

    if (lightMinutes < darkMinutes) {
        // Normal: light during day, dark at night
        return minutes >= lightMinutes && minutes < darkMinutes ? 'light' : 'dark';
    } else {
        // Inverted (e.g., light 20:00, dark 07:00)
        return minutes >= lightMinutes || minutes < darkMinutes ? 'light' : 'dark';
    }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [mode, setModeState] = useState<ThemeMode>('dark');
    const [schedule, setScheduleState] = useState<ThemeSchedule>(DEFAULT_SCHEDULE);
    const [variant, setVariantState] = useState<ThemeVariant>(DEFAULT_VARIANT);
    const [theme, setThemeState] = useState<Theme>('dark');
    const [loaded, setLoaded] = useState(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Consume the single preloaded settings fetch instead of making our own request.
    const { value: preloaded, isLoading: preloadLoading } = usePreloadedSetting<{
        mode?: ThemeMode;
        schedule?: ThemeSchedule;
        variant?: ThemeVariant;
    }>(SETTINGS_KEY);

    useEffect(() => {
        if (preloadLoading) return;
        if (preloaded) {
            if (preloaded.mode) setModeState(preloaded.mode);
            if (preloaded.schedule) setScheduleState(preloaded.schedule);
            if (isThemeVariant(preloaded.variant)) setVariantState(preloaded.variant);
        } else {
            // Fallback: try localStorage for migration from older versions
            try {
                const stored = localStorage.getItem(THEME_STORAGE_KEY);
                if (stored === 'light' || stored === 'dark') {
                    setModeState(stored as ThemeMode);
                }
                const storedVariant = localStorage.getItem(VARIANT_STORAGE_KEY);
                if (isThemeVariant(storedVariant)) setVariantState(storedVariant);
            } catch { }
        }
        setLoaded(true);
    }, [preloaded, preloadLoading]);

    // Persist to database (debounced)
    const persist = useCallback((m: ThemeMode, s: ThemeSchedule, v: ThemeVariant) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SETTINGS_KEY, { mode: m, schedule: s, variant: v }).catch(() => { });
        }, 500);
    }, []);

    // Resolve effective theme whenever mode/schedule/loaded changes
    useEffect(() => {
        if (!loaded) return;
        const resolved = resolveTheme(mode, schedule);
        setThemeState(resolved);
    }, [mode, schedule, loaded]);

    // For schedule mode: re-check every minute
    useEffect(() => {
        if (mode !== 'schedule') return;
        const interval = setInterval(() => {
            setThemeState(resolveTheme('schedule', schedule));
        }, 60_000);
        return () => clearInterval(interval);
    }, [mode, schedule]);

    // For system mode: listen to OS changes
    useEffect(() => {
        if (mode !== 'system') return;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => setThemeState(mq.matches ? 'dark' : 'light');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [mode]);

    // Apply class to document + mirror effective theme to localStorage for FOUC script
    useEffect(() => {
        if (theme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { }
    }, [theme]);

    // Apply variant palette as CSS custom properties on :root
    useEffect(() => {
        if (!loaded) return;
        applyThemePalette(variant, theme);
        try { localStorage.setItem(VARIANT_STORAGE_KEY, variant); } catch { }
    }, [variant, theme, loaded]);

    const setMode = useCallback((m: ThemeMode) => {
        setModeState(m);
        persist(m, schedule, variant);
    }, [schedule, variant, persist]);

    const setSchedule = useCallback((s: ThemeSchedule) => {
        setScheduleState(s);
        persist(mode, s, variant);
    }, [mode, variant, persist]);

    const setVariant = useCallback((v: ThemeVariant) => {
        setVariantState(v);
        persist(mode, schedule, v);
    }, [mode, schedule, persist]);

    const toggleTheme = useCallback(() => {
        // Toggle switches to explicit light/dark mode
        const next = theme === 'dark' ? 'light' : 'dark';
        setModeState(next);
        setThemeState(next);
        persist(next, schedule, variant);
    }, [theme, schedule, variant, persist]);

    const setTheme = useCallback((t: Theme) => {
        setModeState(t);
        setThemeState(t);
        persist(t, schedule, variant);
    }, [schedule, variant, persist]);

    return (
        <ThemeContext.Provider value={{ theme, mode, schedule, variant, setMode, setSchedule, setVariant, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
    return ctx;
}
