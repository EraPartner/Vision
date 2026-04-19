/**
 * SettingsPreloadContext
 *
 * Fetches ALL user settings in a single `GET /api/settings` call on app startup
 * and provides the raw values for the individual setting contexts
 * (AppSettingsContext, ThemeContext, SettingsContext) to consume as their
 * initial state.
 *
 * Before this, each context fired its own `GET /api/settings/:key` request,
 * resulting in 3 sequential HTTP round-trips before any data could render.
 * Now there is exactly 1 round-trip at mount time.
 */

import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiClient } from '@/lib/api';
import logger from '@/lib/logger';

interface SettingsPreload {
    /** Raw settings map from the backend, keyed by settings key. */
    rawSettings: Record<string, unknown> | null;
    /** True while the initial fetch is in-flight. */
    isLoading: boolean;
}

const SettingsPreloadContext = createContext<SettingsPreload>({
    rawSettings: null,
    isLoading: true,
});

export function SettingsPreloadProvider({ children }: { children: ReactNode }) {
    const [rawSettings, setRawSettings] = useState<Record<string, unknown> | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        apiClient.getSettings()
            .then((all) => {
                if (!cancelled) {
                    // Backend returns an array of { key, value } rows — convert to map
                    const map: Record<string, unknown> = {};
                    if (Array.isArray(all)) {
                        for (const row of all) {
                            if (
                                row !== null &&
                                typeof row === 'object' &&
                                'key' in row &&
                                typeof (row as { key: unknown }).key === 'string'
                            ) {
                                const typed = row as { key: string; value: unknown };
                                map[typed.key] = typed.value;
                            }
                        }
                    } else if (all && typeof all === 'object') {
                        // Already a key-value map (depending on backend version)
                        Object.assign(map, all);
                    }
                    setRawSettings(map);
                }
            })
            .catch((err) => {
                // Backend unreachable on startup — contexts will use their own defaults
                logger.warn('Settings preload failed; using defaults', err);
                if (!cancelled) setRawSettings({});
            })
            .finally(() => { if (!cancelled) setIsLoading(false); });
        return () => { cancelled = true; };
    }, []);

    return (
        <SettingsPreloadContext.Provider value={{ rawSettings, isLoading }}>
            {children}
        </SettingsPreloadContext.Provider>
    );
}

/**
 * Returns the preloaded value for a given settings key.
 * Returns `undefined` while loading, and `null` if the key was not found.
 */
export function usePreloadedSetting<T>(key: string): { value: T | null; isLoading: boolean } {
    const { rawSettings, isLoading } = useContext(SettingsPreloadContext);
    if (isLoading) return { value: null, isLoading: true };
    const v = rawSettings?.[key];
    return { value: v !== undefined ? (v as T) : null, isLoading: false };
}
