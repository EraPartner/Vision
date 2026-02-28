import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type Theme = 'dark' | 'light';

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
    setTheme: (t: Theme) => void;
}

const THEME_STORAGE_KEY = 'vaultVoyager_theme';

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setTheme] = useState<Theme>(() => {
        try {
            const stored = localStorage.getItem(THEME_STORAGE_KEY);
            if (stored === 'light' || stored === 'dark') return stored as Theme;
        } catch (e) {
            // ignore
        }
        // Default to dark theme as requested
        return 'dark';
    });

    useEffect(() => {
        try {
            localStorage.setItem(THEME_STORAGE_KEY, theme);
        } catch (e) {
            // ignore
        }

        if (theme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [theme]);

    const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

    return (
        <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
    return ctx;
}
