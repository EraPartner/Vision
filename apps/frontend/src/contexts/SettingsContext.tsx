import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { apiClient } from '@/lib/api';
import logger from '@/lib/logger';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';

export type ExclusionScope = 'everywhere' | 'dashboard' | 'statistics';

export interface DashboardSettings {
    excludedCategoryIds: number[];
    excludedRecipientIds: number[];
    excludeHiddenCategories: boolean;
    exclusionScope: ExclusionScope;
}

interface SettingsContextType {
    settings: DashboardSettings;
    updateSettings: (settings: Partial<DashboardSettings>) => void;
    resetSettings: () => void;
    isLoading: boolean;
}

const SETTINGS_KEY = 'dashboard_settings';

const defaultSettings: DashboardSettings = {
    excludedCategoryIds: [],
    excludedRecipientIds: [],
    excludeHiddenCategories: true,
    exclusionScope: 'everywhere',
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<DashboardSettings>(defaultSettings);
    const [isLoading, setIsLoading] = useState(true);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Consume the single preloaded settings fetch instead of making our own request.
    const { value: preloaded, isLoading: preloadLoading } = usePreloadedSetting<DashboardSettings>(SETTINGS_KEY);

    // Load settings from preload on mount
    useEffect(() => {
        if (preloadLoading) return;
        if (preloaded) {
            setSettings({ ...defaultSettings, ...preloaded });
        } else {
            // Fallback: try localStorage for migration from older versions
            try {
                const stored = localStorage.getItem('vision_dashboardSettings');
                if (stored) {
                    const parsed = JSON.parse(stored);
                    setSettings({ ...defaultSettings, ...parsed });
                    // Migrate to database
                    apiClient.saveSetting(SETTINGS_KEY, { ...defaultSettings, ...parsed }).catch((err) => {
                        logger.error('Failed to migrate settings to database', err);
                    });
                    localStorage.removeItem('vision_dashboardSettings');
                }
            } catch (err) {
                logger.warn('Failed to read legacy settings from localStorage', err);
            }
        }
        setIsLoading(false);
    }, [preloaded, preloadLoading]);

    // Debounced save to database whenever settings change (skip initial load)
    const isFirstRender = useRef(true);
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        if (isLoading) return;

        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SETTINGS_KEY, settings).catch((err) => {
                logger.error('Failed to save settings to database:', err);
            });
        }, 500);

        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, [settings, isLoading]);

    const updateSettings = useCallback((updates: Partial<DashboardSettings>) => {
        setSettings((prev) => ({ ...prev, ...updates }));
    }, []);

    const resetSettings = useCallback(() => {
        setSettings(defaultSettings);
    }, []);

    return (
        <SettingsContext.Provider value={{ settings, updateSettings, resetSettings, isLoading }}>
            {children}
        </SettingsContext.Provider>
    );
}

export function useSettings() {
    const context = useContext(SettingsContext);
    if (!context) {
        throw new Error('useSettings must be used within a SettingsProvider');
    }
    return context;
}
