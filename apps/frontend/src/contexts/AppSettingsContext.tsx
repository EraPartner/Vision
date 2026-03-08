import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { apiClient } from '@/lib/api';

export interface AppSettings {
    defaultCurrency: string;
    dateFormat: string;
    numberFormat: string;
    defaultPageSize: number;
    startOfWeek: 'monday' | 'sunday';
    showDecimalPlaces: number;
    defaultBankAccount: string;
}

interface AppSettingsContextType {
    appSettings: AppSettings;
    updateAppSettings: (updates: Partial<AppSettings>) => void;
    resetAppSettings: () => void;
    isLoading: boolean;
}

const SETTINGS_KEY = 'app_settings';

const defaultAppSettings: AppSettings = {
    defaultCurrency: 'EUR',
    dateFormat: 'DD/MM/YYYY',
    numberFormat: 'eu',
    defaultPageSize: 50,
    startOfWeek: 'monday',
    showDecimalPlaces: 2,
    defaultBankAccount: '',
};

const AppSettingsContext = createContext<AppSettingsContextType | undefined>(undefined);

export function AppSettingsProvider({ children }: { children: ReactNode }) {
    const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
    const [isLoading, setIsLoading] = useState(true);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isFirstRender = useRef(true);

    useEffect(() => {
        let cancelled = false;
        apiClient.getSetting(SETTINGS_KEY)
            .then((result) => {
                if (!cancelled && result?.value) {
                    setAppSettings({ ...defaultAppSettings, ...result.value });
                }
            })
            .catch(() => {})
            .finally(() => { if (!cancelled) setIsLoading(false); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        if (isLoading) return;

        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SETTINGS_KEY, appSettings).catch((err) => {
                console.error('Failed to save app settings:', err);
            });
        }, 500);

        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, [appSettings, isLoading]);

    const updateAppSettings = useCallback((updates: Partial<AppSettings>) => {
        setAppSettings((prev) => ({ ...prev, ...updates }));
    }, []);

    const resetAppSettings = useCallback(() => {
        setAppSettings(defaultAppSettings);
    }, []);

    return (
        <AppSettingsContext.Provider value={{ appSettings, updateAppSettings, resetAppSettings, isLoading }}>
            {children}
        </AppSettingsContext.Provider>
    );
}

export function useAppSettings() {
    const context = useContext(AppSettingsContext);
    if (!context) {
        throw new Error('useAppSettings must be used within an AppSettingsProvider');
    }
    return context;
}

export { defaultAppSettings };
