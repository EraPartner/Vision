import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { apiClient } from '@/lib/api';
import logger from '@/lib/logger';

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

    // Load settings from database on mount
    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const result = await apiClient.getSetting(SETTINGS_KEY);
                if (!cancelled && result?.value) {
                    setSettings({ ...defaultSettings, ...result.value });
                }
            } catch {
                // Setting not found or backend unreachable — use defaults
                // Try localStorage as fallback for migration
                try {
                    const stored = localStorage.getItem('vaultVoyager_dashboardSettings');
                    if (!cancelled && stored) {
                        const parsed = JSON.parse(stored);
                        setSettings({ ...defaultSettings, ...parsed });
                        // Migrate to database
                        apiClient.saveSetting(SETTINGS_KEY, { ...defaultSettings, ...parsed }).catch(() => { });
                        localStorage.removeItem('vaultVoyager_dashboardSettings');
                    }
                } catch {
                    // ignore
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        }

        load();
        return () => { cancelled = true; };
    }, []);

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
