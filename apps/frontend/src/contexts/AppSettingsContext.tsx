import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { apiClient } from '@/lib/api';
import logger from '@/lib/logger';
import type { Language } from '@/contexts/LanguageContext';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';

export interface AppSettings {
    defaultCurrency: string;
    dateFormat: string;
    numberFormat: string;
    defaultPageSize: number;
    startOfWeek: 'monday' | 'sunday';
    showDecimalPlaces: number;
    language: Language;
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
    language: 'en',
};

const AppSettingsContext = createContext<AppSettingsContextType | undefined>(undefined);

export function AppSettingsProvider({ children }: { children: ReactNode }) {
    const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
    const [isLoading, setIsLoading] = useState(true);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isFirstRender = useRef(true);

    // Consume the single preloaded settings fetch instead of making our own request.
    const { value: preloaded, isLoading: preloadLoading } = usePreloadedSetting<AppSettings>(SETTINGS_KEY);

    useEffect(() => {
        if (preloadLoading) return; // wait for preload
        if (preloaded) {
            setAppSettings({ ...defaultAppSettings, ...preloaded });
        }
        setIsLoading(false);
    }, [preloaded, preloadLoading]);

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        if (isLoading) return;

        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SETTINGS_KEY, appSettings).catch((err) => {
                logger.error('Failed to save app settings:', err);
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
