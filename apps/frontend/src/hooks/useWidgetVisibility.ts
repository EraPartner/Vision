import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiClient } from '@/lib/api';
import logger from '@/lib/logger';
const SETTINGS_KEY = 'widget_visibility';
export interface WidgetDefinition {
    id: string;
    label: string;
    description?: string;
    defaultVisible?: boolean; // defaults to true
}
export type WidgetVisibilityMap = Record<string, Record<string, boolean>>;
// e.g. { dashboard: { statCards: true, bankBalances: false }, statistics: { ... } }
let cachedVisibility: WidgetVisibilityMap | null = null;
let pendingLoad: Promise<WidgetVisibilityMap> | null = null;
const listeners = new Set<(v: WidgetVisibilityMap) => void>();
function notify(v: WidgetVisibilityMap) {
    cachedVisibility = v;
    listeners.forEach((fn) => fn(v));
}
async function loadFromBackend(): Promise<WidgetVisibilityMap> {
    if (pendingLoad) return pendingLoad;
    pendingLoad = (async () => {
        try {
            const result = await apiClient.getSetting(SETTINGS_KEY);
            if (result?.value && typeof result.value === 'object') {
                return result.value as WidgetVisibilityMap;
            }
        } catch {
            // not found or backend unreachable
        }
        return {};
    })();
    try {
        return await pendingLoad;
    } finally {
        pendingLoad = null;
    }
}
function saveToBackend(v: WidgetVisibilityMap) {
    apiClient.saveSetting(SETTINGS_KEY, v).catch((err) => {
        logger.error('Failed to save widget visibility:', err);
    });
}
/**
 * Hook to manage widget visibility for a specific page.
 * Widgets are visible by default unless explicitly hidden.
 */
export function useWidgetVisibility(pageKey: string, widgets: WidgetDefinition[]) {
    const [visibility, setVisibility] = useState<WidgetVisibilityMap>(cachedVisibility || {});
    const [isLoaded, setIsLoaded] = useState(!!cachedVisibility);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        const listener = (v: WidgetVisibilityMap) => setVisibility(v);
        listeners.add(listener);
        if (!cachedVisibility) {
            loadFromBackend().then((v) => {
                notify(v);
                setIsLoaded(true);
            });
        }
        return () => {
            listeners.delete(listener);
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, []);
    const pageVisibility = useMemo(() => visibility[pageKey] || {}, [visibility, pageKey]);
    const isVisible = useCallback(
        (widgetId: string): boolean => {
            if (widgetId in pageVisibility) return pageVisibility[widgetId];
            const def = widgets.find((w) => w.id === widgetId);
            return def?.defaultVisible !== false;
        },
        [pageVisibility, widgets]
    );
    const setWidgetVisible = useCallback(
        (widgetId: string, visible: boolean) => {
            const next = {
                ...visibility,
                [pageKey]: { ...pageVisibility, [widgetId]: visible },
            };
            notify(next);
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => saveToBackend(next), 500);
        },
        [visibility, pageKey, pageVisibility]
    );
    const setAllVisible = useCallback(
        (visible: boolean) => {
            const pageMap: Record<string, boolean> = {};
            widgets.forEach((w) => (pageMap[w.id] = visible));
            const next = { ...visibility, [pageKey]: pageMap };
            notify(next);
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => saveToBackend(next), 500);
        },
        [visibility, pageKey, widgets]
    );
    const resetToDefaults = useCallback(() => {
        const next = { ...visibility };
        delete next[pageKey];
        notify(next);
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => saveToBackend(next), 500);
    }, [visibility, pageKey]);
    return {
        isVisible,
        setWidgetVisible,
        setAllVisible,
        resetToDefaults,
        widgets,
        isLoaded,
    };
}