import { useState, useEffect, useCallback, useMemo } from "react";
import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import { useSettingsStore } from "@/stores/settingsStore";
import type { TranslationKey } from "@/locales/keys";
const SETTINGS_KEY = "widget_visibility";
export interface WidgetDefinition {
    id: string;
    label?: string;
    labelKey?: TranslationKey;
    description?: string;
    defaultVisible?: boolean; // defaults to true
}
export type WidgetVisibilityMap = Record<string, Record<string, boolean>>;
// e.g. { dashboard: { statCards: true, bankBalances: false }, statistics: { ... } }
let cachedVisibility: WidgetVisibilityMap | null = null;
let pendingLoad: Promise<void> | null = null;
let hydrated = false;
type VisibilityEdit = (base: WidgetVisibilityMap) => WidgetVisibilityMap;
let pendingEdits: VisibilityEdit[] = [];
const listeners = new Set<(v: WidgetVisibilityMap) => void>();
function notify(v: WidgetVisibilityMap) {
    cachedVisibility = v;
    listeners.forEach((fn) => fn(v));
}
async function loadFromBackend(): Promise<void> {
    if (pendingLoad) return pendingLoad;
    pendingLoad = (async () => {
        try {
            const result = await apiClient.getSetting(SETTINGS_KEY);
            const value: unknown = result.value ?? {};
            if (
                typeof value !== "object" ||
                Array.isArray(value) ||
                Object.values(value as Record<string, unknown>).some(
                    (page) =>
                        !page ||
                        typeof page !== "object" ||
                        Array.isArray(page) ||
                        Object.values(page).some(
                            (visible) => typeof visible !== "boolean",
                        ),
                )
            ) {
                throw new Error("Invalid widget visibility setting");
            }
            // An early local edit is an operation, not a complete backend map.
            // Replay it over the read snapshot to retain untouched pages/widgets.
            const edits = pendingEdits;
            const merged = edits.reduce(
                (base, edit) => edit(base),
                value as WidgetVisibilityMap,
            );
            pendingEdits = [];
            hydrated = true;
            notify(merged);
            if (edits.length > 0) scheduleSave(merged);
        } catch (err) {
            logger.error("Failed to load widget visibility:", err);
            // Keep local defaults/edits usable, but never replace unknown saved data.
            if (pendingEdits.length > 0)
                useSettingsStore.getState()._markSettingsSaveError();
        }
    })();
    try {
        await pendingLoad;
    } finally {
        pendingLoad = null;
    }
}
function applyEdit(edit: VisibilityEdit) {
    const next = edit(cachedVisibility ?? {});
    if (!hydrated) pendingEdits.push(edit);
    notify(next);
    if (hydrated) scheduleSave(next);
    else void loadFromBackend();
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveQueue: Promise<void> = Promise.resolve();
function scheduleSave(v: WidgetVisibilityMap) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        // Module-owned debounce survives page unmount. Serialize whole-setting
        // writes so a slower old request cannot overwrite a newer page's edits.
        saveQueue = saveQueue
            .then(() => apiClient.saveSetting(SETTINGS_KEY, v))
            .then(() => undefined)
            .catch((err: unknown) => {
                logger.error("Failed to save widget visibility:", err);
                useSettingsStore.getState()._markSettingsSaveError();
            });
    }, 500);
}
/**
 * Hook to manage widget visibility for a specific page.
 * Widgets are visible by default unless explicitly hidden.
 */
export function useWidgetVisibility(
    pageKey: string,
    widgets: WidgetDefinition[],
) {
    const [visibility, setVisibility] = useState<WidgetVisibilityMap>(
        cachedVisibility ?? {},
    );
    const [isLoaded, setIsLoaded] = useState(hydrated);
    useEffect(() => {
        const listener = (v: WidgetVisibilityMap) => {
            setVisibility(v);
            setIsLoaded(hydrated);
        };
        listeners.add(listener);
        if (!hydrated) void loadFromBackend();
        return () => {
            listeners.delete(listener);
        };
    }, []);
    const pageVisibility = useMemo(
        () => visibility[pageKey] ?? {},
        [visibility, pageKey],
    );
    const isVisible = useCallback(
        (widgetId: string): boolean => {
            const stored = pageVisibility[widgetId];
            if (stored !== undefined) return stored;
            const def = widgets.find((w) => w.id === widgetId);
            return def?.defaultVisible !== false;
        },
        [pageVisibility, widgets],
    );
    const setWidgetVisible = useCallback(
        (widgetId: string, visible: boolean) => {
            applyEdit((base) => ({
                ...base,
                [pageKey]: { ...(base[pageKey] ?? {}), [widgetId]: visible },
            }));
        },
        [pageKey],
    );
    const setAllVisible = useCallback(
        (visible: boolean) => {
            const pageMap: Record<string, boolean> = {};
            widgets.forEach((w) => (pageMap[w.id] = visible));
            applyEdit((base) => ({ ...base, [pageKey]: pageMap }));
        },
        [pageKey, widgets],
    );
    const resetToDefaults = useCallback(() => {
        applyEdit((base) => {
            const { [pageKey]: _removed, ...next } = base;
            return next;
        });
    }, [pageKey]);
    return {
        isVisible,
        setWidgetVisible,
        setAllVisible,
        resetToDefaults,
        widgets,
        isLoaded,
    };
}
