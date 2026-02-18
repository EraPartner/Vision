import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export interface DashboardSettings {
    excludedCategoryIds: number[];
    excludedRecipientIds: number[];
    excludeHiddenCategories: boolean;
}

interface SettingsContextType {
    settings: DashboardSettings;
    updateSettings: (settings: Partial<DashboardSettings>) => void;
    resetSettings: () => void;
}

const defaultSettings: DashboardSettings = {
    excludedCategoryIds: [],
    excludedRecipientIds: [],
    excludeHiddenCategories: true, // Default to excluding hidden categories
};

const SETTINGS_STORAGE_KEY = 'vaultVoyager_dashboardSettings';

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<DashboardSettings>(() => {
        // Load settings from localStorage on initialization
        try {
            const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                return { ...defaultSettings, ...parsed };
            }
        } catch (error) {
            console.error('Failed to load settings from localStorage:', error);
        }
        return defaultSettings;
    });

    // Persist settings to localStorage whenever they change
    useEffect(() => {
        try {
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
        } catch (error) {
            console.error('Failed to save settings to localStorage:', error);
        }
    }, [settings]);

    const updateSettings = (updates: Partial<DashboardSettings>) => {
        setSettings((prev) => ({ ...prev, ...updates }));
    };

    const resetSettings = () => {
        setSettings(defaultSettings);
    };

    return (
        <SettingsContext.Provider value={{ settings, updateSettings, resetSettings }}>
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
