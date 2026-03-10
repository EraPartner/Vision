import React, { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { apiClient } from '@/lib/api';

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
    setMode: (m: ThemeMode) => void;
    setSchedule: (s: ThemeSchedule) => void;
    toggleTheme: () => void;
    setTheme: (t: Theme) => void;
}

const SETTINGS_KEY = 'theme_settings';

const DEFAULT_SCHEDULE: ThemeSchedule = { lightFrom: '07:00', darkFrom: '20:00' };

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
    const [theme, setThemeState] = useState<Theme>('dark');
    const [loaded, setLoaded] = useState(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Load from database
    useEffect(() => {
        let cancelled = false;
        apiClient.getSetting(SETTINGS_KEY)
            .then((result) => {
                if (!cancelled && result?.value) {
                    const v = result.value;
                    if (v.mode) setModeState(v.mode);
                    if (v.schedule) setScheduleState(v.schedule);
                }
            })
            .catch(() => {
                // Try localStorage migration
                try {
                    const stored = localStorage.getItem('vision_theme');
                    if (!cancelled && (stored === 'light' || stored === 'dark')) {
                        setModeState(stored as ThemeMode);
                    }
                } catch { }
            })
            .finally(() => { if (!cancelled) setLoaded(true); });
        return () => { cancelled = true; };
    }, []);

    // Persist to database (debounced)
    const persist = useCallback((m: ThemeMode, s: ThemeSchedule) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SETTINGS_KEY, { mode: m, schedule: s }).catch(() => { });
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

    // Apply class to document
    useEffect(() => {
        if (theme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [theme]);

    const setMode = useCallback((m: ThemeMode) => {
        setModeState(m);
        persist(m, schedule);
    }, [schedule, persist]);

    const setSchedule = useCallback((s: ThemeSchedule) => {
        setScheduleState(s);
        persist(mode, s);
    }, [mode, persist]);

    const toggleTheme = useCallback(() => {
        // Toggle switches to explicit light/dark mode
        const next = theme === 'dark' ? 'light' : 'dark';
        setModeState(next);
        setThemeState(next);
        persist(next, schedule);
    }, [theme, schedule, persist]);

    const setTheme = useCallback((t: Theme) => {
        setModeState(t);
        setThemeState(t);
        persist(t, schedule);
    }, [schedule, persist]);

    return (
        <ThemeContext.Provider value={{ theme, mode, schedule, setMode, setSchedule, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
    return ctx;
}
